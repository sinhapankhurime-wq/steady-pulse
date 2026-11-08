// Steady Pulse — heart-rhythm coherence engine.
//
// Implements the coherence method HeartMath has published:
//   • 64-second window of inter-beat intervals, recalculated every 5 seconds;
//     highest spectral peak searched in 0.04–0.26 Hz; power integrated in a
//     ~0.030 Hz window centred on that peak.
//     [McCraty R. (2022) "Following the Rhythm of the Heart", Applied
//      Psychophysiology and Biofeedback 47:305–316, PMC9214473]
//   • Coherence ratio CR = (Peak / Power below peak) × (Peak / Power above peak),
//     Coherence score CS = ln(CR + 1), typically 0–8.
//     [Balaji S. et al. (2025) Scientific Reports, "Heart rate variability
//      biofeedback in a global study of the most common coherence frequencies…"]
//   • Displayed score range 0–16. [HeartMath HeartCloud help: "Coherence Over Time"]
//
// HeartMath's exact implementation is proprietary. The processing choices below
// are this app's own, documented choices, so scores track HeartMath's in direction
// and scale but will not match exactly:
//   – 2 Hz linear resampling and linear detrending (as in Balaji et al.'s methods);
//   – Hann taper; one DFT bin either side of the peak (≈0.030 Hz window);
//   – "peak" = the highest local maximum in 0.04–0.26 Hz, so the low edge of a
//     falling spectrum is not mistaken for a peak;
//   – "entire spectrum" = 0–0.4 Hz after detrending, so slow wandering counts as
//     power below the peak.
// Tested on synthetic rhythms (test/coherence.test.js): paced 6/min breathing ≈ 7,
// mixed rhythm ≈ 2, irregular rhythm < 1.

export const COHERENCE = Object.freeze({
  windowSec: 64,            // analysis window (published)
  updateSec: 5,             // recalculation interval (published)
  resampleHz: 2,            // even resampling rate for the IBI series (our choice)
  peakBandHz: [0.04, 0.26], // where the coherence peak is searched (published)
  spectrumBandHz: [0, 0.4], // "entire spectrum" after detrending (our choice)
  peakHalfWidthBins: 1,     // peak bin ±1 bin. Bin width = 1/64 Hz, so the outer bin
                            // centres sit 0.03125 Hz apart ≈ the published 0.030 Hz window
  scoreCap: 16,             // published display range 0–16
  minWindowSec: 30,         // provisional scores from 30 s of data (our choice)
  minCoverage: 0.8,         // ≥80 % of the window must be clean beats (our choice)
  minBeats: 15,
});

/** Zone for a score, given [lowMedium, mediumHigh] cut-offs. */
export function zoneFor(score, cuts = [1, 3]) {
  if (score == null || !Number.isFinite(score)) return null;
  if (score < cuts[0]) return 'low';
  if (score < cuts[1]) return 'medium';
  return 'high';
}

/**
 * Compute the coherence score for the window ending at tEnd.
 * @param {Array<{t:number, ibi:number, valid:boolean}>} beats  t = beat time (s), ibi in ms
 * @param {number} tEnd       end of the analysis window (s)
 * @param {object} [opts]     overrides for COHERENCE; `dataStart` (s) = when recording began
 */
export function computeCoherence(beats, tEnd, opts = {}) {
  const o = { ...COHERENCE, ...opts };
  const winStart = tEnd - o.windowSec;
  const dataStart = Math.max(winStart, o.dataStart ?? -Infinity);
  const span = tEnd - dataStart;

  const pts = [];
  for (const b of beats) {
    if (b.valid && b.t > winStart && b.t <= tEnd && Number.isFinite(b.ibi)) pts.push(b);
  }
  if (span < o.minWindowSec) return { ok: false, reason: 'warming-up', spanSec: span };
  if (pts.length < o.minBeats) return { ok: false, reason: 'not-enough-beats', spanSec: span };

  // Share of the window covered by clean beats.
  let covered = 0;
  for (const b of pts) covered += Math.min(b.ibi / 1000, b.t - dataStart);
  const coverage = Math.min(1, covered / span);
  if (coverage < o.minCoverage) return { ok: false, reason: 'low-coverage', coverage, spanSec: span };

  // 1. Resample the tachogram (IBI plotted at each beat time) to an even grid.
  const fs = o.resampleHz;
  const maxN = Math.round(o.windowSec * fs);
  const gridEnd = pts[pts.length - 1].t;
  let gridStart = Math.max(dataStart, pts[0].t);
  let N = Math.floor((gridEnd - gridStart) * fs + 1e-9) + 1;
  if (N > maxN) { N = maxN; gridStart = gridEnd - (N - 1) / fs; }
  if ((N - 1) / fs < o.minWindowSec) return { ok: false, reason: 'warming-up', spanSec: span };

  // Linear interpolation between neighbouring beats (as in Balaji et al.). Where
  // rejected beats left a gap, bridge it with a cubic Hermite curve whose end
  // slopes come from the beats on either side, so the breathing wave keeps its
  // shape instead of being cut flat (our choice).
  const slopeAt = (k, dir) => { // ms per s, from up to two beats on one side of k
    const far = pts[k + 2 * dir] ?? pts[k + dir];
    if (!far) return 0;
    const dt = far.t - pts[k].t;
    return dt ? (far.ibi - pts[k].ibi) / dt : 0;
  };
  const x = new Float64Array(N);
  let i = 0;
  for (let j = 0; j < N; j++) {
    const g = gridStart + j / fs;
    while (i < pts.length - 2 && pts[i + 1].t < g) i++;
    const a = pts[i], b = pts[i + 1];
    const h = b.t - a.t;
    const u = Math.min(1, Math.max(0, (g - a.t) / h));
    if (h > (1.5 * b.ibi) / 1000) {
      const m0 = slopeAt(i, -1) * h, m1 = slopeAt(i + 1, +1) * h;
      const u2 = u * u, u3 = u2 * u;
      x[j] = (2 * u3 - 3 * u2 + 1) * a.ibi + (u3 - 2 * u2 + u) * m0
        + (-2 * u3 + 3 * u2) * b.ibi + (u3 - u2) * m1;
    } else {
      x[j] = a.ibi + u * (b.ibi - a.ibi);
    }
  }

  // 2. Remove the linear trend.
  let sj = 0, sx = 0, sjj = 0, sjx = 0;
  for (let j = 0; j < N; j++) { sj += j; sx += x[j]; sjj += j * j; sjx += j * x[j]; }
  const den = N * sjj - sj * sj;
  const slope = den ? (N * sjx - sj * sx) / den : 0;
  const icpt = (sx - slope * sj) / N;
  let meanIbi = sx / N;
  for (let j = 0; j < N; j++) x[j] -= icpt + slope * j;

  // 3. Hann taper.
  let s2 = 0;
  for (let j = 0; j < N; j++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (N - 1));
    x[j] *= w; s2 += w * w;
  }

  // 4. One-sided power spectral density (ms²/Hz) on a 1/64 Hz grid up to 0.4 Hz.
  const df = 1 / o.windowSec;
  const K = Math.floor(o.spectrumBandHz[1] / df + 1e-9);
  const freqs = new Float64Array(K + 1);
  const psd = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) {
    const w = (2 * Math.PI * k * df) / fs;
    let re = 0, im = 0;
    for (let j = 0; j < N; j++) { re += x[j] * Math.cos(w * j); im -= x[j] * Math.sin(w * j); }
    freqs[k] = k * df;
    psd[k] = ((k === 0 ? 1 : 2) / (fs * s2)) * (re * re + im * im);
  }

  // 5. Highest peak (local maximum) in the coherence band; power in the peak
  //    window, below it and above it.
  const kLo = Math.ceil(o.peakBandHz[0] / df - 1e-9);
  const kHi = Math.floor(o.peakBandHz[1] / df + 1e-9);
  let kp = -1;
  for (let k = kLo; k <= kHi; k++) {
    const isPeak = psd[k] > psd[k - 1] && psd[k] >= psd[k + 1];
    if (isPeak && (kp < 0 || psd[k] > psd[kp])) kp = k;
  }
  if (kp < 0) { // no local maximum in the band: fall back to the band maximum
    kp = kLo;
    for (let k = kLo; k <= kHi; k++) if (psd[k] > psd[kp]) kp = k;
  }
  const h = o.peakHalfWidthBins;
  const kMin = Math.max(0, Math.ceil(o.spectrumBandHz[0] / df - 1e-9));
  let peak = 0, below = 0, above = 0;
  for (let k = kMin; k <= K; k++) {
    const p = psd[k] * df;
    if (k < kp - h) below += p; else if (k > kp + h) above += p; else peak += p;
  }
  const total = peak + below + above;
  const eps = 1e-9 * total + 1e-12;
  const ratio = (peak / Math.max(below, eps)) * (peak / Math.max(above, eps));
  const score = Math.min(o.scoreCap, Math.log(ratio + 1));

  // Peak frequency, refined by parabolic interpolation (display only).
  const y0 = psd[kp - 1], y1 = psd[kp], y2 = psd[kp + 1];
  const d2 = y0 - 2 * y1 + y2;
  const delta = d2 < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d2)) : 0;
  const peakHz = (kp + delta) * df;

  // Mean heart rate over the clean beats in the window.
  let ibiSum = 0;
  for (const b of pts) ibiSum += b.ibi;
  meanIbi = ibiSum / pts.length;

  return {
    ok: true,
    score,
    ratio,
    peakHz,
    peakBins: [kp - h, kp + h],
    power: { peak, below, above, total },
    freqs: Array.from(freqs),
    psd: Array.from(psd),
    coverage,
    spanSec: span,
    provisional: span < o.windowSec - 0.5,
    nBeats: pts.length,
    meanHr: 60000 / meanIbi,
  };
}
