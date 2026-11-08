// Unit tests for the coherence engine using synthetic beat sequences.
import assert from 'node:assert/strict';
import { computeCoherence, zoneFor, COHERENCE } from '../js/coherence.js';
import { makeBeats, SCENARIOS } from './synth.js';

function scoresFor(name, seed, durationSec = 300) {
  const beats = makeBeats({ durationSec, seed, ...SCENARIOS[name] });
  const out = [];
  for (let tEnd = 64; tEnd <= durationSec - 2; tEnd += COHERENCE.updateSec) {
    const r = computeCoherence(beats, tEnd, { dataStart: 0 });
    if (r.ok) out.push(r);
  }
  return out;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const summary = {};
for (const name of Object.keys(SCENARIOS)) {
  const all = [];
  for (const seed of [1, 2, 3, 4, 5]) all.push(...scoresFor(name, seed));
  const s = all.map(r => r.score);
  summary[name] = {
    windows: s.length,
    meanScore: +mean(s).toFixed(2),
    minScore: +Math.min(...s).toFixed(2),
    maxScore: +Math.max(...s).toFixed(2),
    meanPeakHz: +mean(all.map(r => r.peakHz)).toFixed(3),
    meanHr: +mean(all.map(r => r.meanHr)).toFixed(1),
  };
}
console.table(summary);

// Ordering and scale: coherent > medium > incoherent, on HeartMath's published scale
// (0.5 basic, 1 good, 2 very good, 3+ excellent; typical 0–8, cap 16).
assert.ok(summary.coherent.meanScore > summary.medium.meanScore, 'coherent should beat medium');
assert.ok(summary.medium.meanScore > summary.incoherent.meanScore, 'medium should beat incoherent');
assert.ok(summary.coherent.meanScore >= 3, 'paced 6/min breathing should land in the High zone (>=3)');
assert.ok(summary.incoherent.meanScore < 1, 'irregular rhythm should land in the Low zone (<1)');
assert.ok(summary.coherent.maxScore <= 16, 'score is capped at 16');
assert.ok(Math.abs(summary.coherent.meanPeakHz - 0.1) < 0.01, 'peak should sit at the 0.1 Hz breathing rate');
assert.ok(Math.abs(summary.coherent.meanHr - 66) < 3, 'mean HR should match the generator');

// Pure sine (perfect coherence) scores very high; a flat rhythm with white noise scores low
// most of the time (a 64-s window occasionally shows a chance peak, so test the distribution).
const sine = makeBeats({ durationSec: 80, hr: 60, rsaHz: 0.1, rsaMs: 100, whiteMs: 0.5, arMs: 0, seed: 9 });
const rs = computeCoherence(sine, 78, { dataStart: 0 });
assert.ok(rs.ok && rs.score > 8, `pure 0.1 Hz sine should score very high, got ${rs.score}`);
const whiteScores = [];
for (let seed = 1; seed <= 12; seed++) {
  const white = makeBeats({ durationSec: 300, hr: 60, rsaMs: 0, whiteMs: 40, arMs: 0, seed });
  for (let t = 64; t <= 295; t += 5) whiteScores.push(computeCoherence(white, t, { dataStart: 0 }).score);
}
whiteScores.sort((a, b) => a - b);
const rw = { median: whiteScores[Math.floor(whiteScores.length / 2)], highShare: whiteScores.filter(s => s >= 3).length / whiteScores.length };
assert.ok(rw.median < 1, `white-noise rhythm median should be Low, got ${rw.median}`);
assert.ok(rw.highShare < 0.1, `white-noise rhythm should rarely reach High, got ${rw.highShare}`);

// Warm-up and coverage rules.
const beats = makeBeats({ durationSec: 120, seed: 3, ...SCENARIOS.coherent });
assert.equal(computeCoherence(beats, 20, { dataStart: 0 }).reason, 'warming-up');
const provisional = computeCoherence(beats, 40, { dataStart: 0 });
assert.ok(provisional.ok && provisional.provisional, 'scores from 30 s are flagged provisional');
const holed = beats.map(b => (b.t > 60 && b.t < 80 ? { ...b, valid: false } : b));
assert.equal(computeCoherence(holed, 100, { dataStart: 0 }).reason, 'low-coverage');
const fewHoles = beats.map((b, i) => (b.t > 40 && i % 15 === 0 ? { ...b, valid: false } : b));
assert.ok(computeCoherence(fewHoles, 100, { dataStart: 0 }).ok, 'occasional rejected beats are interpolated over');

// Zones with the chosen default cut-offs (<1 / 1–3 / 3+).
assert.equal(zoneFor(0.4), 'low');
assert.equal(zoneFor(1), 'medium');
assert.equal(zoneFor(2.99), 'medium');
assert.equal(zoneFor(3), 'high');
assert.equal(zoneFor(null), null);

console.log(`pure sine score ${rs.score.toFixed(2)}; white noise median ${rw.median.toFixed(2)}, High-zone share ${(rw.highShare * 100).toFixed(1)}%`);
console.log('coherence tests passed');
