// Steady Pulse — app controller: camera → beat detector → coherence engine → UI.
import { computeCoherence, zoneFor, COHERENCE } from './coherence.js';
import { PulseDetector } from './ppg.js';
import { FingerCamera, listCameras } from './camera.js';
import { drawRhythm, drawSpectrum, drawPulse, drawScoreTimeline, drawTrend } from './charts.js';

const VERSION = '1.0.0';
const STORE_KEY = 'steadyPulse.v1';
const DEFAULTS = Object.freeze({ pacerOn: true, pacerBpm: 6, cuts: [1, 3], torch: true, cameraId: '', wakeLock: true });
const ZONE_NAME = { low: 'Low', medium: 'Medium', high: 'High' };
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const forcedSampler = ['processor', 'rvfc', 'raf'].includes(params.get('sampler')) ? params.get('sampler') : null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- storage
// Sessions and settings live only in this browser (localStorage).
function sanitizeSettings(s) {
  const out = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  out.pacerBpm = Math.min(10, Math.max(4, Number(out.pacerBpm) || DEFAULTS.pacerBpm));
  const c = Array.isArray(out.cuts) ? out.cuts.map(Number) : [];
  out.cuts = c.length === 2 && c[0] > 0 && c[1] > c[0] ? c : [...DEFAULTS.cuts];
  out.pacerOn = !!out.pacerOn; out.torch = !!out.torch; out.wakeLock = !!out.wakeLock;
  out.cameraId = typeof out.cameraId === 'string' ? out.cameraId : '';
  return out;
}
function loadStore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d && typeof d === 'object') {
      return { settings: sanitizeSettings(d.settings), sessions: Array.isArray(d.sessions) ? d.sessions.filter(x => x && x.id) : [] };
    }
  } catch { /* storage blocked or corrupt: start fresh */ }
  return { settings: sanitizeSettings(null), sessions: [] };
}
const store = loadStore();
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
  catch { showNotice('This browser is not letting the app save data, so history and settings will be lost when you close it.'); return false; }
}

// ---------------------------------------------------------------- helpers
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const fmtTime = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const fmtScore = v => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(1));
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------- live state
const live = {
  running: false,
  starting: false,
  camera: null,
  cameraInfo: null,
  detector: null,
  session: null,     // current (or last) session
  result: null,      // latest coherence result
  status: 'off',
  wakeLock: null,
  lastFrameT: null,
};
window.__steadyPulse = { live, store, VERSION }; // for debugging and automated tests

// ---------------------------------------------------------------- breathing dial
const R_MIN = 66, R_MAX = 112, RING_R = 136;
function buildRing() {
  const g = $('ring');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 12; i++) {
    const a0 = (-90 + i * 30 + 4) * (Math.PI / 180), a1 = (-90 + (i + 1) * 30 - 4) * (Math.PI / 180);
    const p = document.createElementNS(ns, 'path');
    const x0 = 150 + RING_R * Math.cos(a0), y0 = 150 + RING_R * Math.sin(a0);
    const x1 = 150 + RING_R * Math.cos(a1), y1 = 150 + RING_R * Math.sin(a1);
    p.setAttribute('d', `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${RING_R} ${RING_R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);
    p.setAttribute('class', 'seg');
    g.appendChild(p);
  }
}

let pacerEpoch = performance.now();
let lastCue = '';
let lastPulseDraw = 0;
function frameLoop(now) {
  const st = store.settings;
  const breath = $('breath'), edge = $('breath-edge');
  if (st.pacerOn) {
    const cycle = 60 / st.pacerBpm, half = cycle / 2;
    const tt = (((now - pacerEpoch) / 1000) % cycle + cycle) % cycle;
    const inhale = tt < half;
    const p = inhale ? tt / half : (tt - half) / half;
    const ease = (1 - Math.cos(Math.PI * p)) / 2;
    const frac = reducedMotion.matches ? 0.5 : inhale ? ease : 1 - ease;
    const r = (R_MIN + (R_MAX - R_MIN) * frac).toFixed(2);
    breath.setAttribute('r', r); edge.setAttribute('r', r);
    const cue = `${inhale ? 'Breathe in' : 'Breathe out'}|${Math.max(1, Math.ceil(half - (inhale ? tt : tt - half)))}`;
    if (cue !== lastCue) {
      lastCue = cue;
      const [text, count] = cue.split('|');
      $('cue-text').firstChild.nodeValue = text;
      $('cue-count').textContent = count;
    }
    $('cue-bar').style.width = `${(p * 100).toFixed(1)}%`;
  } else if (lastCue !== 'off') {
    lastCue = 'off';
    breath.setAttribute('r', (R_MIN + R_MAX) / 2); edge.setAttribute('r', (R_MIN + R_MAX) / 2);
    $('cue-text').firstChild.nodeValue = 'Pacer off';
    $('cue-count').textContent = '';
    $('cue-bar').style.width = '0';
  }
  if (live.running && live.session?.t0 != null) $('elapsed').textContent = fmtTime((live.session.endT - live.session.t0) / 1000);
  if (live.running && live.detector && currentView === 'practice' && now - lastPulseDraw > 45) {
    lastPulseDraw = now;
    drawPulse($('pulse'), live.detector.trace, live.detector.marks);
  }
  requestAnimationFrame(frameLoop);
}

// ---------------------------------------------------------------- status + notices
const STATUS = {
  off: ['Camera off', 'idle'],
  starting: ['Starting camera…', 'busy'],
  'no-finger': ['Cover the rear camera and flash with your fingertip', 'warn'],
  settling: ['Finger detected · finding your pulse', 'busy'],
  good: ['Good signal', 'good'],
  noisy: ['Unsteady signal · keep your hand still, press lightly', 'warn'],
};
function setStatus(s) {
  live.status = s;
  const [text, tone] = STATUS[s] || STATUS.off;
  $('status-text').textContent = text;
  $('status-chip').dataset.tone = tone;
  renderScore();
}
function showNotice(msg) { const n = $('notice'); n.textContent = msg; n.hidden = false; }
function hideNotice() { $('notice').hidden = true; }
function showFlash(info) {
  const chip = $('flash-chip');
  if (!info) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = info.torch ? 'Flash on' : info.torchAvailable ? 'Flash off' : 'No flash on this camera · use bright light';
}

// ---------------------------------------------------------------- session lifecycle
async function startSession(sampler = forcedSampler) {
  if (live.running || live.starting) return;
  live.starting = true;
  hideNotice();
  $('summary').hidden = true;
  $('guide').hidden = true;
  setStatus('starting');
  updateStartButton();
  live.session = {
    id: newId(), startedAt: new Date().toISOString(), t0: null, endT: null,
    beats: [], scores: [], points: 0, nextScoreAt: null,
    cuts: [...store.settings.cuts], pacerBpm: store.settings.pacerBpm,
  };
  live.result = null;
  live.lastFrameT = null;
  $('hr').innerHTML = '–<small>bpm</small>';
  $('elapsed').textContent = '0:00';
  live.detector = new PulseDetector({ onBeat, onStatus: s => { if (live.running) setStatus(s); } });
  live.camera = new FingerCamera($('preview'), onFrame);
  try {
    live.cameraInfo = await live.camera.start({ deviceId: store.settings.cameraId || null, useTorch: store.settings.torch, sampler });
  } catch (err) {
    live.starting = false;
    live.camera = null;
    setStatus('off');
    showNotice(err.message || 'The camera could not start.');
    $('guide').hidden = false;
    updateStartButton();
    return;
  }
  live.running = true;
  live.starting = false;
  showFlash(live.cameraInfo);
  setStatus('no-finger');
  if (store.settings.wakeLock) requestWakeLock();
  updateStartButton();
  renderLive();
  populateCameras();
  // Watchdog: if this browser's frame API delivers nothing, fall back to the next one.
  const usedSampler = live.cameraInfo.sampler;
  setTimeout(() => {
    if (!live.running || live.lastFrameT != null) return;
    const next = usedSampler === 'processor' ? 'rvfc' : usedSampler === 'rvfc' ? 'raf' : null;
    live.camera.stop();
    live.running = false;
    releaseWakeLock();
    if (next) startSession(next);
    else { setStatus('off'); showNotice('The camera started but sent no frames. Try closing other camera apps, then start again.'); updateStartButton(); }
  }, 3000);
}

function onFrame(t, r, g, b) {
  const s = live.session;
  if (!s || !live.detector) return;
  live.lastFrameT = t;
  live.detector.pushFrame(t, r, g, b);
  if (s.t0 == null && live.detector.finger) {
    s.t0 = t;
    s.nextScoreAt = t + COHERENCE.updateSec * 1000;
  }
  if (s.t0 != null) {
    s.endT = t;
    while (t >= s.nextScoreAt) {
      scoreTick(s.nextScoreAt);
      s.nextScoreAt += COHERENCE.updateSec * 1000;
    }
  }
}

function onBeat(b) {
  const s = live.session;
  if (!s || s.t0 == null) return;
  s.beats.push({ t: (b.t - s.t0) / 1000, ibi: b.ibi, valid: b.valid });
  renderHr();
  if (currentView === 'practice') drawRhythmNow();
}

function scoreTick(tMs) {
  const s = live.session;
  const tEnd = (tMs - s.t0) / 1000;
  const res = computeCoherence(s.beats, tEnd, { dataStart: 0 });
  if (res.ok) {
    const zone = zoneFor(res.score, store.settings.cuts);
    s.scores.push({ t: tEnd, score: res.score, zone, provisional: res.provisional });
    s.points += res.score;
    live.result = res;
  } else {
    s.scores.push({ t: tEnd, score: null, reason: res.reason });
  }
  renderScore();
  renderStats();
  renderZoneBar();
  renderRing();
  if (currentView === 'practice') drawSpectrumNow();
}

function stopSession(reason) {
  if (!live.running) return;
  live.running = false;
  live.camera?.stop();
  live.camera = null;
  releaseWakeLock();
  showFlash(null);
  setStatus('off');
  const rec = summarize(live.session);
  if (rec) {
    store.sessions.push(rec);
    persist();
    showSummary(rec, reason);
  } else {
    showNotice(`${reason ? reason + ' ' : ''}This session was too short to save: a score needs at least 30 seconds of steady signal.`);
    $('guide').hidden = false;
  }
  live.detector = null;
  updateStartButton();
  renderScore();
  renderHistory();
}

function summarize(s) {
  if (!s || s.t0 == null) return null;
  const scored = s.scores.filter(x => x.score != null);
  if (!scored.length) return null;
  const valid = s.beats.filter(b => b.valid);
  const avgHr = valid.length ? (60000 * valid.length) / valid.reduce((a, b) => a + b.ibi, 0) : null;
  const zones = { low: 0, medium: 0, high: 0 };
  for (const x of scored) zones[x.zone]++;
  const n = scored.length;
  return {
    id: s.id,
    startedAt: s.startedAt,
    durationSec: Math.round((s.endT - s.t0) / 1000),
    avgHr: avgHr == null ? null : round(avgHr, 1),
    avgScore: round(mean(scored.map(x => x.score)), 2),
    maxScore: round(Math.max(...scored.map(x => x.score)), 2),
    points: round(s.points, 1),
    zonePct: { low: zones.low / n, medium: zones.medium / n, high: zones.high / n },
    cuts: s.cuts,
    pacerBpm: s.pacerBpm,
    scores: scored.map(x => [Math.round(x.t), round(x.score, 2)]),
  };
}

async function requestWakeLock() {
  try { live.wakeLock = await navigator.wakeLock?.request('screen'); } catch { live.wakeLock = null; }
}
function releaseWakeLock() {
  live.wakeLock?.release?.().catch(() => {});
  live.wakeLock = null;
}

function updateStartButton() {
  const b = $('start-btn');
  b.disabled = live.starting;
  if (live.running) { b.textContent = 'Stop session'; b.classList.add('stop'); b.classList.remove('primary'); }
  else { b.textContent = live.starting ? 'Starting…' : 'Start session'; b.classList.remove('stop'); b.classList.add('primary'); }
}

// ---------------------------------------------------------------- live rendering
function latestScored() {
  const sc = live.session?.scores ?? [];
  for (let i = sc.length - 1; i >= 0; i--) if (sc[i].score != null) return sc[i];
  return null;
}

function renderScore() {
  const el = $('score'), lab = $('zone-label'), note = $('dial-note');
  const s = live.session;
  const last = s?.scores?.[s.scores.length - 1];
  if (live.running && s?.t0 == null) {
    el.textContent = '–'; el.classList.add('dim');
    lab.textContent = 'Coherence'; lab.dataset.zone = '';
    note.textContent = 'waiting for your fingertip';
    return;
  }
  if (live.running && !last?.score && !latestScored()) {
    const wait = Math.max(0, Math.ceil(COHERENCE.minWindowSec - ((s.endT ?? s.t0) - s.t0) / 1000));
    el.textContent = '–'; el.classList.add('dim');
    lab.textContent = 'Warming up'; lab.dataset.zone = '';
    note.textContent = wait > 0 ? `first score in about ${wait} s` : 'waiting for a steady signal';
    return;
  }
  if (live.running && last && last.score == null) {
    el.textContent = '–'; el.classList.add('dim');
    lab.textContent = 'Signal unsteady'; lab.dataset.zone = '';
    note.textContent = 'hold still · score resumes when clean';
    return;
  }
  const ls = latestScored();
  if (!ls) {
    el.textContent = '–'; el.classList.add('dim');
    lab.textContent = 'Coherence'; lab.dataset.zone = '';
    note.textContent = 'ring = last minute';
    return;
  }
  el.textContent = fmtScore(ls.score);
  el.classList.toggle('dim', !live.running);
  lab.textContent = `${ZONE_NAME[ls.zone]} coherence`;
  lab.dataset.zone = ls.zone;
  note.textContent = live.running ? (ls.provisional ? 'provisional · first minute' : 'ring = last minute') : 'last score';
}

function renderRing() {
  const segs = $('ring').children;
  const sc = (live.session?.scores ?? []).slice(-12);
  for (let i = 0; i < 12; i++) {
    const entry = sc[i];
    segs[i].dataset.zone = entry?.zone ?? '';
    segs[i].classList.toggle('latest', i === sc.length - 1 && !!entry?.zone);
  }
}

function renderHr() {
  const beats = live.session?.beats ?? [];
  const lastT = beats.length ? beats[beats.length - 1].t : 0;
  const recent = [];
  for (let i = beats.length - 1; i >= 0 && recent.length < 5; i--) {
    if (beats[i].t < lastT - 15) break;
    if (beats[i].valid) recent.push(beats[i].ibi);
  }
  if (!recent.length) return;
  recent.sort((a, b) => a - b);
  const med = recent[recent.length >> 1];
  $('hr').innerHTML = `${Math.round(60000 / med)}<small>bpm</small>`;
}

function renderStats() {
  const s = live.session;
  $('points').textContent = s ? String(Math.round(s.points)) : '0';
  if (s?.t0 != null && s.endT != null) $('elapsed').textContent = fmtTime((s.endT - s.t0) / 1000);
}

function renderZoneBar() {
  const scored = (live.session?.scores ?? []).filter(x => x.score != null);
  const n = scored.length || 1;
  for (const z of ['low', 'medium', 'high']) {
    const pct = scored.length ? Math.round((100 * scored.filter(x => x.zone === z).length) / n) : 0;
    $(`zb-${z}`).style.width = `${pct}%`;
    $(`zl-${z}`).textContent = `${pct}%`;
  }
}

function drawRhythmNow() {
  const s = live.session;
  const now = s?.t0 != null && s.endT != null ? (s.endT - s.t0) / 1000 : 0;
  drawRhythm($('rhythm'), s?.beats ?? [], now, COHERENCE.windowSec);
}

function drawSpectrumNow() {
  const res = live.result;
  const zone = res?.ok ? zoneFor(res.score, store.settings.cuts) : null;
  drawSpectrum($('spectrum'), res, zone, COHERENCE.peakBandHz);
  $('spectrum-meta').textContent = res?.ok
    ? `peak ${res.peakHz.toFixed(3)} Hz ≈ ${(res.peakHz * 60).toFixed(1)} breaths/min`
    : '0–0.4 Hz';
}

function renderLive() {
  renderScore();
  renderRing();
  renderStats();
  renderZoneBar();
  if (currentView === 'practice') {
    drawRhythmNow();
    drawSpectrumNow();
    if (live.detector) drawPulse($('pulse'), live.detector.trace, live.detector.marks);
  }
}

function showSummary(rec, reason) {
  $('summary').hidden = false;
  $('summary-title').textContent = reason ? 'Session stopped and saved' : 'Session saved';
  $('summary-when').textContent = new Date(rec.startedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  $('sum-score').textContent = fmtScore(rec.avgScore);
  $('sum-duration').textContent = fmtTime(rec.durationSec);
  $('sum-hr').textContent = rec.avgHr == null ? '–' : `${Math.round(rec.avgHr)} bpm`;
  $('sum-points').textContent = String(Math.round(rec.points));
  const z = rec.zonePct;
  $('summary-zones').textContent = `${reason ? reason + ' ' : ''}Time in zones: Low ${Math.round(z.low * 100)}% · Medium ${Math.round(z.medium * 100)}% · High ${Math.round(z.high * 100)}%. Peak score ${fmtScore(rec.maxScore)}.`;
  requestAnimationFrame(() => drawScoreTimeline($('summary-chart'), rec.scores, rec.cuts, rec.durationSec));
}

// ---------------------------------------------------------------- history
function renderHistory() {
  const list = store.sessions;
  $('k-sessions').textContent = String(list.length);
  const totalMin = list.reduce((a, s) => a + (s.durationSec || 0), 0) / 60;
  $('k-time').textContent = totalMin >= 90 ? `${round(totalMin / 60, 1)} h` : `${Math.round(totalMin)} min`;
  const weekAgo = Date.now() - 7 * 864e5;
  const week = list.filter(s => Date.parse(s.startedAt) >= weekAgo && s.avgScore != null);
  $('k-avg7').textContent = week.length ? fmtScore(mean(week.map(s => s.avgScore))) : '–';
  const best = list.reduce((b, s) => (s.avgScore != null && (!b || s.avgScore > b.avgScore) ? s : b), null);
  $('k-best').textContent = best ? fmtScore(best.avgScore) : '–';
  if (currentView === 'history') drawTrend($('trend'), list, store.settings.cuts);

  const box = $('sessions');
  box.replaceChildren();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No sessions yet. Each session is saved here when you stop it.';
    box.appendChild(p);
    return;
  }
  for (const s of [...list].reverse()) box.appendChild(sessionItem(s));
}

function sessionItem(s) {
  const el = document.createElement('article');
  el.className = 'session';
  const cuts = Array.isArray(s.cuts) ? s.cuts : store.settings.cuts;
  const zone = zoneFor(s.avgScore, cuts) || 'low';
  const top = document.createElement('div');
  top.className = 'session-top';
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = new Date(s.startedAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const pill = document.createElement('span');
  pill.className = 'score-pill';
  pill.dataset.zone = zone;
  pill.textContent = fmtScore(s.avgScore);
  pill.title = 'Average coherence';
  top.append(when, pill);

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  meta.textContent = [
    fmtTime(s.durationSec),
    s.avgHr == null ? null : `${Math.round(s.avgHr)} bpm`,
    `${Math.round(s.points)} pts`,
    `peak ${fmtScore(s.maxScore)}`,
    s.pacerBpm ? `pacer ${s.pacerBpm}/min` : null,
  ].filter(Boolean).join('  ·  ');

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('aria-label', `Low ${Math.round(s.zonePct.low * 100)}%, Medium ${Math.round(s.zonePct.medium * 100)}%, High ${Math.round(s.zonePct.high * 100)}%`);
  for (const z of ['low', 'medium', 'high']) {
    const sp = document.createElement('span');
    sp.className = z;
    sp.style.width = `${(s.zonePct[z] * 100).toFixed(1)}%`;
    bar.appendChild(sp);
  }

  const actions = document.createElement('div');
  actions.className = 'session-actions';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn small';
  del.textContent = 'Delete';
  del.addEventListener('click', () => {
    actions.replaceChildren();
    const q = document.createElement('span');
    q.textContent = 'Delete this session?';
    const yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn small danger'; yes.textContent = 'Delete';
    yes.addEventListener('click', () => {
      store.sessions = store.sessions.filter(x => x.id !== s.id);
      persist();
      renderHistory();
    });
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'btn small'; no.textContent = 'Keep';
    no.addEventListener('click', () => { actions.replaceChildren(del); });
    actions.append(q, yes, no);
    no.focus();
  });
  actions.appendChild(del);
  el.append(top, meta, bar, actions);
  return el;
}

// ---------------------------------------------------------------- settings
function rateHint() {
  const b = store.settings.pacerBpm, half = 30 / b;
  $('rate-hint').textContent = `${b.toFixed(1)} breaths/min · ${half.toFixed(1)} s in, ${half.toFixed(1)} s out (${(b / 60).toFixed(3)} Hz)`;
}

function initSettings() {
  const st = store.settings;
  $('set-pacer').checked = st.pacerOn;
  $('set-rate').value = String(st.pacerBpm);
  $('set-rate').disabled = !st.pacerOn;
  $('set-cut1').value = String(st.cuts[0]);
  $('set-cut2').value = String(st.cuts[1]);
  $('set-torch').checked = st.torch;
  $('set-wake').checked = st.wakeLock;
  rateHint();

  $('set-pacer').addEventListener('change', e => {
    st.pacerOn = e.target.checked;
    $('set-rate').disabled = !st.pacerOn;
    persist();
  });
  $('set-rate').addEventListener('input', e => {
    st.pacerBpm = Number(e.target.value);
    pacerEpoch = performance.now();
    rateHint();
  });
  $('set-rate').addEventListener('change', persist);

  const applyCuts = () => {
    const a = Number($('set-cut1').value), b = Number($('set-cut2').value);
    if (!(a > 0) || !(b > a)) {
      $('cuts-hint').textContent = '“High from” must be larger than “Medium from”, and both above 0.';
      return;
    }
    st.cuts = [round(a, 1), round(b, 1)];
    $('cuts-hint').textContent = 'Saved. New cut-offs apply to scores from now on.';
    persist();
    renderHistory();
  };
  $('set-cut1').addEventListener('change', applyCuts);
  $('set-cut2').addEventListener('change', applyCuts);
  $('cuts-reset').addEventListener('click', () => {
    $('set-cut1').value = '1'; $('set-cut2').value = '3';
    applyCuts();
  });

  $('set-torch').addEventListener('change', async e => {
    st.torch = e.target.checked;
    persist();
    if (live.running && live.camera) {
      live.camera.torch = await live.camera.setTorch(st.torch);
      live.cameraInfo.torch = live.camera.torch;
      showFlash(live.cameraInfo);
    }
  });
  $('set-camera').addEventListener('change', e => { st.cameraId = e.target.value; persist(); });
  $('set-wake').addEventListener('change', e => {
    st.wakeLock = e.target.checked;
    persist();
    if (live.running) (st.wakeLock ? requestWakeLock() : releaseWakeLock());
  });

  const wipeArea = $('wipe-area');
  const wipeBtn = $('wipe-btn');
  wipeBtn.addEventListener('click', () => {
    wipeArea.replaceChildren();
    const q = document.createElement('span');
    q.textContent = `Delete all ${store.sessions.length} sessions? `;
    const yes = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn small danger'; yes.textContent = 'Delete all';
    yes.addEventListener('click', () => {
      store.sessions = [];
      persist();
      renderHistory();
      wipeArea.replaceChildren(wipeBtn);
    });
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'btn small'; no.textContent = 'Cancel';
    no.addEventListener('click', () => wipeArea.replaceChildren(wipeBtn));
    wipeArea.append(q, yes, ' ', no);
    no.focus();
  });
}

async function populateCameras() {
  const sel = $('set-camera');
  const cams = await listCameras();
  if (!cams.length || !cams.some(c => c.label && !/^Camera \d+$/.test(c.label))) return;
  const keep = store.settings.cameraId;
  sel.replaceChildren(new Option('Automatic (rear camera with flash)', ''));
  for (const c of cams) sel.appendChild(new Option(c.label, c.id));
  sel.value = cams.some(c => c.id === keep) ? keep : '';
}

// ---------------------------------------------------------------- navigation
let currentView = 'practice';
function showView(v) {
  if (!['practice', 'history', 'settings'].includes(v)) v = 'practice';
  currentView = v;
  for (const id of ['practice', 'history', 'settings']) {
    $(`view-${id}`).hidden = id !== v;
    $(`tab-${id}`).setAttribute('aria-selected', String(id === v));
  }
  if (location.hash.slice(1) !== v) history.replaceState(null, '', `#${v}`);
  requestAnimationFrame(redraw);
}

function redraw() {
  if (currentView === 'practice') {
    renderLive();
    const rec = !$('summary').hidden && store.sessions[store.sessions.length - 1];
    if (rec) drawScoreTimeline($('summary-chart'), rec.scores, rec.cuts, rec.durationSec);
  } else if (currentView === 'history') {
    renderHistory();
  }
}

// ---------------------------------------------------------------- boot
function boot() {
  buildRing();
  initSettings();
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  $('start-btn').addEventListener('click', () => (live.running ? stopSession() : startSession()));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && live.running) stopSession('The app went to the background, so the session stopped.');
    else if (!document.hidden && live.running && store.settings.wakeLock) requestWakeLock();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; redraw(); });
  });

  // Mention the last session in the guide card.
  const last = store.sessions[store.sessions.length - 1];
  if (last) {
    const p = document.createElement('p');
    p.textContent = `Last session: ${new Date(last.startedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · average ${fmtScore(last.avgScore)} · ${fmtTime(last.durationSec)}.`;
    $('guide').appendChild(p);
  }
  if (!window.isSecureContext) showNotice('Open this page over HTTPS: browsers only allow camera access on secure pages.');

  showView(location.hash.slice(1) || 'practice');
  updateStartButton();
  renderHistory();
  requestAnimationFrame(frameLoop);
}

boot();
