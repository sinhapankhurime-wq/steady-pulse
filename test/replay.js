// Replays a Steady Pulse troubleshooting recording through the beat detector and
// coherence engine, so detector settings can be tuned on a real phone's signal.
//   node test/replay.js <recording.txt> ['{"lpHz":2}']   (optional detector overrides as JSON)
import fs from 'node:fs';
import { PulseDetector } from '../js/ppg.js';
import { computeCoherence } from '../js/coherence.js';

const [, , file, overridesArg] = process.argv;
if (!file) { console.error('usage: node test/replay.js <recording.txt> [overrides-json]'); process.exit(2); }
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const overrides = overridesArg ? JSON.parse(overridesArg) : {};
const frames = rec.frames.map(([t, r, g, b]) => [t, r / 10, g / 10, b / 10]);

export function replay(frames, opts = {}) {
  const beats = [];
  const statuses = [];
  const det = new PulseDetector({ ...opts, onBeat: b => beats.push(b), onStatus: s => statuses.push(s) });
  for (const [t, r, g, b] of frames) det.pushFrame(t, r, g, b);
  return { beats, statuses, det };
}

function stats(beats) {
  const reasons = {};
  for (const b of beats) if (!b.valid) reasons[b.reason] = (reasons[b.reason] || 0) + 1;
  const clean = beats.filter(b => b.valid);
  const hr = clean.length ? (60000 * clean.length) / clean.reduce((a, b) => a + b.ibi, 0) : null;
  return { beats: beats.length, clean: clean.length, cleanPct: beats.length ? (100 * clean.length) / beats.length : 0, hr, reasons };
}

// Signal overview
const dur = (frames.at(-1)[0] - frames[0][0]) / 1000;
const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const ch = i => frames.map(f => f[i]);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
console.log(`Recording: ${rec.version} · ${rec.created} · ${rec.userAgent}`);
console.log(`Camera: ${JSON.stringify(rec.camera)}`);
console.log(`Frames: ${frames.length} over ${dur.toFixed(1)} s = ${((frames.length - 1) / dur).toFixed(1)} fps; gap median ${pct(gaps, 0.5)} ms, p95 ${pct(gaps, 0.95)} ms, max ${Math.max(...gaps)} ms`);
for (const [name, i] of [['R', 1], ['G', 2], ['B', 3]]) {
  const v = ch(i);
  console.log(`  ${name}: mean ${mean(v).toFixed(1)}, min ${Math.min(...v).toFixed(1)}, max ${Math.max(...v).toFixed(1)}`);
}

// App's own beats vs replayed beats
const appBeats = (rec.beats || []).map(([t, ibi, clean, reason]) => ({ t, ibi, valid: !!clean, reason }));
const re = replay(frames, overrides);
console.log('\nApp (as recorded):', JSON.stringify(stats(appBeats)));
console.log(`Replay${overridesArg ? ' ' + overridesArg : ''}:`, JSON.stringify(stats(re.beats)), `channel ${re.det.channel}, status ${re.det.status}`);
console.log('Replay intervals:', re.beats.map(b => `${Math.round(b.ibi)}${b.valid ? '' : '✗' + (b.reason || '')[0]}`).join(' '));

// Coherence over the recording (provisional when shorter than 64 s)
const t0 = re.beats.length ? re.beats[0].t : 0;
const cb = re.beats.map(b => ({ t: (b.t - t0) / 1000, ibi: b.ibi, valid: b.valid }));
const endS = cb.length ? cb.at(-1).t : 0;
const res = computeCoherence(cb, endS, { dataStart: 0 });
console.log('Coherence at end:', res.ok ? `${res.score.toFixed(2)} (peak ${res.peakHz.toFixed(3)} Hz, ${res.provisional ? 'provisional' : 'full window'})` : res.reason, res.coverage != null ? `coverage ${(res.coverage * 100).toFixed(0)}%` : '');
