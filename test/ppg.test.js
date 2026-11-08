// Unit tests for the camera beat detector, using simulated fingertip-camera frames
// (30 fps with timing jitter, dropped frames, sensor noise and breathing baseline).
import assert from 'node:assert/strict';
import { PulseDetector } from '../js/ppg.js';
import { computeCoherence, COHERENCE, zoneFor } from '../js/coherence.js';
import { makeBeats, simulateFrames, SCENARIOS, someArtifacts } from './synth.js';

const T0 = 1000; // simulateFrames t0Ms
const zoneIdx = s => ({ low: 0, medium: 1, high: 2 })[zoneFor(s)];

function run(rhythm, seed, frameOpts = {}, durationSec = 180) {
  const truth = makeBeats({ durationSec, seed, ...rhythm });
  const frames = simulateFrames({ beats: truth, durationSec, seed: seed + 100, respHz: rhythm.rsaHz, ...frameOpts });
  const detected = [];
  const det = new PulseDetector({ onBeat: b => detected.push(b) });
  for (const f of frames) det.pushFrame(f.t, f.r, f.g, f.b);

  // Align: detected beats sit at the steepest upstroke, a fixed delay after pulse onset.
  const trueMs = truth.map(b => T0 + b.t * 1000);
  const nearestIdx = t => { let bi = 0; for (let i = 1; i < trueMs.length; i++) if (Math.abs(trueMs[i] - t) < Math.abs(trueMs[bi] - t)) bi = i; return bi; };
  const offsets = detected.map(b => b.t - trueMs[nearestIdx(b.t)]).sort((a, b) => a - b);
  const offset = offsets[Math.floor(offsets.length / 2)];

  // Match each detected beat to a true beat within ±80 ms of the expected position.
  const matched = new Map();
  for (const b of detected) {
    const i = nearestIdx(b.t - offset);
    if (Math.abs(b.t - offset - trueMs[i]) <= 80) matched.set(i, b);
  }
  const startMs = T0 + 4000; // after finger debounce + threshold learning
  const analysable = trueMs.filter(t => t > startMs).length;
  const sensitivity = [...matched.keys()].filter(i => trueMs[i] > startMs).length / analysable;
  const falsePos = detected.length - matched.size;

  // Interval accuracy for clean intervals between consecutive matched true beats.
  const errs = [];
  for (const [i, b] of matched) if (b.valid && matched.has(i - 1)) errs.push(b.ibi - truth[i].ibi);
  const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / Math.max(1, errs.length));
  const clean = detected.filter(b => b.valid);
  const meanHr = 60000 / (clean.reduce((s, b) => s + b.ibi, 0) / clean.length);
  const trueHr = 60000 / (truth.reduce((s, b) => s + b.ibi, 0) / truth.length);

  // Coherence from detected beats vs from the true beats.
  const detBeats = detected.map(b => ({ t: (b.t - T0) / 1000, ibi: b.ibi, valid: b.valid }));
  const pairs = [];
  let windows = 0;
  for (let tEnd = 70; tEnd <= durationSec - 2; tEnd += COHERENCE.updateSec) {
    windows++;
    const a = computeCoherence(truth, tEnd, { dataStart: 0 });
    const c = computeCoherence(detBeats, tEnd, { dataStart: 2 });
    if (a.ok && c.ok) pairs.push([a.score, c.score]);
  }
  const mean = i => pairs.reduce((s, p) => s + p[i], 0) / pairs.length;
  return {
    sensitivity, falsePos, rmse, clean: clean.length / analysable, meanHr, trueHr,
    scored: pairs.length / windows, meanTrue: mean(0), meanCam: mean(1),
    falseHigh: pairs.filter(([a, c]) => zoneIdx(c) > zoneIdx(a)).length,
    pairs,
  };
}

const table = [];
process.on("exit", () => console.table(table));
const show = (label, r) => table.push({
  case: label,
  'beats found %': +(r.sensitivity * 100).toFixed(1),
  'false beats': r.falsePos,
  'IBI RMSE ms': +r.rmse.toFixed(1),
  'HR cam/true': `${r.meanHr.toFixed(1)}/${r.trueHr.toFixed(1)}`,
  'windows scored %': +(r.scored * 100).toFixed(0),
  'score true': r.pairs.length ? +r.meanTrue.toFixed(2) : '—',
  'score cam': r.pairs.length ? +r.meanCam.toFixed(2) : '—',
});

// 1. Standard captures: coherent / medium / incoherent rhythms.
for (const name of Object.keys(SCENARIOS)) {
  for (const seed of [1, 2, 3]) {
    const r = run(SCENARIOS[name], seed);
    show(`${name} #${seed}`, r);
    assert.ok(r.sensitivity > 0.97, `${name}/${seed}: should find >97% of beats (got ${r.sensitivity})`);
    assert.ok(r.falsePos <= 3, `${name}/${seed}: at most 3 false beats (got ${r.falsePos})`);
    assert.ok(r.rmse < 14, `${name}/${seed}: interval error should be <14 ms RMS (got ${r.rmse})`);
    assert.ok(r.scored > 0.95, `${name}/${seed}: nearly every window should be scored (got ${r.scored})`);
    assert.equal(zoneFor(r.meanCam), zoneFor(r.meanTrue), `${name}/${seed}: camera score zone should match truth`);
    assert.ok(Math.abs(r.meanCam - r.meanTrue) < 1, `${name}/${seed}: camera score within 1 point of truth`);
  }
}

// 2. Heart rates from 45 to 130 bpm.
const rates = {
  45: { hr: 45, rsaHz: 0.1, rsaMs: 60, whiteMs: 15, arMs: 30 },
  60: { hr: 60, rsaHz: 0.1, rsaMs: 60, whiteMs: 12, arMs: 20 },
  90: { hr: 90, rsaHz: 0.25, rsaMs: 15, whiteMs: 10, arMs: 20 },
  110: { hr: 110, rsaHz: 0.3, rsaMs: 10, whiteMs: 8, arMs: 15 },
  130: { hr: 130, rsaHz: 0.3, rsaMs: 6, whiteMs: 6, arMs: 10 },
};
for (const [hr, rhythm] of Object.entries(rates)) {
  const r = run(rhythm, 2, {}, 150);
  show(`${hr} bpm`, r);
  assert.ok(r.clean > 0.9, `${hr} bpm: >90% clean beats (got ${r.clean})`);
  assert.ok(Math.abs(r.meanHr - r.trueHr) < 1.5, `${hr} bpm: HR within 1.5 bpm (got ${r.meanHr} vs ${r.trueHr})`);
}

// 3. Noisier capture (shallower pulse, more sensor noise): still the right zone.
for (const seed of [1, 2]) {
  const r = run(SCENARIOS.coherent, seed, { depth: 0.008, noise: 0.35 });
  show(`coherent noisy #${seed}`, r);
  assert.ok(r.scored > 0.9, `noisy/${seed}: should still score (got ${r.scored})`);
  assert.equal(zoneFor(r.meanCam), zoneFor(r.meanTrue), `noisy/${seed}: zone should match truth`);
}

// 4. Finger-pressure shifts and shaking: artifacts are rejected, scores stay honest.
for (const name of Object.keys(SCENARIOS)) {
  const r = run(SCENARIOS[name], 4, { artifacts: someArtifacts(180, 5) });
  show(`${name} + artifacts`, r);
  assert.ok(r.scored > 0.8, `${name}+artifacts: most windows scored (got ${r.scored})`);
  assert.ok(Math.abs(r.meanCam - r.meanTrue) < 1.5, `${name}+artifacts: score within 1.5 of truth`);
}

// 5. Very weak signal: may produce few or no scores, but never a falsely higher zone.
for (const seed of [1, 2]) {
  const r = run(SCENARIOS.coherent, seed, { depth: 0.008, noise: 0.6, jitterMs: 4, dropRate: 0.04 });
  show(`coherent very weak #${seed}`, r);
  assert.equal(r.falseHigh, 0, `very weak/${seed}: no window may score a higher zone than the truth`);
}
for (const seed of [1, 2]) {
  const r = run(SCENARIOS.incoherent, seed, { depth: 0.008, noise: 0.6, jitterMs: 4, dropRate: 0.04 });
  show(`incoherent very weak #${seed}`, r);
  assert.ok(r.falseHigh <= r.pairs.length * 0.1, `very weak incoherent/${seed}: rare false higher zones (got ${r.falseHigh}/${r.pairs.length})`);
}



// 6. Finger detection: frames that are not red (no finger) produce no beats.
const statuses = [];
const det = new PulseDetector({ onStatus: s => statuses.push(s) });
for (let i = 0; i < 300; i++) det.pushFrame(i * 33.3, 90, 95, 100);
assert.equal(det.status, 'no-finger');
assert.equal(statuses.length, 0);

// 7. Saturated red switches to the green channel instead of reading a flat signal.
const truth = makeBeats({ durationSec: 40, seed: 5, ...SCENARIOS.coherent });
const frames = simulateFrames({ beats: truth, durationSec: 40, dc: 400, seed: 9 });
const sat = new PulseDetector();
let beats = 0;
sat.onBeat = b => { if (b.valid) beats++; };
for (const f of frames) sat.pushFrame(f.t, Math.min(255, f.r), f.g, f.b);
assert.equal(sat.channel, 'g', 'should switch to green when red is saturated');
assert.ok(beats > 30, `should still find beats on the green channel (got ${beats})`);

console.log('ppg tests passed');
