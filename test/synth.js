// Synthetic heartbeat and fingertip-camera signals for testing Steady Pulse.
// Everything is seeded, so test runs are reproducible.

export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () { // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Beat sequence: IBI = 60000/hr + RSA sine + AR(1) wander + white noise.
 * Returns [{t (s), ibi (ms), valid:true}], t = time of the beat that ends the interval.
 */
export function makeBeats({ durationSec, hr = 66, rsaHz = 0.1, rsaMs = 0, whiteMs = 10,
  arMs = 0, arRho = 0.95, seed = 1, startSec = 0 }) {
  const R = rng(seed);
  const base = 60000 / hr;
  const beats = [];
  let t = startSec, ar = 0;
  while (t < startSec + durationSec) {
    ar = arRho * ar + Math.sqrt(1 - arRho * arRho) * arMs * gauss(R);
    const ibi = base + rsaMs * Math.sin(2 * Math.PI * rsaHz * t) + ar + whiteMs * gauss(R);
    t += ibi / 1000;
    beats.push({ t, ibi, valid: true });
  }
  return beats;
}

export const SCENARIOS = {
  // Slow paced breathing at 6/min with strong respiratory sinus arrhythmia.
  coherent: { hr: 66, rsaHz: 0.1, rsaMs: 80, whiteMs: 12, arMs: 15, arRho: 0.95 },
  // Some 0.1 Hz rhythm, but mixed with irregular wander.
  medium: { hr: 70, rsaHz: 0.1, rsaMs: 30, whiteMs: 15, arMs: 35, arRho: 0.95 },
  // Fast shallow breathing and irregular variability.
  incoherent: { hr: 76, rsaHz: 0.27, rsaMs: 15, whiteMs: 20, arMs: 45, arRho: 0.9 },
};

/** Blood-volume pulse shape, tau = seconds after pulse onset. */
export function pulseShape(tau) {
  if (tau < 0 || tau > 1.4) return 0;
  const g = (m, s) => Math.exp(-0.5 * ((tau - m) / s) ** 2);
  return g(0.2, 0.065) + 0.45 * g(0.45, 0.11); // systolic wave + reflected (dicrotic) wave
}

/** Blood volume at time t (s) given pulse onsets (beat times). */
export function bloodVolume(t, onsets, hint = { i: 0 }) {
  while (hint.i < onsets.length && onsets[hint.i] < t - 1.4) hint.i++;
  let v = 0;
  for (let k = hint.i; k < onsets.length && onsets[k] <= t; k++) v += pulseShape(t - onsets[k]);
  return v;
}

/**
 * Simulated per-frame camera colour means for a fingertip over a lit camera.
 * Returns [{t (ms), r, g, b}] with frame-time jitter and occasional dropped frames.
 */
export function simulateFrames({ beats, durationSec, fps = 30, jitterMs = 2, dropRate = 0.01,
  dc = 185, depth = 0.012, noise = 0.25, respHz = 0.1, respDepth = 0.004, seed = 7, t0Ms = 1000,
  artifacts = [] }) {
  const R = rng(seed);
  const onsets = beats.map(b => b.t);
  const hint = { i: 0 };
  const frames = [];
  const dt = 1000 / fps;
  for (let n = 0; n * dt < durationSec * 1000; n++) {
    if (R() < dropRate) continue;
    const tMs = n * dt + jitterMs * gauss(R);
    const ts = tMs / 1000;
    const bv = bloodVolume(ts, onsets, hint);
    let mod = (1 - depth * bv) * (1 + respDepth * Math.sin(2 * Math.PI * respHz * ts)) * (1 + 0.01 * Math.sin(2 * Math.PI * ts / 47));
    let extra = 0;
    for (const a of artifacts) {
      if (ts < a.at || ts > a.at + a.dur) continue;
      if (a.kind === 'shift') mod *= 1 + a.size * Math.sin((Math.PI * (ts - a.at)) / a.dur); // finger pressure change
      if (a.kind === 'burst') extra += a.size * gauss(R);                                     // shaking
    }
    frames.push({
      t: t0Ms + tMs,
      r: dc * mod + noise * gauss(R) + extra,
      g: 0.24 * dc * mod + noise * gauss(R) + 0.24 * extra,
      b: 0.13 * dc * mod + noise * gauss(R) + 0.13 * extra,
    });
  }
  return frames;
}

/** A sprinkling of finger-pressure shifts and shaking bursts. */
export function someArtifacts(durationSec, seed = 3) {
  const R = rng(seed);
  const out = [];
  for (let at = 20; at < durationSec - 10; at += 25 + 10 * R()) {
    out.push(R() < 0.5
      ? { kind: 'shift', at, dur: 0.6 + 0.8 * R(), size: (R() < 0.5 ? -1 : 1) * (0.03 + 0.04 * R()) }
      : { kind: 'burst', at, dur: 0.5 + R(), size: 3 + 4 * R() });
  }
  return out;
}
