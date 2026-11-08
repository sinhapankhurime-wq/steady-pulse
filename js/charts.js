// Steady Pulse — canvas charts. Colours come from the page's CSS tokens, so the
// charts follow the light/dark theme.

const MONO = '"Red Hat Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function zoneColor(zone) {
  return zone ? cssVar(`--${zone}`) : cssVar('--muted');
}

/** Size the canvas backing store to its CSS box × devicePixelRatio and clear it. */
function prep(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(canvas.clientHeight));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * Heart rhythm (beat-to-beat heart rate) over the last `windowSec`, on a grid
 * styled like ECG paper: minor lines every 2 s / 2 bpm, major every 10 s / 10 bpm.
 * points: [{t (s), ibi (ms), valid}]
 */
export function drawRhythm(canvas, points, nowSec, windowSec = 64) {
  const { ctx, w, h } = prep(canvas);
  const L = 34, R = 8, T = 8, B = 18;
  const pw = w - L - R, ph = h - T - B;
  const t0 = nowSec - windowSec;
  const pts = points.filter(p => p.t >= t0 - 2 && p.t <= nowSec + 0.5);
  const hrs = pts.filter(p => p.valid).map(p => 60000 / p.ibi);

  let lo = 55, hi = 85;
  if (hrs.length) {
    lo = Math.floor((Math.min(...hrs) - 3) / 5) * 5;
    hi = Math.ceil((Math.max(...hrs) + 3) / 5) * 5;
    if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 10) / 5) * 5; hi = lo + 20; }
  }
  const x = t => L + ((t - t0) / windowSec) * pw;
  const y = v => T + (1 - (v - lo) / (hi - lo)) * ph;

  // ECG-paper grid
  const minorBpm = hi - lo > 40 ? 5 : 2;
  ctx.lineWidth = 1;
  ctx.strokeStyle = cssVar('--grid-minor');
  ctx.beginPath();
  for (let s = Math.ceil(t0 / 2) * 2; s <= nowSec; s += 2) { const X = Math.round(x(s)) + 0.5; ctx.moveTo(X, T); ctx.lineTo(X, T + ph); }
  for (let v = Math.ceil(lo / minorBpm) * minorBpm; v <= hi; v += minorBpm) { const Y = Math.round(y(v)) + 0.5; ctx.moveTo(L, Y); ctx.lineTo(L + pw, Y); }
  ctx.stroke();
  ctx.strokeStyle = cssVar('--grid-major');
  ctx.beginPath();
  for (let s = Math.ceil(t0 / 10) * 10; s <= nowSec; s += 10) { const X = Math.round(x(s)) + 0.5; ctx.moveTo(X, T); ctx.lineTo(X, T + ph); }
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) { const Y = Math.round(y(v)) + 0.5; ctx.moveTo(L, Y); ctx.lineTo(L + pw, Y); }
  ctx.stroke();

  // axis labels
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) ctx.fillText(String(v), L - 6, y(v));
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(`${windowSec} s ago`, L, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText('now', L + pw, h - 4);

  if (!hrs.length) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = `12px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Your heart rhythm appears here', L + pw / 2, T + ph / 2);
    return;
  }

  // rhythm line, broken where beats were rejected
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T - 2, pw, ph + 4);
  ctx.clip();
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let pen = false;
  for (const p of pts) {
    if (!p.valid) { pen = false; continue; }
    const X = x(p.t), Y = y(60000 / p.ibi);
    if (pen) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    pen = true;
  }
  ctx.stroke();
  // latest beat
  const last = [...pts].reverse().find(p => p.valid);
  if (last) {
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath();
    ctx.arc(x(last.t), y(60000 / last.ibi), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * HRV power spectrum from a coherence result, with the coherence search band
 * (0.04–0.26 Hz) shaded and the peak window coloured by zone.
 */
export function drawSpectrum(canvas, res, zone, peakBandHz = [0.04, 0.26]) {
  const { ctx, w, h } = prep(canvas);
  const L = 10, R = 10, T = 18, B = 18;
  const pw = w - L - R, ph = h - T - B;
  const fMax = 0.4;
  const x = f => L + (f / fMax) * pw;

  // band shading + axis
  ctx.fillStyle = cssVar('--band');
  ctx.fillRect(x(peakBandHz[0]), T, x(peakBandHz[1]) - x(peakBandHz[0]), ph);
  ctx.strokeStyle = cssVar('--line');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, T + ph + 0.5);
  ctx.lineTo(L + pw, T + ph + 0.5);
  ctx.stroke();
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `10px ${MONO}`;
  ctx.textBaseline = 'alphabetic';
  for (const f of [0, 0.1, 0.2, 0.3, 0.4]) {
    ctx.textAlign = f === 0 ? 'left' : f === 0.4 ? 'right' : 'center';
    ctx.fillText(f === 0 ? '0 Hz' : f.toFixed(1), x(f), h - 4);
  }

  if (!res || !res.ok) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = `12px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Appears after 30 s of steady signal', L + pw / 2, T + ph / 2);
    return;
  }
  const { freqs, psd, peakBins } = res;
  const max = Math.max(...psd.slice(1)) || 1;
  const df = freqs[1] - freqs[0];
  const bw = Math.max(2, (df / fMax) * pw - 2);
  for (let k = 1; k < psd.length; k++) {
    const inPeak = k >= peakBins[0] && k <= peakBins[1];
    const bh = Math.max(1, (psd[k] / max) * ph);
    ctx.fillStyle = inPeak ? zoneColor(zone) : cssVar('--bar');
    ctx.fillRect(x(freqs[k]) - bw / 2, T + ph - bh, bw, bh);
  }
  // peak label
  const kp = Math.round((peakBins[0] + peakBins[1]) / 2);
  const px = Math.min(Math.max(x(res.peakHz), L + 24), L + pw - 24);
  ctx.fillStyle = cssVar('--ink');
  ctx.font = `600 11px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${res.peakHz.toFixed(2)} Hz`, px, Math.max(11, T + ph - (psd[kp] / max) * ph - 5));
}

/** Live pulse waveform (last few seconds) with detected beats marked. */
export function drawPulse(canvas, trace, marks, spanMs = 5000) {
  const { ctx, w, h } = prep(canvas);
  if (trace.length < 3) return;
  const tEnd = trace[trace.length - 1].t, tStart = tEnd - spanMs;
  const vis = trace.filter(p => p.t >= tStart);
  let lo = Infinity, hi = -Infinity;
  for (const p of vis) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.15;
  const x = t => ((t - tStart) / spanMs) * w;
  const y = v => 6 + (1 - (v - lo + pad) / (hi - lo + 2 * pad)) * (h - 12);
  ctx.strokeStyle = cssVar('--ink');
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  vis.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (const m of marks) {
    if (m.t < tStart) continue;
    ctx.fillStyle = m.valid ? cssVar('--accent') : cssVar('--low');
    ctx.fillRect(Math.round(x(m.t)) - 1, 0, 2, 7);
  }
}

/** Coherence score every 5 s across a session, over Low / Medium / High bands. */
export function drawScoreTimeline(canvas, scores, cuts, durationSec) {
  const { ctx, w, h } = prep(canvas);
  const L = 26, R = 6, T = 6, B = 16;
  const pw = w - L - R, ph = h - T - B;
  const maxScore = Math.max(cuts[1] + 2, ...scores.map(s => s[1] ?? 0));
  const top = Math.ceil(maxScore);
  const dur = Math.max(durationSec, 60);
  const x = t => L + (t / dur) * pw;
  const y = v => T + (1 - v / top) * ph;
  const bands = [['low', 0, cuts[0]], ['medium', cuts[0], cuts[1]], ['high', cuts[1], top]];
  for (const [z, a, b] of bands) {
    ctx.fillStyle = cssVar(`--${z}-soft`);
    ctx.fillRect(L, y(b), pw, y(a) - y(b));
  }
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [0, cuts[0], cuts[1], top]) ctx.fillText(String(v), L - 5, y(v));
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('0:00', L, h - 3);
  ctx.textAlign = 'right';
  const m = Math.floor(durationSec / 60), s = Math.round(durationSec % 60);
  ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, L + pw, h - 3);
  if (!scores.length) return;
  ctx.strokeStyle = cssVar('--ink');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  scores.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
  ctx.stroke();
  for (const [t, v] of scores) {
    ctx.fillStyle = zoneColor(v < cuts[0] ? 'low' : v < cuts[1] ? 'medium' : 'high');
    ctx.beginPath();
    ctx.arc(x(t), y(v), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Average coherence per session (oldest → newest), coloured by zone. */
export function drawTrend(canvas, sessions, cuts) {
  const { ctx, w, h } = prep(canvas);
  const L = 26, R = 6, T = 8, B = 16;
  const pw = w - L - R, ph = h - T - B;
  const list = sessions.slice(-24);
  const top = Math.max(cuts[1] + 2, Math.ceil(Math.max(0, ...list.map(s => s.avgScore ?? 0))));
  const y = v => T + (1 - v / top) * ph;
  ctx.strokeStyle = cssVar('--line');
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (const c of cuts) { const Y = Math.round(y(c)) + 0.5; ctx.moveTo(L, Y); ctx.lineTo(L + pw, Y); }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cssVar('--muted');
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [0, cuts[0], cuts[1], top]) ctx.fillText(String(v), L - 5, y(v));
  if (!list.length) return;
  const slot = pw / Math.max(list.length, 8);
  const bw = Math.max(4, Math.min(22, slot * 0.6));
  list.forEach((s, i) => {
    const v = s.avgScore ?? 0;
    const X = L + slot * i + (slot - bw) / 2;
    ctx.fillStyle = zoneColor(v < cuts[0] ? 'low' : v < cuts[1] ? 'medium' : 'high');
    ctx.fillRect(X, y(v), bw, Math.max(1, y(0) - y(v)));
  });
  ctx.fillStyle = cssVar('--muted');
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(`last ${list.length} session${list.length === 1 ? '' : 's'}`, L, h - 3);
}
