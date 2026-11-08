// End-to-end test: runs the real app in headless Chromium with a synthetic
// fingertip video as the camera, and checks heart rate and coherence scores
// against the known rhythm in the video.
//   node test/e2e.cjs <videoDir> [seconds]
// Expects <videoDir>/coherent.y4m and <videoDir>/incoherent.y4m (+ .truth.json),
// made with test/make-video.js.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const videoDir = path.resolve(process.argv[2] || '.');
const RUN_SEC = Number(process.argv[3] || 95);
const shotDir = process.env.SHOT_DIR || videoDir;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function runCase({ name, video, sampler, colorScheme = 'light' }, port, coherence) {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const origin = `http://localhost:${port}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme, permissions: ['camera'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${origin}/index.html${sampler ? `?sampler=${sampler}` : ''}#practice`);
  await page.click('#start-btn');
  const t0 = Date.now();
  const timeline = [];
  while (Date.now() - t0 < RUN_SEC * 1000) {
    await page.waitForTimeout(5000);
    timeline.push(await page.evaluate(() => {
      const L = window.__steadyPulse.live;
      const s = L.session;
      return {
        status: L.status, sampler: L.cameraInfo?.sampler, torch: L.cameraInfo?.torch,
        beats: s?.beats.length ?? 0, valid: s?.beats.filter(b => b.valid).length ?? 0,
        scores: s?.scores.length ?? 0, last: s?.scores.at(-1)?.score ?? null,
        hrText: document.getElementById('hr').textContent, scoreText: document.getElementById('score').textContent,
      };
    }));
  }
  const shotLive = path.join(shotDir, `${name}-live.png`);
  await page.screenshot({ path: shotLive, fullPage: false });
  const state = await page.evaluate(() => {
    const s = window.__steadyPulse.live.session;
    return { beats: s.beats, scores: s.scores, t0: s.t0, endT: s.endT };
  });
  await page.click('#start-btn'); // stop → summary
  await page.waitForTimeout(400);
  const shotSummary = path.join(shotDir, `${name}-summary.png`);
  await page.screenshot({ path: shotSummary, fullPage: true });
  await page.click('#tab-history');
  await page.waitForTimeout(300);
  const shotHistory = path.join(shotDir, `${name}-history.png`);
  await page.screenshot({ path: shotHistory, fullPage: false });
  const saved = await page.evaluate(() => window.__steadyPulse.store.sessions.at(-1));
  await browser.close();

  // Compare with the truth used to make the video.
  const truth = JSON.parse(fs.readFileSync(`${video}.truth.json`, 'utf8'));
  const valid = state.beats.filter(b => b.valid);
  const hrApp = (60000 * valid.length) / valid.reduce((a, b) => a + b.ibi, 0);
  const durSec = (state.endT - state.t0) / 1000;
  const tb = truth.beats.filter(b => b.t > 1 && b.t < durSec);
  const hrTrue = (60000 * tb.length) / tb.reduce((a, b) => a + b.ibi, 0);
  const appScores = state.scores.filter(x => x.score != null && !x.provisional).map(x => x.score);
  const trueScores = [];
  for (let t = 70; t <= durSec; t += 5) { const r = coherence.computeCoherence(truth.beats, t, { dataStart: 0 }); if (r.ok) trueScores.push(r.score); }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    name, sampler: timeline.at(-1)?.sampler, errors,
    beats: state.beats.length, cleanPct: (100 * valid.length) / state.beats.length,
    hrApp, hrTrue, appScore: mean(appScores), trueScore: mean(trueScores), nScores: appScores.length,
    saved: !!saved, timeline, shots: [shotLive, shotSummary, shotHistory],
  };
}

(async () => {
  const coherence = await import(path.join(ROOT, 'js/coherence.js'));
  const srv = await serve();
  const port = srv.address().port;
  const cases = [
    { name: 'coherent', video: path.join(videoDir, 'coherent.y4m') },
    { name: 'incoherent', video: path.join(videoDir, 'incoherent.y4m'), colorScheme: 'dark' },
    { name: 'coherent-rvfc', video: path.join(videoDir, 'coherent.y4m'), sampler: 'rvfc' },
  ];
  const results = await Promise.all(cases.map(c => runCase(c, port, coherence)));
  srv.close();
  console.table(results.map(r => ({
    case: r.name, sampler: r.sampler, beats: r.beats, 'clean %': +r.cleanPct.toFixed(1),
    'HR app': +r.hrApp.toFixed(1), 'HR true': +r.hrTrue.toFixed(1),
    'score app': +r.appScore.toFixed(2), 'score true': +r.trueScore.toFixed(2), scores: r.nScores, saved: r.saved, errors: r.errors.length,
  })));
  for (const r of results) {
    console.log(`\n${r.name} timeline:`, r.timeline.map(x => `${x.status}/${x.beats}b/${x.scoreText}`).join('  '));
    if (r.errors.length) console.log('  page errors:', r.errors);
  }
  let failed = 0;
  const check = (ok, msg) => { if (!ok) { failed++; console.log('FAIL:', msg); } };
  for (const r of results) {
    check(r.errors.length === 0, `${r.name}: page errors`);
    check(Math.abs(r.hrApp - r.hrTrue) < 2, `${r.name}: HR ${r.hrApp.toFixed(1)} vs ${r.hrTrue.toFixed(1)}`);
    check(r.nScores >= 3, `${r.name}: needs scores after the first minute (got ${r.nScores})`);
    check(r.saved, `${r.name}: session should be saved`);
    const zone = s => (s < 1 ? 'low' : s < 3 ? 'medium' : 'high');
    check(zone(r.appScore) === zone(r.trueScore), `${r.name}: zone ${zone(r.appScore)} vs truth ${zone(r.trueScore)}`);
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\ne2e passed');
  console.log('screenshots:', results.flatMap(r => r.shots).join('\n  '));
  process.exit(failed ? 1 : 0);
})();
