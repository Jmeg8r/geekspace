---
change: 2026-10-18-day-recorder
pr: 1 (spike)
machine: Mac Studio, Apple M3 Ultra, 256 GB, macOS 27.0 (26A428), one 3840x2160 display (1920x1080 points)
toolchain: Swift 6.4 (Swift 5 language mode), Electron 42, Agent SDK 0.3.172, whisper-cli (Homebrew)
date: 2026-10-18
---
# Spike findings: Day Recorder PR 1

Every number here comes from `scripts/spike-day-recorder.mjs` (subcommand in brackets)
driving `native/gs-capture`, run on the Mac Studio on 2026-10-18. Raw media went to a temp
directory outside the repo and was deleted. The committed evidence in `spike-evidence/` is
synthetic: rendered fixtures, a canary document over a synthetic backdrop, and the result
JSON files listed at the end. Real screen frames were scored in memory and never kept.

## Summary

| # | Question | Result |
|---|---|---|
| 1 | SCK excludes a background TextEdit window | **Pass**, with three production rules (below) |
| 2 | SCK system audio excludes a denylisted app | **Fail for multi-process apps → gate tripped.** Re-planned with James onto a CoreAudio process tap, which **passes** every case |
| 3 | CoreAudio process objects report a denylisted app's audio | **Pass**, but only by polling: listeners never fire for input |
| 4 | Call detection by mic ownership | **Zoom: pass.** Chromium (browser/Meet stand-in): pass via helper mapping. FaceTime, Teams, Slack: not run |
| 5 | Vision OCR speed and accuracy | 110 ms/frame, 91.7% word recall at 1x; one blind spot (grey-on-grey text) with a fix |
| 6 | Storage and CPU | SHOT_SEC **30**; whisper **small.en** |
| 7 | Entitlements on a signed build | **No new entitlement.** Two TCC grants; one usage string to set |
| 8 | F4: `ANTHROPIC_API_KEY` switches Agent SDK billing | **Yes, confirmed** without any request leaving the machine |
| 9 | F8: `tmutil addexclusion` without admin | **Pass** (sticky form); `-p` needs root |
| 10 | F6: zero-retention on James's account | **Not available** (James checked the console) |
| R2 | MediaRecorder stop/restart gap | **~20 ms lost per boundary**; every segment decodes alone |

Gate outcome: (1) passed, (2) failed for Chromium/Electron apps and James chose to re-plan
system audio onto a CoreAudio tap (2026-10-18), which this spike then proved; (3) passed, so
no headphones fallback. See plan.md, Deviations.

---

## Q1. SCK window exclusion (`exclusion`)

**Method.** A synthetic TextEdit document holding the canary
`SYNTHETIC-DENYLIST-CANARY-7Q4X` three times. Two scenes: TextEdit frontmost, and TextEdit
in the background (Finder activated). For each, a full-display frame with no exclusion
(control) and one excluding `com.apple.TextEdit`, OCR'd in memory for the canary.

| Scene | Control: canary lines | Excluded: canary lines | Excluded apps |
|---|---|---|---|
| TextEdit frontmost | 3 | **0** | 1 |
| TextEdit background | 3 | **0** | 1 |
| Synthetic stage (images below) | 3 | **0** | 19 (stage keeps only TextEdit + backdrop) |

Capture time was 115–143 ms per 1920x1080 frame.

Evidence (`spike-evidence/q1-stage-control.png`, `q1-stage-excluded.png`). The same filter is
applied over a synthetic checkerboard window, with every other app also left out so no real
window can appear. In the excluded frame, the backdrop shows through where TextEdit was.

**Production rules found:**
1. **List every app, not on-screen ones only.** `SCShareableContent(onScreenWindowsOnly:
   true)` leaves out apps with no visible window. The denylist then silently matches nothing
   (measured in Q2: `excludedApps: 0`, tone at full level). `gs-capture` now uses `false`.
2. **SCK lists only apps that own at least one window.** A windowless audio process is never
   an exclusion target. This doesn't matter for screens; it is half of why Q2 failed.
3. **The menu bar leaks the frontmost app's menus.** With TextEdit frontmost and excluded, the
   menu bar still showed "File Edit Format View Window Help". The menu bar is a layer-24
   window with no owning app, so `excludingApplications` cannot remove it. PR 3: blank the
   menu-bar band, or skip the frame, while a denylisted app is frontmost.

Also measured: **SCK calls can hang forever.** During the spike, `captureImage` and
`startCapture` stopped returning (no error, no CPU), and every other process's SCK capture
hung too until the stuck process was killed. Then capture recovered at once. `gs-capture` now
wraps every SCK call in a 10 s timeout that exits non-zero, which is the R3 "Not recording"
path for the supervisor. The trigger was not isolated: it began while SCK audio, Electron and
the screenshot loop ran together.

## Q2. System-audio exclusion (`audio`, `web-audio`, `tap`)

**Method.** `SpikeTone.app` (`dev.geekspace.spike.tone`, built by the driver) plays a 440 Hz
sine at 0.25 amplitude (−15.05 dBFS RMS). Each capture is 4 s at 48 kHz.
`com.github.Electron` (the repo's Electron, playing WebAudio) stands in for any
Chromium-based app.

### ScreenCaptureKit audio

| Case | Captured RMS |
|---|---|
| Silence baseline | −∞ (0.0) |
| Tone, no exclusion | −15.05 dBFS |
| Tone app (windowed) excluded | **−∞, peak 0.0** ✅ |
| Tone app (windowless) excluded | **−15.05 dBFS** ❌ (not listed by SCK) |
| Electron excluded (`excludedApps: 1`) | **−15.05 dBFS** ❌, 3 of 3 runs |
| Tone launched after the stream started, static filter | leaked for 6.5 s (65 × 100 ms windows) ❌ |
| Same, re-listing apps every 200 ms + `updateContentFilter` | leaked 1 window (~150 ms) ❌ |

Chromium plays audio from a windowless helper process (`com.github.Electron.helper`).
Excluding the app does not exclude the helper, and SCK can't list the helper. Chrome (Meet),
Slack, Teams and most other Electron/WebView apps share this architecture, so **SCK audio
cannot meet R4 for them. The gate tripped.**

### Re-plan (James, 2026-10-18): CoreAudio process tap

A global stereo tap (`CATapDescription(stereoGlobalTapButExcludeProcesses:)`, macOS 14.2+)
in a private aggregate device on the default system output.

| Case | Exclude by process object | Exclude by **bundle ID** (macOS 26+) |
|---|---|---|
| Tone, no exclusion | −15.05 dBFS | −15.05 dBFS |
| Tone app (windowed) excluded | −∞ ✅ | **−∞, peak 0.0** ✅ |
| Tone app (windowless) excluded | −∞ ✅ | **−∞** ✅ |
| Electron, no exclusion | −15.05 dBFS | −15.05 dBFS |
| Electron excluded | −∞ ✅ (helper matched by prefix) | **−∞** ✅ |
| Electron launched after the tap started, no exclusion (control) | tone captured (41 × 100 ms windows) | tone captured (41 windows) |
| Electron launched after the tap started, excluded | ❌ 41 windows leaked; a live update is refused (`'!hog'`) | **0 leaked windows** ✅ |

**Bundle-ID exclusion is the design.** It needs no update when a process starts, so it closes
the late-launch leak that both SCK and process-object taps have.

Rules this measured:
- **Expand every denylist entry to `<id>` and `<id>.helper`.** With only
  `com.github.Electron` the helper's tone leaked at −15.05 dBFS; with both it was silent.
  Helper bundle IDs vary by app. PR 3 should also add any bundle a denylisted app's child
  processes report (Q3 sees them), and rebuild the tap when that set grows.
- **`kAudioAggregateDeviceTapAutoStartKey` must be `false`.** With `true`, `AudioDeviceStart`
  returned `noErr`, but the IO proc never ran: zero callbacks, no error and no TCC request.
  This is a silent-failure trap. The helper fails loudly when a tap delivers no samples.
- A live tap refuses `kAudioTapPropertyDescription` updates (`'!hog'`, even with IO stopped),
  so process-object exclusion can't follow new processes.
- The signed build ran the tap with the existing entitlements (Q7).
- SCK stays the screenshot path (Q1). Its audio path is dropped.

## Q3. CoreAudio process objects (`procwatch`)

| Event | Detection relative to the app's own timestamp |
|---|---|
| Tone app starts output | −25 ms (IO starts before `engine.start()` returns) |
| Tone app stops output | +41 ms |
| Tone app opens the mic | −26 ms |
| Tone app closes the mic | +125 ms |

Polling at 100 ms costs **1.2% of one core** (0.72 CPU-s over 60 s).

What it took:
- **Detach the HAL from the main run loop** (`kAudioHardwarePropertyRunLoop` = NULL). Under
  an async `main`, every listener stayed silent until this was set.
- **Poll; don't rely on listeners.** On macOS 27.0,
  `kAudioProcessPropertyIsRunningInput`/`Output` listeners never fire.
  `kAudioProcessPropertyIsRunning` fires for output, but nothing fires for mic use. The
  100 ms poll is what detects the mic.
- A process that exits drops out of the list without a final change, so the watcher reports
  `gone`.
- Our own capture shows up: `com.apple.replayd` reports "running input" while an SCK audio
  stream is open, and `com.apple.avconferenced` showed input for the whole session with no
  call. Call detection must ignore both.

F2 holds: the mic pause can key off this (no headphones fallback).

## Q4. Call detection by mic ownership (`calls`, `web-mic`)

| App | Run | What CoreAudio reported |
|---|---|---|
| Zoom | James, New meeting | `us.zoom.xos` input+output on join; output then input released on leave. Attributed to Zoom itself |
| Browser (Meet stand-in) | Electron, real mic via `getUserMedia` | `com.github.Electron.helper` input+output, released on exit; responsible-app lookup empty → map by bundle prefix (or parent PID) |
| FaceTime | not run | `avconferenced` held input all session with no call; FaceTime needs its own test before it is trusted |
| Teams, Slack | not run | Electron/WebView family: expect the helper pattern above; unverified |

PR 4's call detector: bundle (or `<app>.` prefix) in the call-app list, input running, ignore
`replayd`, `avconferenced` and our own processes. FaceTime, Teams and Slack get a test call
each on the signed build before PR 4 merges (plan Proof already lists a FaceTime call).

## Q5. Vision OCR (`ocr`)

Ten synthetic screens from `tests/fixtures/day-recorder/ocr-fixtures.json`, rendered at run
time: inbox, dark code editor, chat, calendar, terminal, spreadsheet, document, slide,
low-contrast settings, article. They are scored by word recall against the known text. Each
level runs in one process, warmed by a throwaway first image. The first request in a process
took 339 ms, the cold model load.

| Render | Level | Mean ms | Max ms | Pooled word recall | Worst fixture |
|---|---|---|---|---|---|
| 1x (1920x1080) | accurate | **110** | 144 | **0.917** | settings, 0.0 |
| 1x | fast | 16 | 19 | 0.837 | settings, 0.39 |
| 2x (3840x2160) | accurate | 134 | 168 | 0.930 | settings, 0.0 |
| 2x | fast | 34 | 38 | 0.937 | spreadsheet, 0.55 |

**Blind spot:** accurate mode returned **zero lines** for mid-grey text on light grey
(`#8a8a8a` on `#ececec`, about 3:1). It did so at 11, 13 and 15 pt and at 2x, while black text
of the same size read fully. It is not an alpha-channel issue. Boosting contrast didn't help,
but **a luminance threshold (binarise at 190) recovered all 5 lines.** macOS secondary labels
look like this. PR 3: when accurate OCR finds few lines, retry once on a thresholded copy.

Settled: **accurate, at 1x (point resolution).** 2x adds 1.3 points of recall for 4x the
pixels and storage.

## Q6. Storage and CPU (`shots`, `shots-analyze`, `whisper`)

### Screenshots

**Method.** One real hour of James's screen (231 ticks over 59.8 min). Each tick captured at
1920x1080, encoded as HEIC (quality 0.6), and hashed with a 32x32 difference hash. A frame
was skipped when it was within 8 bits of the last kept frame; kept frames were OCR'd
(accurate). Frames stayed in a temp directory and were deleted. The 30 s and 60 s rows replay
the same timeline at every 2nd and 4th tick, re-running the skip logic
(`shots-analyze`), so all three intervals see identical activity. Per-hour figures divide by
231 × 15 s (57.8 min), not the measured 59.8 min, so they overstate by about 3.5%.

| SHOT_SEC | Ticks | Kept | MB/hour | MB per 8 h day | GB per 30 days | Helper CPU s/hour | % of one core |
|---|---|---|---|---|---|---|---|
| 15 | 231 | 124 | 20.2 | 162 | 4.85 | 59.7 | 1.66 |
| **30** | 116 | 75 | **12.4** | **99** | **2.96** | **30.0** | **0.83** |
| 60 | 58 | 41 | 6.8 | 54 | 1.62 | 14.8 | 0.41 |

Per frame: capture 65 ms, HEIC encode 52 ms, 161 KB mean. OCR averaged 321 ms on kept real
frames, about 3x the fixtures: real screens carry far more text (one frame: 4,627
characters). Helper CPU covers capture, hash, encode and OCR. It excludes WindowServer and
replayd, and the hour overlapped other spike tests, so treat it as an upper bound for the
helper and a lower bound for the system.

Settled: **SHOT_SEC 30** (the spec default). Every interval is cheap on this machine, so
storage is not what decides it. What decides it is the OCR text each kept frame adds to
every Claude batch: 15 s keeps 65% more frames than 30 s for the same hour, and that is
mostly the same screen in a different state. At 60 s the hour keeps 41 frames against
75, so a screen shown for under a minute is more often never captured.

### Audio

Opus at 32 kbps is **14.4 MB/hour per stream** (spec R2, arithmetic). Mic plus system audio
for 8 hours is about **230 MB/day, ~6.9 GB for 30 days.**

### Whisper (`whisper`)

54.3 s of synthetic meeting speech (`speech-script.json`, 155 words, macOS `say`), clean and
with pink noise at ~6 dB SNR. Each model ran three times on the clean input; times are stable
within ±0.4 s (first run: a 9.9 s cold Metal start). WER is shown raw and with spelled-out
numbers normalised ("forty percent" vs "40%").

| Model | Input | Wall s | CPU s | × realtime | Peak RSS | WER raw | WER normalised |
|---|---|---|---|---|---|---|---|
| base.en | clean | 0.99 | 0.98 | 0.018 | 398 MB | 4.5% | 1.3% |
| small.en | clean | 1.62 | 1.18 | 0.030 | 897 MB | 3.2% | **0%** |
| base.en | noisy | 0.93 | 0.78 | 0.017 | 390 MB | 3.2% | 1.9% |
| small.en | noisy | 1.55 | 1.12 | 0.029 | 893 MB | 3.2% | **0%** |

Settled: **small.en.** It makes no word errors here, and an 8-hour day of two streams
(16 audio-hours) costs about 29 minutes of mostly-GPU time and about 20 CPU-minutes.
Limits: synthetic TTS speech only (the repo can't hold real recordings), and one short sample.
James can re-check privately on a real recording before PR 5.

## Q7. Entitlements on a signed build

**Build.** `electron-builder --mac` with a temporary config that adds
`native/gs-capture/.build/release/gs-capture` to `extraResources` (the PR 3 wiring), signed
with `Developer ID Application: James Cruce (Z4CHD4858S)`, Hardened Runtime, not notarised.
`codesign --verify --deep --strict` passes.

```
$ codesign -d --entitlements - --xml Geekspace.app | plutil -p -    (same for Contents/Resources/gs-capture)
  "com.apple.security.automation.apple-events" => true
  "com.apple.security.cs.allow-jit" => true
  "com.apple.security.cs.allow-unsigned-executable-memory" => true
  "com.apple.security.cs.disable-library-validation" => true
  "com.apple.security.device.audio-input" => true
$ codesign -dv .../gs-capture  →  Identifier=gs-capture  flags=0x10000(runtime)  TeamIdentifier=Z4CHD4858S
```

electron-builder signs the helper and gives it `entitlementsInherit` with no extra config.

**Run.** The signed binary was launched by `open` with `ELECTRON_RUN_AS_NODE=1`, so Geekspace
is the TCC-responsible process. It spawned the bundled helper, exactly as the PR 3 supervisor
will.

| Step | Result |
|---|---|
| Before any grant | SCK: "The user declined TCCs for application, window, display capture". procwatch: works (no TCC) |
| After James enabled Geekspace in Screen & System Audio Recording | `apps` 51 listed, `shot` 115 ms, SCK `audio` −15.06 dBFS of tone, `procwatch` OK |
| Tap, after James added Geekspace to System Audio Recording Only | control −15.05 dBFS, tone app excluded −∞ |
| Tap, after `tccutil reset AudioCapture com.astgl.geekspace` | still captured (−15.27 dBFS), no prompt, no tccd AudioCapture request |

**Settled keys:**
- **Entitlements: none new.** The existing five cover SCK screen capture, CoreAudio process
  objects and the tap. `com.apple.security.device.audio-input` stays for the renderer mic.
- **TCC: Screen & System Audio Recording** (required for screenshots: denied without it) and,
  for the tap, **System Audio Recording**. The tap's own grant is not isolated: it kept working
  after the reset, while the screen grant stayed in place. PR 3 settles it on a clean TCC
  state (new macOS user), because a silently missing grant is the failure class this repo has
  had before.
- **Info.plist:** `NSMicrophoneUsageDescription` (exists). Also
  **`NSAudioCaptureUsageDescription`**: electron-builder already injects a generic default
  ("This app needs access to audio capture"), so PR 3 must set a real string in `extendInfo`.
  Screen recording has no usage-description key; its prompt text is the system's.

## Q8. F4: does `ANTHROPIC_API_KEY` switch Agent SDK billing? (`sdk-billing`)

Both runs pointed the SDK at a local server that answered 401 to everything. No request could
reach Anthropic, and nothing could be billed. The server recorded header names and the kind
of credential, never a value. The environment was stripped of every `CLAUDE*`/`ANTHROPIC*`
variable first, to match a Dock-launched Electron.
- *Pitfall found on the way:* a run from inside a Claude Code session inherits that host's
  auth variables, which decide the answer. Unstripped, both runs sent the OAuth token.

| Run | `apiKeySource` (init message) | Credential sent on `/v1/messages` |
|---|---|---|
| No key (ARCHITECT today) | `none` | `Authorization: Bearer <OAuth access token>` |
| `ANTHROPIC_API_KEY` set (fake key) | `ANTHROPIC_API_KEY` | `x-api-key: <the fake key>`, no OAuth |

**Confirmed:** the key in the environment moves ARCHITECT from the subscription to API-key
billing.

**Settled name:** `GEEKSPACE_DAY_RECORDER_CLAUDE_KEY`. It is stored as a `safeStorage`
(Keychain-backed) blob at `<userData>/day-recorder/claude-key.enc`, read only by
`electron/dayAssistant.mjs`, and never put in `process.env` or `.env.local`.

## Q9. F8: Time Machine exclusion without admin (`tmutil`)

As uid 501, not root:
```
tmutil addexclusion <dir>      → exit 0
tmutil isexcluded <dir>        → [Excluded]  <dir>
xattr com.apple.metadata:com_apple_backup_excludeItem → present (sticky, travels with the folder)
tmutil addexclusion -p <dir>   → exit 80 "requires root privileges"
```
Use the sticky form. Settings shows `isexcluded`.

## Q10. F6: zero data retention

James checked the Claude Console: **his organization has no ZDR.** Per Anthropic's docs, ZDR
isn't self-serve. It is requested through Anthropic sales and enabled per organization.
`/v1/messages` is eligible; the Batch API (29-day retention) is not.
([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention))
Without ZDR, requests follow Anthropic's commercial retention policy. F6's notice wording
("recorded and transcribed") stands. The spec records that zero retention is not in use.

## R2. MediaRecorder stop/restart gap (`segment-gap`)

Six 5 s segments recorded in a hidden Electron window from one `MediaStream` (Chromium's
fake capture device; the stream opens once either way). Each was decoded alone with the
`meetingProcessor.mjs` ffmpeg arguments (`-ar 16000 -ac 1`).

| Restart strategy | `onstart` after `stop()` | Audio lost per boundary | Every segment decodes alone |
|---|---|---|---|
| Start the next recorder immediately | 52–61 ms | **18 ms** | ✅ (6 × 5.04 s) |
| Wait for the old recorder's `stop` event | 59–64 ms | **22 ms** | ✅ |

At `SEGMENT_SEC` 300 that is about 0.25 s lost per hour. Starting immediately saves only
4 ms per boundary, so either strategy is fine. Lost audio is wall-clock span minus decoded
duration. That approximation hides where in the boundary the loss falls.

## Evidence files (`spike-evidence/`)

- `q1-stage-control.png`, `q1-stage-excluded.png`: synthetic stage, cropped
- `results/*.json`: the driver's result JSON for each question, copied from the run (counts,
  levels, timings and bundle IDs only; no frames, hashes, text or credentials)

## Not done in this spike

- FaceTime, Teams and Slack call detection (Zoom and the Chromium stand-in only).
- Whether the tap needs its own TCC grant, on a clean TCC state.
- The SCK hang's trigger.
- Real-speech whisper accuracy (synthetic only, by design).
