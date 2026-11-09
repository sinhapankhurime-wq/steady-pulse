// Steady Pulse — camera access, flash (torch) control and per-frame colour sampling.
// Browser-only module.

const SAMPLE_W = 32, SAMPLE_H = 24; // frames are averaged at this size

export class CameraError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function explain(err) {
  const name = err && err.name;
  if (!window.isSecureContext) return new CameraError('insecure', 'The camera only works when this page is opened over HTTPS.');
  if (!navigator.mediaDevices?.getUserMedia) return new CameraError('unsupported', 'This browser cannot use the camera. Try Chrome on Android.');
  if (name === 'NotAllowedError' || name === 'SecurityError') return new CameraError('denied', 'Camera access is blocked. Allow the camera for this site in Chrome’s site settings, then try again.');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new CameraError('missing', 'No suitable camera was found on this device.');
  if (name === 'NotReadableError' || name === 'AbortError') return new CameraError('busy', 'The camera is in use by another app. Close it and try again.');
  return new CameraError('unknown', `The camera could not start (${name || 'unknown error'}).`);
}

function stopStream(stream) {
  for (const t of stream?.getTracks?.() ?? []) t.stop();
}

function hasTorch(track) {
  try { return !!track.getCapabilities?.().torch; } catch { return false; }
}

async function open(videoConstraints) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 }, ...videoConstraints },
  });
}

/** Rear camera; if it has no torch, look for another camera that does. */
async function openBest(deviceId) {
  if (deviceId) return open({ deviceId: { exact: deviceId } });
  const stream = await open({ facingMode: { ideal: 'environment' } });
  const track = stream.getVideoTracks()[0];
  if (hasTorch(track)) return stream;
  // Some phones only expose the torch on one of several rear cameras.
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch { /* ignore */ }
  const current = track.getSettings?.().deviceId;
  const others = devices
    .filter(d => d.deviceId && d.deviceId !== current && !/front|user|face/i.test(d.label))
    .slice(0, 4);
  if (!others.length) return stream;
  stopStream(stream); // Android may refuse to open two cameras at once
  for (const d of others) {
    let s;
    try { s = await open({ deviceId: { exact: d.deviceId } }); } catch { continue; }
    if (hasTorch(s.getVideoTracks()[0])) return s;
    stopStream(s);
  }
  return open({ facingMode: { ideal: 'environment' } }); // no torch anywhere: back to the default
}

export async function listCameras() {
  try {
    return (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'videoinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch { return []; }
}

/**
 * Starts the camera and calls onFrame(tMs, r, g, b) for every frame with the
 * mean colour of the image centre.
 */
export class FingerCamera {
  constructor(video, onFrame) {
    this.video = video;
    this.onFrame = onFrame;
    this.stream = null;
    this.track = null;
    this.torch = false;
    this.running = false;
    this.mode = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SAMPLE_W;
    this.canvas.height = SAMPLE_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this._clockOffset = null;
    this._lastT = -Infinity;
  }

  async start({ deviceId = null, useTorch = true, sampler = null } = {}) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw explain(null);
    try {
      this.stream = await openBest(deviceId);
    } catch (err) {
      throw explain(err);
    }
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    try { await this.video.play(); } catch { /* autoplay of a muted stream normally succeeds */ }
    this.running = true;
    this.torch = useTorch ? await this.setTorch(true) : false;
    this._startSampling(sampler);
    return {
      torch: this.torch,
      torchAvailable: hasTorch(this.track),
      label: this.track.label,
      deviceId: this.track.getSettings?.().deviceId ?? null,
      sampler: this.mode,
    };
  }

  /** Camera details for the diagnostics panel (no identifiers). */
  describe() {
    if (!this.track) return null;
    let s = {};
    try { s = this.track.getSettings?.() ?? {}; } catch { /* ignore */ }
    const v = this.video;
    return {
      label: this.track.label,
      width: s.width ?? v.videoWidth ?? null,
      height: s.height ?? v.videoHeight ?? null,
      frameRate: s.frameRate ?? null,
      facingMode: s.facingMode ?? null,
      torch: this.torch,
      torchAvailable: hasTorch(this.track),
      sampler: this.mode,
    };
  }

  async setTorch(on) {
    if (!this.track || !hasTorch(this.track)) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return !!on;
    } catch { return false; }
  }

  stop() {
    this.running = false;
    if (this._reader) { this._reader.cancel().catch(() => {}); this._reader = null; }
    if (this._procTrack) { this._procTrack.stop(); this._procTrack = null; }
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.track && this.torch) this.track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    stopStream(this.stream);
    this.video.srcObject = null;
    this.stream = null;
    this.track = null;
    this.torch = false;
  }

  /** Mean RGB of the centre half of an image source drawn at SAMPLE_W×SAMPLE_H. */
  _measure(source, w, h) {
    if (!w || !h) return null;
    this.ctx.drawImage(source, w * 0.25, h * 0.25, w * 0.5, h * 0.5, 0, 0, SAMPLE_W, SAMPLE_H);
    const px = this.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    return [r / n, g / n, b / n];
  }

  /** Map a source clock (ms) onto performance.now(); keep times increasing. */
  _emit(tSource, rgb) {
    if (!rgb) return;
    if (this._clockOffset == null) this._clockOffset = performance.now() - tSource;
    const t = tSource + this._clockOffset;
    if (t <= this._lastT) return;
    this._lastT = t;
    this.onFrame(t, rgb[0], rgb[1], rgb[2]);
  }

  _startSampling(forced) {
    this._clockOffset = null;
    this._lastT = -Infinity;
    const canProcessor = typeof window.MediaStreamTrackProcessor === 'function';
    const canRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const mode = forced || (canProcessor ? 'processor' : canRvfc ? 'rvfc' : 'raf');
    this.mode = mode;
    if (mode === 'processor') return this._sampleWithProcessor();
    if (mode === 'rvfc') return this._sampleWithRvfc();
    return this._sampleWithRaf();
  }

  // Preferred (Chrome): frames arrive with their capture timestamps.
  async _sampleWithProcessor() {
    this._procTrack = this.track.clone();
    const proc = new window.MediaStreamTrackProcessor({ track: this._procTrack });
    const reader = proc.readable.getReader();
    this._reader = reader;
    try {
      while (this.running) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        try {
          this._emit(frame.timestamp / 1000, this._measure(frame, frame.displayWidth, frame.displayHeight));
        } finally {
          frame.close();
        }
      }
    } catch { /* reader cancelled on stop */ }
  }

  _sampleWithRvfc() {
    const v = this.video;
    let clock = null; // pick one timestamp source on the first frame and keep it
    const step = (now, md) => {
      if (!this.running) return;
      if (clock == null) {
        clock = md && md.captureTime > 0 ? 'capture' : md && md.mediaTime > 0 ? 'media' : 'now';
      }
      const t = clock === 'capture' ? md?.captureTime : clock === 'media' ? md?.mediaTime * 1000 : now;
      if (Number.isFinite(t)) this._emit(t, this._measure(v, v.videoWidth, v.videoHeight));
      v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
  }

  _sampleWithRaf() {
    const v = this.video;
    let lastTime = -1;
    const step = () => {
      if (!this.running) return;
      if (v.readyState >= 2 && v.currentTime !== lastTime) {
        lastTime = v.currentTime;
        this._emit(performance.now(), this._measure(v, v.videoWidth, v.videoHeight));
      }
      this._rafId = requestAnimationFrame(step);
    };
    this._rafId = requestAnimationFrame(step);
  }
}
