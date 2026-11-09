// Steady Pulse — diagnostics panel and troubleshooting recording.
// Shows what the camera and beat detector are doing on this phone, and lets the
// user save or share the last minute of raw camera brightness values so the
// detector can be replayed and tuned offline.

const REASON = {
  irregular: 'off-rhythm',
  motion: 'movement',
  shape: 'not pulse-shaped',
  gap: 'gap',
  'after-artifact': 'next to a bad beat',
};
const SCORE_REASON = {
  'warming-up': 'warming up',
  'not-enough-beats': 'not enough clean beats',
  'low-coverage': 'too many rejected beats',
};

export function createDiagnostics({ live, store, version, recordSec, el }) {
  let lastRender = 0;
  let cameraDesc = null;

  function camera() {
    const d = live.camera?.describe?.();
    if (d) cameraDesc = d;
    return cameraDesc;
  }

  function frameStats(windowMs = 5000) {
    const raw = live.raw;
    if (raw.length < 3) return null;
    const tEnd = raw[raw.length - 1][0];
    let i = raw.length - 1;
    while (i > 0 && raw[i - 1][0] >= tEnd - windowMs) i--;
    const n = raw.length - i;
    if (n < 3) return null;
    let maxGap = 0;
    for (let k = i + 1; k < raw.length; k++) maxGap = Math.max(maxGap, raw[k][0] - raw[k - 1][0]);
    return { fps: (n - 1) / ((tEnd - raw[i][0]) / 1000), maxGap };
  }

  /** Peak-to-peak size of the filtered pulse over the last 5 s, as % of brightness. */
  function pulseSize() {
    const d = live.detector;
    if (!d || d.trace.length < 30 || !(d.dcEma > 0)) return null;
    const tEnd = d.trace[d.trace.length - 1].t;
    let lo = Infinity, hi = -Infinity;
    for (const p of d.trace) if (p.t >= tEnd - 5000) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    return (100 * (hi - lo)) / d.dcEma;
  }

  function beatStats(windowSec = 30) {
    const s = live.session;
    if (!s || !s.beats.length) return null;
    const tEnd = s.beats[s.beats.length - 1].t;
    const recent = s.beats.filter(b => b.t >= tEnd - windowSec);
    const reasons = {};
    for (const b of recent) if (!b.valid) { const k = REASON[b.reason] || b.reason || 'other'; reasons[k] = (reasons[k] || 0) + 1; }
    const clean = recent.filter(b => b.valid);
    const hr = clean.length ? (60000 * clean.length) / clean.reduce((a, b) => a + b.ibi, 0) : null;
    return { n: recent.length, clean: clean.length, reasons, hr, last: s.beats.slice(-8) };
  }

  function scoreState() {
    const last = live.session?.scores?.at(-1);
    if (!last) return live.running ? 'none yet' : '–';
    if (last.score != null) return `${last.score.toFixed(2)} (${last.zone}${last.provisional ? ', provisional' : ''})`;
    const why = SCORE_REASON[last.reason] || last.reason;
    return last.coverage != null ? `none: ${why} (${Math.round(last.coverage * 100)}% clean, needs 80%)` : `none: ${why}`;
  }

  function rows() {
    const cam = camera();
    const fs = frameStats();
    const rgb = live.lastRgb;
    const det = live.detector;
    const ps = pulseSize();
    const bs = beatStats();
    const out = [];
    out.push(['Camera', cam ? `${cam.label || 'unnamed'} · ${cam.width ?? '?'}×${cam.height ?? '?'}` : 'not started']);
    out.push(['Flash', cam ? (cam.torch ? 'on' : cam.torchAvailable ? 'off' : 'not available on this camera') : '–']);
    out.push(['Frames', fs ? `${fs.fps.toFixed(1)} per second · longest gap ${Math.round(fs.maxGap)} ms · ${cam?.sampler ?? ''}` : '–']);
    out.push(['Colour now', rgb ? `R ${rgb[0].toFixed(1)} · G ${rgb[1].toFixed(1)} · B ${rgb[2].toFixed(1)}` : '–']);
    out.push(['Finger', det ? `${det.finger ? 'detected' : 'not detected'} · using ${det.channel === 'g' ? 'green' : 'red'} channel` : '–']);
    out.push(['Pulse size', ps == null ? '–' : `${ps.toFixed(2)}% of brightness`]);
    out.push(['Status', det ? `${det.status}${Number.isFinite(det.thr) ? ` · threshold ${det.thr.toFixed(2)} (beats ${det.spk?.toFixed(2)}, noise ${det.npk?.toFixed(2)})` : ''}` : live.status]);
    out.push(['Beats (30 s)', bs ? `${bs.n} found · ${bs.clean} clean (${bs.n ? Math.round((100 * bs.clean) / bs.n) : 0}%)` : '–']);
    out.push(['Rejected', bs && Object.keys(bs.reasons).length ? Object.entries(bs.reasons).map(([k, v]) => `${k} ${v}`).join(' · ') : '–']);
    out.push(['Last intervals', bs ? bs.last.map(b => `${Math.round(b.ibi)}${b.valid ? '✓' : '✗'}`).join(' ') : '–']);
    out.push(['Heart rate', bs?.hr ? `${Math.round(bs.hr)} bpm from clean beats` : '–']);
    out.push(['Score', scoreState()]);
    return out;
  }

  function render(now = performance.now(), force = false) {
    if (el.panel.hidden || (!force && now - lastRender < 500)) return;
    lastRender = now;
    const frag = document.createDocumentFragment();
    for (const [k, v] of rows()) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      frag.append(dt, dd);
    }
    el.list.replaceChildren(frag);
  }

  function summaryText() {
    const lines = [`Steady Pulse diagnostics v${version} · ${new Date().toLocaleString()}`, `Browser: ${navigator.userAgent}`];
    for (const [k, v] of rows()) lines.push(`${k}: ${v}`);
    return lines.join('\n');
  }

  /** The last `recordSec` seconds of raw camera samples and detected beats. */
  function recording() {
    const raw = live.raw;
    const tEnd = raw.length ? raw[raw.length - 1][0] : 0;
    const frames = raw.filter(f => f[0] >= tEnd - recordSec * 1000);
    const t0 = frames.length ? frames[0][0] : 0;
    const s = live.session;
    const det = live.detector;
    return {
      app: 'Steady Pulse',
      version,
      created: new Date().toISOString(),
      userAgent: navigator.userAgent,
      camera: camera(),
      settings: { torch: store.settings.torch, pacerBpm: store.settings.pacerBpm },
      detector: det ? { status: det.status, channel: det.channel, finger: det.finger, spk: det.spk, npk: det.npk, thr: Number.isFinite(det.thr) ? det.thr : null } : null,
      summary: rows(),
      frameColumns: ['t_ms', 'r_x10', 'g_x10', 'b_x10'],
      frames: frames.map(f => [Math.round(f[0] - t0), Math.round(f[1] * 10), Math.round(f[2] * 10), Math.round(f[3] * 10)]),
      beatColumns: ['t_ms', 'interval_ms', 'clean', 'reason'],
      beats: s && s.t0 != null
        ? s.beats.map(b => [Math.round(b.t * 1000 + s.t0 - t0), Math.round(b.ibi), b.valid ? 1 : 0, b.reason || ''])
          .filter(b => b[0] >= -2000)
        : [],
      scores: s ? s.scores.slice(-14).map(x => ({ t_ms: Math.round(x.t * 1000 + (s.t0 ?? 0) - t0), score: x.score == null ? null : Math.round(x.score * 100) / 100, reason: x.reason ?? null, coverage: x.coverage ?? null })) : [],
    };
  }

  function recordingFile() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const text = JSON.stringify(recording());
    return new File([text], `steady-pulse-recording-${stamp}.txt`, { type: 'text/plain' });
  }

  function note(msg) { el.note.textContent = msg; }

  el.copy.addEventListener('click', async () => {
    const text = summaryText();
    try {
      await navigator.clipboard.writeText(text);
      note('Summary copied. Paste it into the chat.');
    } catch {
      el.fallback.hidden = false;
      el.fallback.value = text;
      el.fallback.focus();
      el.fallback.select();
      note('Copying was blocked. The summary is selected below: copy it manually.');
    }
  });

  el.save.addEventListener('click', () => {
    if (live.raw.length < 30) { note('Start a session first: the recording needs camera data.'); return; }
    const file = recordingFile();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    note(`Saved ${file.name} (${Math.round(file.size / 1024)} KB) to your Downloads.`);
  });

  const probe = new File(['x'], 'probe.txt', { type: 'text/plain' });
  if (navigator.canShare?.({ files: [probe] })) {
    el.share.hidden = false;
    el.share.addEventListener('click', async () => {
      if (live.raw.length < 30) { note('Start a session first: the recording needs camera data.'); return; }
      const file = recordingFile();
      try {
        await navigator.share({ files: [file], title: 'Steady Pulse recording' });
        note('Recording shared.');
      } catch (err) {
        if (err?.name !== 'AbortError') note('Sharing did not work here. Use Save recording instead.');
      }
    });
  }

  return {
    render,
    setVisible(on) { el.panel.hidden = !on; if (on) render(performance.now(), true); },
    summaryText,
    recording,
  };
}
