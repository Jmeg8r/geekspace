---
change: 2026-10-18-day-recorder
status: accepted
track: T3
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [design:ux-copy, design:accessibility-review]
claude_config_sha: 18f3827
---
# Spec: Day Recorder v1 (Mac Studio)

## Flagged concerns

Each concern gives its source, a recommendation, and James's resolution.

**F1. Excluding an app at capture time means excluding its windows, not checking which app
is in front.**
- *Problem:* Electron's `desktopCapturer` captures the whole screen. Checking the front app
  first would still capture a denylisted app's window visible behind it. That breaks the
  intent's rule: "exclusions are enforced at capture time, not filtered afterwards".
  ScreenCaptureKit's `SCContentFilter` can leave out named applications, both windows and
  audio, before a frame exists.
- *Recommendation:* a small Swift helper, `gs-capture`, under `native/`. It is built with
  `swiftc` on the Mac during `npm run package`, and the binary is not committed. It uses
  ScreenCaptureKit for screenshots and system audio, and Vision for OCR. Electron spawns it
  with the denylist, and it streams JSON lines back.
- *Cost:* a Swift toolchain in the Mac build. The ubuntu-only CI can't compile it, so CI
  checks only its JS interface, using a fake helper.
- *Resolution:* **Accepted (James, 2026-10-18):** use the Swift helper.

**F2. The room mic hears a denylisted work call played through speakers.**
- *Problem:* ScreenCaptureKit can drop a denylisted app's system audio, but the mic still
  picks up whatever comes out of the speakers. The denylist cannot reach the room.
- *Recommendation:* pause the mic while any denylisted app is using audio input or output.
  macOS 14 CoreAudio process objects can report this. *Unverified:* the spike must prove it
  before this is relied on. If it can't be proven, fall back to a documented rule: "use
  headphones for denylisted calls".
- *Resolution:* **Accepted (James, 2026-10-18):** auto-pause the mic, proven in the spike; fall back to the headphones rule.

**F3. The app cannot speak a notice into another app's call.**
- *Source:* intent open question 1 and the "call notice" success signal.
- *Recommendation:* when a call starts (a call app takes the mic), call audio is held in
  memory and not written to disk. A prompt asks James to tell the other people. "I told
  them" logs a `noticeGiven` event and flushes the held audio. "Don't record this call"
  discards it. With no answer within `NOTICE_TIMEOUT_MIN` (default 15), the audio is
  discarded and a warning stays visible.
- *Result:* no call audio reaches disk without a logged notice, which is what the success
  signal tests.
- *Resolution:* **Changed (James, 2026-10-18):** a longer timeout. `NOTICE_TIMEOUT_MIN` defaults to **15**. 15 minutes of Opus audio is a few MB, so R2 is unaffected.

**F4. Naming the key `ANTHROPIC_API_KEY` could move ARCHITECT onto API billing.**
- *Source:* intent open question 6 ("separate from ARCHITECT's credit pool").
- *Problem:* `electron/architect.mjs` passes `process.env` to the Agent SDK, and the main
  process loads `.env.local`. If `ANTHROPIC_API_KEY` appears there, the Agent SDK is
  believed to switch to API-key billing. *Unverified;* the plan checks it.
- *Recommendation:* use a distinct key name, kept in the macOS Keychain through Electron
  `safeStorage` and entered in Settings. Nothing goes into `.env.local`.
- *Resolution:* **Accepted (James, 2026-10-18):** Keychain under a distinct name.

**F5. Policy not applied: `security-review` and `gstack-cso`.**
- *Problem:* both audit existing code or a diff, and this change has no code yet.
- *Recommendation:* accept the spec without them, and run both on the implementation PR
  before Codex. Their findings would block the merge.
- *Resolution:* **Accepted (James, 2026-10-18):** run both on the implementation PR. Their findings block the merge.

**F6. Third-party words go to Claude.**
- *Source:* the security and data review in this spec.
- *Problem:* transcripts and OCR text include other people's speech and on-screen messages,
  and that text is sent to a cloud model. The notice in F3 says "recording", not "and
  processed by AI".
- *Recommendation:* the notice wording James is prompted to give says the call is recorded
  and transcribed. Claude calls go only through the Messages API with zero retention if
  that option is available on the account (to be checked).
- *Resolution:* **Accepted (James, 2026-10-18):** both, the notice wording and zero-retention API use if the account offers it.

**F7. Encryption at rest.**
- *Source:* intent open question 3, still open.
- *Recommendation:* rely on FileVault in v1. Turning the recorder on checks
  `fdesetup status` and refuses to start if FileVault is off, with an error that says how to
  fix it. App-level encryption is deferred.
- *Resolution:* **Accepted (James, 2026-10-18):** the FileVault gate.

**F8. A 30-day purge does not reach backups.**
- *Source:* intent open question 3.
- *Recommendation:* mark the media root with `tmutil addexclusion` (a sticky xattr; believed
  to need no admin rights, to be verified). Settings shows whether the exclusion holds.
  Derived text in Convex is still backed up, which is intended because it is kept forever.
- *Resolution:* **Accepted (James, 2026-10-18):** exclude the media root from Time Machine.

## Requirements

Each requirement traces to the intent.

- **R1. On/off and indicator.**
  - One switch turns the Day Recorder on.
  - While any capture is live, a persistent indicator shows the word **Recording** plus an
    icon, in both the app chrome and the macOS menu bar (tray).
  - Pause and resume take one click or the global shortcut ⌥⌘R.
  - *Traces to:* intent, Capture; Constraints "never silent"; open question 1, in person.
- **R2. Rolling audio segments.**
  - Mic and system audio are written as segments of `SEGMENT_SEC` (default 300) to the
    media root.
  - No more than one segment is held in memory, so renderer and helper memory stay flat
    over 8 hours.
  - *Traces to:* success signal, flat memory.
- **R3. Loud failure.**
  - A mic that stays silent for `SILENCE_WARN_SEC` raises a visible warning, reusing
    `recorder.ts`'s floor.
  - A helper that exits, or a revoked Screen Recording or Audio permission, raises a
    visible error within 10 s and stops showing **Recording**.
  - *Traces to:* constraint "never silent".
- **R4. Denylist.**
  - The list holds app bundle IDs edited in Settings.
  - Denylisted apps' windows and audio are excluded by the capture filter (F1).
  - The mic follows F2.
  - Zero frames, OCR rows or audio of denylisted apps are produced.
  - *Traces to:* intent open question 2.
- **R5. Call notice.** No call audio is written without a `noticeGiven` event (F3).
  *Traces to:* open question 1.
- **R6. Screenshots and OCR.**
  - A screenshot is taken every `SHOT_SEC` (default 30), skipped when the frame is
    unchanged (a perceptual hash).
  - Stored as HEIC at reduced resolution.
  - OCR is local (Vision). OCR text goes into Convex; the image stays on disk.
  - *Traces to:* intent, Capture.
- **R7. Local transcription.**
  - Each closed audio segment is transcribed by whisper.cpp, reusing the
    `meetingProcessor.mjs` toolchain.
  - The model size is chosen in the spike (the Mac Studio has the headroom).
  - Transcript rows link to their segment and time range.
  - *Traces to:* intent, Capture.
- **R8. Claude reasoning.**
  - The Messages API is called every `BATCH_MIN` (default 15) over new transcript and OCR
    text, plus once at the end of the day.
  - Every call is logged with its tokens and cost.
  - A hard daily cap stops calls when reached, and says so.
  - *Traces to:* open question 6.
- **R9. Images on demand.** An image is sent to Claude only after an explicit request.
  Every send writes an `imageSent` event before the request leaves, and an unlogged send is
  impossible by construction. *Traces to:* intent, Reasoning.
- **R10. Actions inside Geekspace.**
  - The assistant creates to-dos as task rows.
  - "Block time" means a task row plus a **locked** `timeBlock`. The scheduler keeps locked
    blocks, so no scheduler change is needed.
  - Every action is written to `assistantActions` first.
  - *Traces to:* open question 7; constraint on scheduler survival.
- **R11. One-click undo.** Undo applies the stored inverse. It refuses, with an
  explanation, if James has since edited the target. *Traces to:* open question 7.
- **R12. External drafts.**
  - Linear updates are stored as drafts in a review queue.
  - No network call goes to Linear until James clicks Approve.
  - *Traces to:* intent, Autonomy.
- **R13. Daily record.** The end-of-day summary links every item to its source (segment
  plus time, or a screenshot). The review lists that day's `assistantActions`, each with
  Undo. *Traces to:* intent, Daily record.
- **R14. Retention.** Each day, raw media older than 30 days is deleted. Derived text is
  kept. Deletions are logged with a count. *Traces to:* open question 3.
- **R15. Archive search.** Transcript and OCR text use a Convex search index, and the
  existing search surface (`convex/search.ts`) includes them. *Traces to:* intent, Archive.

## Design

**Processes.**
- **`gs-capture` (Swift, F1).**
  - Captures ScreenCaptureKit screenshots and system audio with the denylist filter, and
    runs Vision OCR.
  - Watches CoreAudio processes for the F2 mic pause and for call detection (F3).
  - Emits JSON lines on stdout. It is spawned and supervised by
    `electron/dayRecorder.mjs`, which follows the backendProcess error-listener pattern
    from PR #69: a spawn error is reported, never left to hang.
- **Mic capture.** A hidden `BrowserWindow` (`capture.html`) runs `MediaRecorder` with a
  `SEGMENT_SEC` timeslice. Each chunk is sent over IPC to the main process, which appends
  it to the current segment file. The hidden window survives navigation in the main window.
  `recorder.ts` is not changed; Meetings keeps its own path.
- **Main process (`electron/dayRecorder.mjs`).**
  - Owns the media root, which is `<app data>/day-recorder/YYYY-MM-DD/`.
  - Owns the transcription queue, the Claude batcher (`electron/dayAssistant.mjs`), the
    purge job, and the tray indicator.
  - Talks to Convex through the existing client.

**Data (new Convex tables).** All handlers validate their arguments with `v.*` at the
boundary.
- `captureSegments`: `{ day, kind: "mic"|"system"|"call", path, start, end, status, noticeEventId? }`
- `transcripts`: `{ segmentId, start, end, text }`, with a search index on `text`.
- `screenshots`: `{ day, path, takenAt, appBundleId, ocrText }`, with a search index on
  `ocrText`.
- `recorderEvents`: `{ at, kind: "noticeGiven"|"noticeDeclined"|"imageSent"|"capError"|"purged"|"capPaused", detail }`
- `assistantActions`: `{ at, kind, targetTable, targetId, before, after, sourceSegmentId?, sourceScreenshotId?, undoneAt? }`
- `externalDrafts`: `{ target: "linear", payload, status: "pending"|"approved"|"sent"|"discarded", sourceActionId }`
- `assistantUsage`: `{ day, inputTokens, outputTokens, costUsd }`
- `settings` gains: `dayRecorderEnabled`, `denylist: string[]`, `dailyCapUsd`, `batchMin`,
  `shotSec`.

**Interfaces (preload).** A narrow `dayRecorder` namespace:
- `status()`, `setEnabled(bool)`, `pause()`, `resume()`
- `noticeGiven(callId)`, `noticeDeclined(callId)`
- `requestImage(screenshotId)`
- `approveDraft(id)`, `undo(actionId)`
- `onEvent(cb)`

There is no generic passthrough. The key is set through `setApiKey(string)`, which is
write-only: there is no getter.

**UI states and copy** (applies `design:ux-copy`).

| State | Indicator | Copy |
|---|---|---|
| Recording | red dot + "Recording" | Tray tooltip: "Day Recorder is on. ⌥⌘R to pause." |
| Paused | hollow dot + "Paused" | "Recording paused. Resume when you're ready." |
| Call held | amber + "Call — not saved yet" | Prompt: "Tell everyone on this call it's being recorded and transcribed." Buttons: **I told them — record** / **Don't record this call** |
| Mic silent | amber + "Mic silent" | "No sound from <device> for 25 seconds. Check the input in System Settings → Sound, or pause recording." |
| Error | grey + "Not recording" | What + why + fix, e.g. "Screen capture stopped. Geekspace lost Screen Recording permission. Turn it back on in System Settings → Privacy & Security." |
| Cap reached | "Assistant paused" | "Today's assistant budget ($X) is used up. Capture continues; reasoning resumes tomorrow, or raise the cap in Settings." |

**Accessibility** (applies `design:accessibility-review`, WCAG 2.1 AA).
- State is never shown by colour alone: there is always a text label (1.4.1).
- Indicator and tray items have accessible names (4.1.2), and the indicator has at least
  3:1 non-text contrast (1.4.11).
- The call prompt is keyboard-operable, with focus moved to it when it opens. It is not
  modal, so it never traps focus (2.1.1, 2.4.3).
- Undo and Approve buttons are labelled with their action ("Undo: added 'Send deck'"), not
  just "Undo".
- The notice timeout is visible, and James can extend it once (2.2.1).

## Security and data

- **Data stays local by default.** Raw media never leaves the machine. Text goes to the
  Messages API in batches, and images go only through R9.
- **Secrets.** The API key lives in Keychain via `safeStorage` (F4). It is never logged,
  never in `.env.local`, never sent to the renderer, and never put in the geekspace-mcp
  environment (`mcpEnv` already allowlists).
- **Logging.** Logs contain counts, ids and durations, never transcript or OCR text. This
  is the same rule as the function-sync redaction fix (2026-10-17).
- **Input validation.**
  - Convex handlers validate every argument.
  - `gs-capture` output is parsed line by line, and unknown or malformed lines are logged
    and dropped.
  - Paths from Convex are resolved and must stay inside the media root before any read or
    delete. This is the guard that stops the purge from ever deleting outside it.
- **Claude output is untrusted.** Model replies are parsed against a zod schema of allowed
  actions (create task, block time, draft Linear). Anything else is rejected and logged.
  The model cannot invoke arbitrary mutations.
- **Entitlements (unverified, the spike settles it).** It is not yet established which
  entitlement or usage-description keys ScreenCaptureKit screen and audio capture, and
  CoreAudio process monitoring, need under Hardened Runtime. The spike lists the exact keys
  and proves them on a **signed** build, because a dev build passing proves nothing (repo
  review standard: this exact failure already happened with the mic). The helper is signed
  with the app's identity and carries the same entitlements.
- **Public repo.** Fixtures are synthetic and live under `tests/fixtures/day-recorder/`,
  each file headed `SYNTHETIC`. The media root is outside the repo.

## Acceptance checks

These seed plan.md's Proof section.

- **Memory (R2).** Run a 2-hour soak with an instrumented RSS log. The helper and the
  capture window each grow less than 50 MB from the 10-minute mark onward. Then do one full
  8-hour run on the Mac Studio.
- **Loud failure (R3).** Unplug the mic: the amber warning appears within 25 s. Revoke
  Screen Recording: "Not recording" appears within 10 s. Kill `gs-capture`: an error
  appears, with no hang. All three are screenshotted.
- **Denylist (R4).** With TextEdit on the denylist, open and in front: the count of
  `screenshots` rows with TextEdit's bundle id is `0`, and frames show no TextEdit window.
  A vitest test with a fake helper asserts that the denylist is passed to the filter.
- **Call notice (R5).** A unit test: call audio with no notice event results in zero
  `captureSegments` of kind `call` and zero files on disk. A manual FaceTime test call
  covers the three paths: told, declined, and timed out.
- **Assistant actions (R10, R11).**
  - A synthetic transcript, "I'll send the deck by Thursday", produces 1 task row,
    1 locked block and 2 `assistantActions`.
  - `scheduling` re-run leaves the block in place.
  - Undo removes both.
  - Undo after a manual edit is refused.
- **External drafts (R12).** Network capture during a test run shows no request to
  `api.linear.app` before Approve.
- **Images (R9).** A test stubs the HTTP client and asserts an `imageSent` event exists
  before the request is issued. A test calling the sender without the logger fails to
  compile, because the logger is a required parameter.
- **Cost cap (R8).** A stubbed day at cap: the next batch is skipped, a `capPaused` event
  is logged, and the copy is shown.
- **Retention (R14).** Seed files dated 31 and 29 days ago: only the 31-day files are
  deleted. A path outside the media root is refused.
- **Gates.** `npm run verify` and `npm run build` pass. `codesign -d --entitlements -` on
  the packaged app and on `gs-capture` shows the expected entitlements. `security-review`
  and `gstack-cso` run on the implementation PR (F5).

## Open questions

- **Daily spend cap** in dollars. *Answered by:* James.
- **Model per job.** Proposed: Haiku for batch extraction and Sonnet for the end-of-day
  summary. *Answered by:* James, with costs measured in the spike.
- **Denylist match on window title or browser profile** in addition to bundle ID.
  ScreenCaptureKit can filter windows, but a browser profile isn't a bundle ID. *Answered
  by:* James. v1 proposes bundle ID only.
- **Hours.** Should capture also stop outside set hours? *Answered by:* James.
- **Call-app list for F3.** Proposed: FaceTime, Zoom, Teams, Slack, plus any browser
  holding the mic. *Answered by:* the spike, which checks that detection is reliable.
- **Whisper model size and `SHOT_SEC`.** *Answered by:* the spike, which measures storage
  and CPU.
- **Should Meetings move to disk storage like the Day Recorder?** Deferred to a later
  change. *Answered by:* James.
