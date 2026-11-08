// Steady Pulse — fingertip camera photoplethysmography (PPG) beat detector.
//
// Input: one colour sample per camera frame (mean red/green/blue of the image
// centre) with the frame's timestamp. With a fingertip pressed over a lit camera,
// each heartbeat briefly raises blood volume in the finger, which absorbs more
// light, so image brightness dips once per beat.
//
// Pipeline (all choices are this app's own, tuned on simulated captures in
// test/ppg.test.js — 45–130 bpm, sensor noise, frame jitter, dropped frames,
// finger-pressure shifts and shaking):
//   1. Finger detection: the image must be strongly red.
//   2. Even resampling of the (jittery) frame times to 30 Hz.
//   3. Band-pass: first-order high-pass at 0.5 Hz (no overshoot, so slow
//      heartbeats don't get a false second upstroke) and a second-order
//      Butterworth low-pass at 1.6 Hz; inverted so each beat is an upward pulse.
//   4. Detection: steepest point of each upstroke (maximum of the derivative),
//      refined to sub-frame timing with a parabola, using an adaptive
//      Pan–Tompkins-style threshold, a refractory period and search-back for
//      missed beats. Nothing is detected while the signal is disturbed.
//   5. Shape check: each beat is correlated with a running-average pulse
//      template learned from clean beats; beats that don't look like a pulse
//      are flagged.
//   6. Interval checks: a beat-to-beat interval is "clean" only if it is
//      plausible and close to the previous clean intervals. Rejected intervals
//      are kept but marked invalid; the coherence engine interpolates over them.

export const PPG = Object.freeze({
  fs: 30,
  hpHz: 0.5,
  lpHz: 1.6,
  derivSpan: 2,         // derivative over ±derivSpan samples
  peakHalfWinSec: 0.3,  // an upstroke must be the steepest within ±0.3 s
  thrFactor: 0.5,       // threshold = noise + thrFactor × (signal − noise)
  refractoryFrac: 0.6,  // no new beat within this share of the typical interval
  learnSec: 2.0,        // threshold learning period after the finger settles
  tplPreSec: 0.15,      // template span before the upstroke marker
  tplPostSec: 0.3,      // and after it (fits inside one beat even at 130 bpm)
  tplMaxLagSec: 0.1,    // search ±0.1 s when comparing a beat to the template
  tplMinBeats: 6,       // clean beats needed before the template is used
  tplAlpha: 0.1,        // template update rate
  minShapeCorr: 0.75,   // below this correlation a beat is treated as an artifact
                        // (clean beats: median ≈0.96, 5th percentile ≈0.8 at 130 bpm)
  minIbiMs: 300,        // 200 bpm
  maxIbiMs: 1700,       // ~35 bpm
  succTol: 0.22,        // max change vs the previous clean interval
  medTol: 0.40,         // max change vs the median of recent clean intervals
  fingerMinRed: 40,
  fingerRatio: 1.3,
  fingerOnMs: 600,
  fingerOffMs: 300,
  saturation: 248,
  gapBlankMs: 250,      // a frame gap this long disturbs nearby beats
  gapResetMs: 1500,     // a frame gap this long restarts the signal chain
  blankMs: 1200,        // how long the signal counts as disturbed
  motionJump: 0.03,     // >3 % brightness jump between samples = movement
  relearnMs: 3000,      // re-learn the threshold after this long without beats
  traceSec: 6,
});

/** Second-order Butterworth low-pass (RBJ biquad). */
class Lowpass2 {
  constructor(fc, fs) {
    const w0 = (2 * Math.PI * fc) / fs, cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
    this.z1 = 0; this.z2 = 0;
  }
  /** Start in steady state for a constant input, so the first samples don't ring. */
  prime(x0) {
    this.z1 = x0 - this.b0 * x0;
    this.z2 = this.b2 * x0 - this.a2 * x0;
  }
  step(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** First-order high-pass (no overshoot). */
class Highpass1 {
  constructor(fc, fs) {
    const rc = 1 / (2 * Math.PI * fc), dt = 1 / fs;
    this.a = rc / (rc + dt);
    this.y = 0; this.x = 0;
  }
  prime(x0) { this.y = 0; this.x = x0; }
  step(x) {
    this.y = this.a * (this.y + x - this.x);
    this.x = x;
    return this.y;
  }
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class PulseDetector {
  /**
   * @param {object} [opts] overrides for PPG, plus callbacks:
   *   onBeat({t, ibi, valid, reason, shape})   t and ibi in ms
   *   onStatus(status)  'no-finger' | 'settling' | 'good' | 'noisy'
   */
  constructor(opts = {}) {
    const { onBeat, onStatus, ...rest } = opts;
    this.o = { ...PPG, ...rest };
    this.onBeat = onBeat || (() => {});
    this.onStatus = onStatus || (() => {});
    this.trace = [];      // [{t, v}] filtered pulse wave on the 30 Hz grid
    this.marks = [];      // [{t, valid}] detected beats, for display
    this.recent = [];     // [{t, valid}] for the signal-quality estimate
    this.history = [];    // recent clean intervals (ms)
    this.finger = false;
    this.status = 'no-finger';
    this.channel = 'r';
    this.rEma = null;
    this._seenAt = null;
    this._lostAt = null;
    this._restart(null);
  }

  _setStatus(s) {
    if (s !== this.status) { this.status = s; this.onStatus(s); }
  }

  _restart(t) {
    const o = this.o;
    this.hp = new Highpass1(o.hpHz, o.fs);
    this.lp = new Lowpass2(o.lpHz, o.fs);
    this.primed = false;
    this.lastFrameT = null; this.lastFrameV = null; this.nextGridT = null;
    this.trace = [];
    this.sHist = [];
    this.dWin = [];
    this.dcEma = null; this.xPrev = null;
    this.sigStart = t;
    this.learnMax = 0;
    this.spk = null; this.npk = null; this.thr = Infinity;
    this.cands = [];
    this.pending = [];       // detected upstrokes awaiting the shape check
    this.lastDetT = null;    // last detection
    this.blankUntil = -Infinity;
    this.lastBeatT = null;   // last beat that entered the interval checks
    this.lastGood = false;   // was that beat trustworthy (undisturbed, pulse-shaped, on time)?
    this.lastRaw = null;
    this.invalidRun = 0;
    this.tpl = null;         // running-average pulse template (unit RMS)
    this.tplN = 0;
  }

  /** Feed one camera frame. t in ms; r, g, b = mean channel values (0–255). */
  pushFrame(t, r, g, b) {
    const o = this.o;
    const fingerNow = r >= o.fingerMinRed && r >= o.fingerRatio * g && r >= o.fingerRatio * b;
    if (fingerNow) { this._lostAt = null; if (this._seenAt == null) this._seenAt = t; }
    else { this._seenAt = null; if (this._lostAt == null) this._lostAt = t; }

    if (!this.finger) {
      if (!(fingerNow && t - this._seenAt >= o.fingerOnMs)) return;
      this.finger = true;
      this.rEma = r;
      this.channel = r > o.saturation ? 'g' : 'r';
      this._restart(t);
      this._setStatus('settling');
    } else if (!fingerNow) {
      this.blankUntil = Math.max(this.blankUntil, t + o.blankMs);
      if (t - this._lostAt >= o.fingerOffMs) {
        this.finger = false;
        this.rEma = null;
        this._restart(null);
        this.recent = [];
        this._setStatus('no-finger');
        return;
      }
    }

    // Red saturated (too much light): switch to the green channel.
    this.rEma += 0.1 * (r - this.rEma);
    if (this.channel === 'r' && this.rEma > o.saturation) {
      this.channel = 'g';
      this._restart(t);
      this._setStatus('settling');
    }

    const v = this.channel === 'r' ? r : g;
    if (this.lastFrameT != null) {
      const gap = t - this.lastFrameT;
      if (gap <= 0) return; // duplicate or out-of-order frame
      if (gap > o.gapResetMs) this._restart(t);
      else if (gap > o.gapBlankMs) this.blankUntil = Math.max(this.blankUntil, t + o.blankMs);
    }
    if (this.lastFrameT == null) {
      this.lastFrameT = t; this.lastFrameV = v; this.nextGridT = t;
      if (this.sigStart == null) this.sigStart = t;
      return;
    }
    const t0 = this.lastFrameT, v0 = this.lastFrameV, step = 1000 / o.fs;
    while (this.nextGridT <= t) {
      const u = (this.nextGridT - t0) / (t - t0);
      this._sample(this.nextGridT, v0 + (v - v0) * u);
      this.nextGridT += step;
    }
    this.lastFrameT = t; this.lastFrameV = v;
  }

  _sample(t, x) {
    const o = this.o;
    this.dcEma = this.dcEma == null ? x : this.dcEma + (x - this.dcEma) / o.fs;
    if (this.xPrev != null && Math.abs(x - this.xPrev) > o.motionJump * this.dcEma) {
      this.blankUntil = Math.max(this.blankUntil, t + o.blankMs);
    }
    this.xPrev = x;
    if (!this.primed) { this.hp.prime(x); this.lp.prime(0); this.primed = true; this.sigStart = t; }
    const s = -this.lp.step(this.hp.step(x));

    this.trace.push({ t, v: s });
    const keepFrom = t - o.traceSec * 1000;
    while (this.trace.length && this.trace[0].t < keepFrom) this.trace.shift();
    while (this.marks.length && this.marks[0].t < keepFrom) this.marks.shift();

    // Derivative over ±span samples, assigned to the middle sample.
    const span = o.derivSpan;
    this.sHist.push({ t, v: s });
    if (this.sHist.length > 2 * span + 1) this.sHist.shift();
    if (this.sHist.length === 2 * span + 1) {
      const d = ((this.sHist[2 * span].v - this.sHist[0].v) * o.fs) / (2 * span);
      this._derivative(this.sHist[span].t, d);
    }
    this._flushPending(t);
  }

  _derivative(t, d) {
    const o = this.o;
    const W = Math.max(2, Math.round(o.peakHalfWinSec * o.fs));
    this.dWin.push({ t, d });
    if (this.dWin.length > 2 * W + 1) this.dWin.shift();

    // Re-learn the threshold if beats have stopped (e.g. finger pressure changed).
    if (this.spk != null && this.lastDetT != null && t - this.lastDetT > o.relearnMs) {
      this.spk = null; this.learnMax = 0; this.sigStart = t; this.lastDetT = null; this.cands = [];
    }
    if (t - this.sigStart < o.learnSec * 1000) { if (d > this.learnMax) this.learnMax = d; return; }
    if (this.spk == null) {
      if (!(this.learnMax > 0)) { this.sigStart = t; return; }
      this.spk = 0.6 * this.learnMax;
      this.npk = 0.1 * this.learnMax;
      this._updThr();
    }
    if (this.dWin.length < 2 * W + 1) return;

    const c = this.dWin[W];
    if (c.d <= 0) return;
    for (let k = 0; k < this.dWin.length; k++) {
      if (k === W) continue;
      const v = this.dWin[k].d;
      if (k < W ? v >= c.d : v > c.d) return; // not a local maximum
    }
    // Ignore anything detected while the signal is disturbed (motion, frame gaps);
    // the interval spanning the disturbance is then rejected as a gap.
    if (c.t < this.blankUntil) return;
    const a = this.dWin[W - 1].d, b = c.d, e = this.dWin[W + 1].d;
    const den = a - 2 * b + e;
    const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - e)) / den)) : 0;
    this._candidate(c.t + (delta * 1000) / o.fs, b);
  }

  _updThr() { this.thr = this.npk + this.o.thrFactor * (this.spk - this.npk); }

  _refIbi() { return this.history.length >= 3 ? median(this.history.slice(-7)) : null; }

  _candidate(t, amp) {
    const o = this.o;
    const ref = this._refIbi();
    const refractory = Math.max(o.minIbiMs, ref ? o.refractoryFrac * ref : 0);
    const since = this.lastDetT == null ? Infinity : t - this.lastDetT;
    if (amp > this.thr && since >= refractory) {
      // Cap one beat's influence, so a single spike can't lift the threshold
      // above the real beats that follow it.
      this.spk = 0.125 * Math.min(amp, 1.5 * this.spk) + 0.875 * this.spk;
      this._updThr();
      this.cands = [];
      this._detected(t);
      return;
    }
    this.npk = 0.125 * Math.min(amp, this.spk) + 0.875 * this.npk;
    this._updThr();
    if (since >= refractory) this.cands.push({ t, amp });
    // Search back for a beat the threshold missed.
    if (ref && since > 1.66 * ref && this.cands.length) {
      let best = null;
      for (const cd of this.cands) if (cd.amp > 0.5 * this.thr && (!best || cd.amp > best.amp)) best = cd;
      if (best) {
        this.spk = 0.25 * best.amp + 0.75 * this.spk;
        this._updThr();
        this.cands = this.cands.filter(cd => cd.t > best.t);
        this._detected(best.t);
      }
    }
  }

  _detected(t) {
    this.lastDetT = t;
    this.pending.push(t);
  }

  /** Check pending beats' shape once the trace extends far enough past them. */
  _flushPending(now) {
    const o = this.o;
    const need = (o.tplPostSec + o.tplMaxLagSec) * 1000 + 2000 / o.fs;
    while (this.pending.length && this.pending[0] + need <= now) {
      const t = this.pending.shift();
      this._interval(t, this._shape(t));
    }
  }

  /** Trace value at an arbitrary time (linear interpolation on the 30 Hz grid). */
  _at(t) {
    const tr = this.trace;
    if (!tr.length) return null;
    const step = 1000 / this.o.fs;
    const x = (t - tr[0].t) / step;
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= tr.length) return null;
    const u = x - i;
    return tr[i].v + u * (tr[i + 1].v - tr[i].v);
  }

  /** Segment around time t on the template's sample offsets, mean-removed. */
  _segment(t) {
    const o = this.o, step = 1000 / o.fs;
    const pre = Math.round(o.tplPreSec * o.fs), post = Math.round(o.tplPostSec * o.fs);
    const seg = new Float64Array(pre + post + 1);
    let mean = 0;
    for (let k = -pre; k <= post; k++) {
      const v = this._at(t + k * step);
      if (v == null) return null;
      seg[k + pre] = v; mean += v;
    }
    mean /= seg.length;
    for (let i = 0; i < seg.length; i++) seg[i] -= mean;
    return seg;
  }

  /**
   * How pulse-like the beat at t looks: the best correlation (−1…1) between the
   * waveform around t and the learned template, within ±tplMaxLagSec. Timing
   * itself stays on the upstroke marker (aligning to the template drifted and
   * did not improve accuracy in testing).
   */
  _shape(t) {
    const o = this.o, step = 1000 / o.fs;
    if (!this.tpl || this.tplN < o.tplMinBeats) return null;
    const L = Math.round(o.tplMaxLagSec * o.fs);
    const T = this.tpl;
    let best = -1;
    for (let l = -L; l <= L; l++) {
      const seg = this._segment(t + l * step);
      if (!seg) return null;
      let st = 0, ss = 0;
      for (let i = 0; i < seg.length; i++) { st += seg[i] * T[i]; ss += seg[i] * seg[i]; }
      const rho = ss > 0 ? st / Math.sqrt(ss * T.length) : 0;
      if (rho > best) best = rho;
    }
    return best;
  }

  _learnTemplate(t) {
    const o = this.o;
    const seg = this._segment(t);
    if (!seg) return;
    let ss = 0;
    for (const v of seg) ss += v * v;
    const rms = Math.sqrt(ss / seg.length);
    if (!(rms > 0)) return;
    if (!this.tpl) { this.tpl = new Float64Array(seg.length); this.tplN = 0; }
    const a = this.tplN < o.tplMinBeats ? 1 / (this.tplN + 1) : o.tplAlpha;
    for (let i = 0; i < seg.length; i++) this.tpl[i] = (1 - a) * this.tpl[i] + a * (seg[i] / rms);
    // keep the template at unit RMS
    let ts = 0;
    for (const v of this.tpl) ts += v * v;
    const trms = Math.sqrt(ts / this.tpl.length);
    if (trms > 0) for (let i = 0; i < this.tpl.length; i++) this.tpl[i] /= trms;
    this.tplN++;
  }

  _interval(t, shape) {
    const o = this.o;
    const blanked = t < this.blankUntil;
    const badShape = shape != null && shape < o.minShapeCorr;
    // A beat is trustworthy only if it is undisturbed, pulse-shaped and arrived
    // on time. An interval is used only if the beats at BOTH ends are
    // trustworthy: one mistimed beat corrupts the interval on each side of it.
    const startGood = this.lastGood;
    if (this.lastBeatT == null) {
      this.lastBeatT = t;
      this.lastGood = !blanked && !badShape;
      this._mark(t, false);
      return;
    }
    const ibi = t - this.lastBeatT;
    this.lastBeatT = t;
    if (ibi > o.maxIbiMs) {
      this.lastGood = false;
      this._emit(t, ibi, false, 'gap', shape);
      return;
    }

    let onTime = ibi >= o.minIbiMs;
    const ref = this._refIbi();
    if (onTime && ref != null) {
      const prev = this.history[this.history.length - 1];
      if (Math.abs(ibi - ref) / ref > o.medTol) onTime = false;
      else if (Math.abs(ibi - prev) / prev > o.succTol) onTime = false;
    } else if (onTime) {
      // Not established yet: need two similar intervals in a row.
      if (this.lastRaw == null || Math.abs(ibi - this.lastRaw) / this.lastRaw > o.succTol) onTime = false;
    }
    this.lastRaw = ibi;
    const good = !blanked && !badShape && onTime;
    this.lastGood = good;
    const valid = good && startGood;
    if (valid) {
      this.history.push(ibi);
      if (this.history.length > 9) this.history.shift();
      this.invalidRun = 0;
      if (shape == null || shape >= 0.9) this._learnTemplate(t);
    } else if (++this.invalidRun >= 6) {
      this.history = []; // lost the rhythm: re-establish from scratch
      this.invalidRun = 0;
    }
    const reason = valid ? '' : blanked ? 'motion' : badShape ? 'shape' : !onTime ? 'irregular' : 'after-artifact';
    this._emit(t, ibi, valid, reason, shape);
  }

  _mark(t, valid) {
    this.marks.push({ t, valid });
    this.recent.push({ t, valid });
    while (this.recent.length && this.recent[0].t < t - 10000) this.recent.shift();
    const n = this.recent.length;
    const good = this.recent.filter(b => b.valid).length;
    if (n >= 5) this._setStatus(good / n >= 0.7 ? 'good' : 'noisy');
  }

  _emit(t, ibi, valid, reason, shape) {
    this._mark(t, valid);
    this.onBeat({ t, ibi, valid, reason, shape });
  }
}
