# Steady Pulse

A phone web app that reads your heart rate through the camera (fingertip over the rear
camera and flash) and computes a **heart-rhythm coherence score** using the method
HeartMath has published, with a breathing pacer, live charts and session history.

Runs entirely in the browser. Built and tested for **Chrome on Android**.

> Steady Pulse is a relaxation and biofeedback tool, not a medical device. It does not
> diagnose, treat or monitor any condition. It is not affiliated with HeartMath;
> "HeartMath", "Inner Balance" and "emWave" are trademarks of their owner.

---

## Put it online with GitHub Pages

The camera only works on pages served over HTTPS, so the app needs hosting.

1. Create a repository on GitHub (e.g. `steady-pulse`). On a free GitHub plan, Pages
   only works for **public** repositories. ⚠️ Plan rules can change, so check
   GitHub's current Pages documentation.
2. Add these files to the repository (push them, or use **Add file → Upload files**).
3. In the repository go to **Settings → Pages → Build and deployment**, choose
   **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After a minute or two, open `https://<your-username>.github.io/steady-pulse/` in
   Chrome on your Android phone and allow camera access.
5. Optional: Chrome menu **⋮ → Add to Home screen** to launch it like an app.

Anything that serves static files over HTTPS (Netlify, Cloudflare Pages, Vercel) also works.
No build step is needed.

## Using it

1. Tap **Start session** and allow the camera.
2. Rest your fingertip lightly over the rear camera **and** the flash. Cover both, and
   don't press hard, because pressing squeezes the blood out.
3. Keep your hand still and breathe with the circle (default 6 breaths/min: 5 s in, 5 s out).
4. The first (provisional) score appears after ~30 s and updates every 5 s. Full 64-second
   windows start after the first minute.
5. Tap **Stop session** to save it. History and settings stay in this browser on this phone.

| Zone (default) | Score | Basis |
|---|---|---|
| Low | < 1.0 | Your choice, from HeartMath's published guide: 0.5 basic, 1.0 good, 2.0 very good, 3.0+ excellent |
| Medium | 1.0 – 3.0 | ″ |
| High | ≥ 3.0 | ″ |

Cut-offs can be changed in **Settings**.

## Troubleshooting camera readings

Turn on **Settings → Show diagnostics**. A panel then appears on the Practice screen,
showing frame rate, flash, colour levels, pulse size, why beats were rejected, and why
there is no score.

- **Copy summary** copies those numbers as text.
- **Save recording** saves the last 60 seconds of raw camera brightness values and the
  detected beats as a small `.txt` file. **Share recording** sends the same file on
  phones that support it.
- The recording can be replayed offline with `node test/replay.js <file>` to see exactly
  why beats are rejected, and to test detector changes on a real signal.

To check heart-rate accuracy, wear a watch or fitness band that shows live heart rate
(for example, start a workout on it). Compare its reading with Steady Pulse at the same moment.

## How the score is calculated

Every 5 seconds, using the last 64 seconds of clean beat-to-beat intervals:

```
1. Resample intervals evenly at 2 Hz; remove the linear trend; apply a Hann taper
2. Power spectrum on a 1/64 Hz grid, 0–0.4 Hz
3. Peak     = highest local maximum between 0.04 and 0.26 Hz
4. P        = power in the peak bin ±1 bin  (window ≈ 0.031 Hz wide)
   B, A     = power below / above that window
5. ratio    = (P ÷ B) × (P ÷ A)
6. score    = ln(ratio + 1), capped at 16
Points      = sum of the 5-second scores over a session
```

| Parameter | Value | Published or our choice | Source |
|---|---|---|---|
| Window / update | 64 s / 5 s | Published | McCraty 2022; HeartCloud "Coherence Over Time" |
| Peak search band | 0.04–0.26 Hz | Published | McCraty 2022; Balaji et al. 2025 |
| Peak window | 0.030 Hz | Published; implemented as ±1 bin (0.031 Hz) | McCraty 2022 |
| Ratio formula | (P/B)×(P/A) | Published (current app method) | Balaji et al. 2025 |
| Score | ln(ratio+1), 0–16 | Published | Balaji et al. 2025; HeartCloud glossary |
| Resampling | 2 Hz linear | Published research method; cubic bridge across rejected beats is ours | Balaji et al. 2025 (methods) |
| Detrend, taper | linear, Hann | Our choice (research methods mention detrending and Hanning) | Balaji et al. 2025 (methods) |
| "Entire spectrum" | 0–0.4 Hz | Our choice | — |
| "Peak" = local maximum | — | Our choice; stops the low edge of a falling spectrum counting as a peak | — |
| Minimum data | 30 s (provisional), ≥80% clean | Our choice | — |

HeartMath calls its exact implementation proprietary, so scores follow theirs in direction
and scale but **will not match exactly**. The older published "classic" ratio,
P ÷ (total − P) (McCraty 2022), is on a different scale and is not used.

## Camera beat detection (js/ppg.js)

Each frame, the app averages the colour of the image centre. Every heartbeat briefly
darkens the fingertip. The signal goes through these steps:

1. Even 30 Hz resampling
2. Band-pass filter: 0.5 Hz first-order high-pass + 1.6 Hz Butterworth low-pass
3. Beat marker at the steepest point of each upstroke, with an adaptive threshold
4. Shape check against a learned pulse template
5. Interval checks

An interval is used only if the beats at **both** ends were undisturbed, pulse-shaped and on
time. Rejected intervals are interpolated over. If too many are rejected, no score is shown.

## Testing

`npm test` runs the unit tests (Node 18+). `test/e2e.cjs` runs the real app in headless
Chromium with a synthetic fingertip video as the camera (see the file header).

Results on **simulated** signals (30 fps, frame jitter, dropped frames, sensor noise):

| Scenario | Beats found | False beats | Interval error (RMS) | Heart rate (app / true) | Score (app / true) |
|---|---|---|---|---|---|
| Paced breathing, 3 runs | 99% | 0 | 9.2–10.2 ms | within 0.1 bpm | 7.23/7.37 · 6.75/7.00 · 7.09/7.41 |
| Mixed rhythm, 3 runs | 99–99.5% | 0 | 8.6–10.3 ms | within 0.1 bpm | 2.07/2.21 · 1.97/2.15 · 1.57/1.69 |
| Irregular rhythm, 3 runs | 99.1% | 0 | 9.0–9.2 ms | within 0.1 bpm | 0.33/0.34 · 0.73/0.69 · 0.71/0.70 |
| 45 / 60 / 90 / 110 / 130 bpm | 98–99% | 0 | 7.9–10.9 ms | within 0.2 bpm | — |
| Noisier capture, 2 runs | 97–99% | 0 | 20–22 ms | within 0.1 bpm | 6.51/7.37 · 6.27/7.00 |
| Pressure shifts + shaking | 92–95% | 0–2 | 10–11 ms | within 0.3 bpm | 6.45/7.64 · 2.85/2.81 · 0.61/0.39 |
| Very weak signal | 76–82% | 3–15 | 32–40 ms | — | no score shown (by design) |
| End-to-end in Chromium, paced | 98% clean | — | — | 65.2 / 65.1 | 6.55 / 6.82 |
| End-to-end in Chromium, irregular | 98% clean | — | — | 73.6 / 73.6 | 0.08 / 0.05 |

These are synthetic tests of the software, not a clinical validation. Real phones,
fingers and lighting vary.

## Files

| Path | What it is |
|---|---|
| `index.html` | Page, styles and layout |
| `js/app.js` | App controller: sessions, pacer, rendering, history, settings |
| `js/coherence.js` | Coherence engine (pure functions) |
| `js/ppg.js` | Camera beat detector (pure, testable) |
| `js/camera.js` | Camera, flash and frame sampling |
| `js/charts.js` | Canvas charts |
| `js/diagnostics.js` | Diagnostics panel and troubleshooting recording |
| `manifest.webmanifest`, `icon*` | Home-screen install |
| `test/` | Unit tests, synthetic signal generator, end-to-end test, recording replay |

## Key risks & caveats

- **Not a medical device.** Wellness and biofeedback use only. Distributing a health-related
  app can bring regulatory duties (in the US, see FDA guidance *General Wellness: Policy for
  Low Risk Devices*). Confirm with legal/compliance before acting on this.
- **Trademarks and IP.** The app uses its own name and design and is not affiliated with
  HeartMath. Before any commercial use, have IP counsel check trademarks and any patents
  covering coherence scoring. Confirm with legal/compliance before acting on this.
- **Not identical to HeartMath's numbers.** It uses the published method, but their exact code is proprietary.
- **Camera limits.** Movement, finger pressure and poor lighting reduce accuracy. Noisy
  signals bias the score downwards (−0.7 to −0.9 in the noisier test above). Very noisy
  signals produce no score rather than a wrong one.
- **Device support.** Built for Chrome on Android, where web pages can switch on the flash.
  Browsers on iPhone have limited flash control, and that has not been tested.
- **History is local.** Sessions live in this browser's storage. Clearing site data or
  switching phones loses them.
- **Network.** Fonts load from Google Fonts. Measurements are never sent anywhere.

## Sources

- McCraty R. (2022). *Following the Rhythm of the Heart: HeartMath Institute's Path to HRV
  Biofeedback.* Applied Psychophysiology and Biofeedback. https://pmc.ncbi.nlm.nih.gov/articles/PMC9214473/
- Balaji S., Plonka N., Atkinson M., Muthu M., Ragulskis M., Vainoras A., McCraty R. (2025).
  *Heart rate variability biofeedback in a global study of the most common coherence
  frequencies and the impact of emotional states.* Scientific Reports.
- HeartCloud help: Coherence Over Time — https://heartcloud.com/library/coherence_over_time.html
- HeartCloud help: Glossary — https://heartcloud.com/library/glossary.html
- HeartCloud help: Challenge Levels — https://heartcloud.com/library/challenge_levels.html
