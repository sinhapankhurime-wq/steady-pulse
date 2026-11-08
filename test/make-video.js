// Writes a synthetic fingertip-over-flash camera video (.y4m, I420) with a known
// heart rhythm, for feeding to Chrome as a fake camera in the end-to-end test.
//   node test/make-video.js <scenario> <seconds> <out.y4m> [seed]
// Also writes <out>.truth.json with the true beat times.
import fs from 'node:fs';
import { makeBeats, bloodVolume, SCENARIOS, rng, gauss } from './synth.js';

const [, , scenario = 'coherent', secArg = '105', out = 'finger.y4m', seedArg = '1'] = process.argv;
const W = 96, H = 72, FPS = 30;
const seconds = Number(secArg), seed = Number(seedArg);
const rhythm = SCENARIOS[scenario];
if (!rhythm) throw new Error(`unknown scenario ${scenario}`);

const beats = makeBeats({ durationSec: seconds + 2, seed, ...rhythm });
const onsets = beats.map(b => b.t);
const R = rng(seed + 1000);
const hint = { i: 0 };

// BT.601 limited-range RGB → YCbCr
const ycc = (r, g, b) => [
  16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255,
  128 + (-37.797 * r - 74.203 * g + 112 * b) / 255,
  128 + (112 * r - 93.786 * g - 18.214 * b) / 255,
];
const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

const fd = fs.openSync(out, 'w');
fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
const frame = Buffer.alloc(W * H * 1.5);
const nFrames = Math.round(seconds * FPS);
for (let n = 0; n < nFrames; n++) {
  const t = n / FPS;
  const bv = bloodVolume(t, onsets, hint);
  const mod = (1 - 0.012 * bv) * (1 + 0.004 * Math.sin(2 * Math.PI * rhythm.rsaHz * t)) * (1 + 0.01 * Math.sin((2 * Math.PI * t) / 47));
  const [y, cb, cr] = ycc(200 * mod, 48 * mod, 26 * mod);
  const yn = y + 0.15 * gauss(R); // a little temporal sensor noise
  let o = 0;
  for (let i = 0; i < W * H; i++) frame[o++] = clamp(yn + (R() - 0.5) * 3); // per-pixel dither
  for (let i = 0; i < (W * H) / 4; i++) frame[o++] = clamp(cb + (R() - 0.5) * 2);
  for (let i = 0; i < (W * H) / 4; i++) frame[o++] = clamp(cr + (R() - 0.5) * 2);
  fs.writeSync(fd, 'FRAME\n');
  fs.writeSync(fd, frame);
}
fs.closeSync(fd);
fs.writeFileSync(`${out}.truth.json`, JSON.stringify({ scenario, seed, fps: FPS, beats }));
const ibis = beats.map(b => b.ibi);
console.log(`${out}: ${nFrames} frames, ${scenario}, mean HR ${(60000 / (ibis.reduce((a, b) => a + b, 0) / ibis.length)).toFixed(1)} bpm`);
