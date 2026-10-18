---
change: 2026-10-18-day-recorder
status: accepted
track: T3
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: Day Recorder v1 (Mac Studio)

## Context

Geekspace sees none of the workday's conversations or screens. To-dos, time blocks and
status are entered by hand or lost. The accepted intent and spec define a local-capture,
Claude-reasoning Day Recorder:
- mic, system audio and screenshots, with denylisted apps excluded by ScreenCaptureKit;
- call audio held in memory until James confirms he gave notice;
- whisper.cpp transcription and Vision OCR, both local;
- batched Messages API reasoning under a hard daily cap;
- assistant to-dos and locked time blocks, each with one-click undo;
- Linear updates as drafts only;
- raw media kept 30 days, text kept forever.

Spec R1–R15 and flagged concerns F1–F8 are the contract. This plan orders the work into
small PRs. The first PR is a spike, because several spec claims are explicitly unverified
(F2, F4, F8, the entitlements). Each PR stays well under the review gate's per-file cap
(`DIFF_CAP` = 100,000 bytes per file, `bin/review-pr.sh:435`).

## Order of work (one PR each, in this order)

Every PR follows the same loop:
- branch from `origin/main`
- write the failing test first
- `npm run verify`
- open a forge PR
- post a Codex comment (verbatim, with PASS/FAIL)
- James merges

### PR 1 — Spike: prove the unverified claims (`feat/day-recorder-spike`)

**Build:** a minimal `native/gs-capture/` Swift package, plus `scripts/spike-day-recorder.mjs`.

**Questions the spike answers, each with evidence** (written to
`docs/changes/2026-10-18-day-recorder/spike-findings.md`):
1. **SCK exclusion.** Can an `SCContentFilter` that excludes TextEdit's bundle ID produce
   frames with no TextEdit pixels while TextEdit is visible behind another window? Evidence:
   screenshots.
2. **SCK audio.** Does SCK system-audio capture exclude a denylisted app's audio? Evidence:
   play a tone from TextEdit/QuickTime and measure the captured RMS.
3. **CoreAudio process objects (F2).** Does `kAudioProcessPropertyIsRunningInput` /
   `...Output` report a denylisted app's audio use on macOS (the Mac Studio's version)?
   Measure detection latency.
4. **Call detection (F3).** Can FaceTime, Zoom, Teams, Slack, and a browser on Meet be
   detected reliably from mic-input ownership?
5. **Vision OCR** speed and accuracy on 10 synthetic screenshots.
6. **Storage and CPU** for one hour, at `SHOT_SEC` 15, 30 and 60 with unchanged-frame
   skipping, and at whisper `base.en` vs `small.en`. Extrapolate to 8 hours and 30 days.
7. **Entitlements.** Package a **signed** build with the helper and record the exact
   entitlement and usage-description keys required for screen, audio and process
   monitoring. Prove them with `codesign -d --entitlements -` plus a working capture on
   the signed build.
8. **F4.** Does `ANTHROPIC_API_KEY` in the environment switch the Agent SDK's billing?
   Test with a fresh process and the SDK's own status output, without spending credits.
   Pick the Keychain key name.
9. **F8.** Does `tmutil addexclusion <dir>` work without admin rights, and does
   `tmutil isexcluded` confirm it?
10. **F6.** Is a zero-retention option available on James's API account? (James checks the
    console. Claude reports what the docs say.)

**Gate:** if (1) or (2) fails, stop and re-plan, because F1 depends on them. If (3) fails,
use the F2 headphones fallback and record it under Deviations.

**Output:** findings, settled values for `SHOT_SEC`, the whisper model and the entitlement
keys, and updates to spec.md and plan.md in the same PR.

**Done (2026-10-18):** see `spike-findings.md`. (1) and (3) passed. (2) failed for
Chromium/Electron apps, and James re-planned system audio onto a CoreAudio tap (Deviations).

### PR 2 — Data layer (`feat/day-recorder-data`)

**Files:**
- `convex/schema.ts`: new tables `captureSegments`, `transcripts` (search index on `text`),
  `screenshots` (search index on `ocrText`), `recorderEvents`, `assistantActions`,
  `externalDrafts`, `assistantUsage`; new `settings` fields.
- `convex/dayRecorder.ts`: segment, screenshot and event mutations and queries; argument
  validators at the boundary. Use `convex/lib/predicates.ts` for any schemaless checks.
- `convex/assistant.ts`, covering:
  - `applyActions`, which validates and writes the `assistantActions` row first, then
    acts;
  - task row creation, following the pattern in `convex/rows.ts`;
  - locked `timeBlocks` insert;
  - `undo`, which applies the stored inverse and refuses if the target changed after the
    action;
  - external drafts and approval state;
  - usage and cap queries.
- `convex/search.ts`: `searchAll` includes transcripts and OCR text.
- Regenerate `convex/_generated` against the local backend on :3210, the same procedure as
  PR #64.

**Tests (convex-test, pattern from `tests/meetingsData.test.ts`):**
- `tests/assistantActions.test.ts`: the commitment fixture produces 1 task, 1 locked block
  and 2 actions; `scheduling.reflowNow` keeps the block; undo removes both; undo after an
  edit is refused.
- `tests/dayRecorderData.test.ts`: a call segment can't be inserted without a
  `noticeEventId`; retention selection picks the 31-day items and not the 29-day ones.
- `tests/searchHidden.test.ts`: extend it to cover the new sources.

### PR 3 — Capture runtime (`feat/day-recorder-capture`)

**Files:**
- `native/gs-capture/` in production form:
  - SCK screenshots with the denylist filter, HEIC output, perceptual-hash skipping; the
    filter is rebuilt each frame from ALL apps (`onScreenWindowsOnly: false`), and the
    menu-bar band is blanked while a denylisted app is frontmost (spike Q1);
  - system audio from a CoreAudio process tap that excludes the denylist by bundle ID
    (`<id>` and `<id>.helper`, plus any child-process bundles the watcher reports), with
    `TapAutoStart` off; a tap that delivers no samples fails loudly (spike Q2);
  - Vision OCR, accurate, at point resolution, retried once on a luminance-thresholded copy
    when a frame yields few lines (spike Q5);
  - a process-audio watcher that polls every 100 ms (listeners alone miss mic use on macOS
    27.0) and ignores `replayd`, `avconferenced` and our own processes (spike Q3, Q4);
  - a 10 s timeout on every SCK call, exiting non-zero so the supervisor shows
    "Not recording" (spike Q1);
  - JSON-lines protocol on stdout.
- `scripts/build-gs-capture.mjs`, run by `package`: runs `swiftc` on darwin only, and
  signing is inherited through `extraResources`.
- `electron/dayRecorder.mjs`, the supervisor:
  - spawns the helper, using the error-listener and fast-failure pattern from
    `electron/backendProcess.mjs` (PR #69);
  - a line parser that drops malformed lines and logs them;
  - owns the media root, `<app data>/day-recorder/YYYY-MM-DD/`;
  - the FileVault gate (`fdesetup status`) and the `tmutil addexclusion` check;
  - the purge job, which resolves each path and refuses anything outside the media root;
  - the tray indicator.
- `electron/capture.html` plus `src/capture/micCapture.ts`: a hidden-window `MediaRecorder`
  that is stopped and restarted on the same stream at each `SEGMENT_SEC` boundary, so every
  segment is a complete, independently decodable WebM. Small timeslice chunks stream over
  IPC to the main process for appending within a segment. The silence floor is reused from
  `src/lib/recorder.ts` (export `SILENCE_LEVEL`). The system-audio segments from
  `gs-capture` follow the same rule: one finalized file per segment.
- `electron/main.mjs`: register `gs:dayRecorder:*` through the existing `handle()` with its
  `fromApp` guard.
- `electron/preload.cjs`: the narrow `dayRecorder` namespace from the spec.
  `setApiKey` is write-only.
- `package.json`: `mac.extraResources` gains the helper (electron-builder then signs it with
  `entitlementsInherit`; spike Q7), and `extendInfo` gains a real
  `NSAudioCaptureUsageDescription`. `build/entitlements.mac.plist` needs no new key (spike
  Q7). The helper's deployment target is macOS 26 (bundle-ID taps). Proof includes the tap
  on a clean TCC state, to settle whether it needs its own grant.
- **UI:**
  - `src/components/dayRecorder/` holds the indicator, the Settings section (enable,
    denylist editor, cap, intervals, the FileVault and Time Machine status) and the state
    copy from the spec table;
  - an a11y pass against the spec's checklist.

**Tests:**
- `tests/dayRecorderSupervisor.test.ts`, using a fake helper script (the real child-process
  testing pattern from PR #69):
  - a spawn error surfaces in under 1 s;
  - a helper exit produces "Not recording";
  - malformed lines are dropped;
  - the denylist is passed on argv.
- `tests/dayRecorderPurge.test.ts`: 31 vs 29 days; a path outside the root is refused.
- `tests/micCapture.test.ts`: a segment rolls over at `SEGMENT_SEC`, with stop and restart
  each time; silence raises a warning.
- `scripts/probe-segment-decode.mjs` (`npm run probe:segment-decode`): the **second**
  segment of a two-segment recording decodes and converts to 16 kHz wav through the
  `meetingProcessor.mjs` ffmpeg path, without access to the first segment.
  - This is Codex's PR #70 finding.
  - It is a probe, not a vitest suite, for the same reason as `probe:schema-failure`: a
    suite would silently skip on CI, where there is no ffmpeg. The probe exits non-zero if
    ffmpeg is missing.
  - It runs in PR 3's Proof, and the spike measures the restart gap.

### PR 4 — Call notice and mic pause (`feat/day-recorder-calls`)

- `electron/dayRecorder.mjs`:
  - a call-hold buffer holds memory only, with a cap at `NOTICE_TIMEOUT_MIN` (15) and
    discard on timeout or decline;
  - `noticeGiven` writes the event, then flushes;
  - the mic pauses while the helper reports a denylisted app using audio (or the documented
    fallback, if the spike recorded one).
- UI: the non-modal call prompt with focus management, a visible countdown, one extension,
  and the copy from the spec.
- **Tests** (`tests/callNotice.test.ts`): no notice means zero call segments and zero files;
  told, declined and timeout paths; the mic pauses on a denylisted-audio event.

### PR 5 — Local transcription (`feat/day-recorder-transcribe`)

- Extract a reusable `transcribeFile()` from `electron/meetingProcessor.mjs`. Meetings keeps
  working unchanged, and its existing tests must stay green.
- Add a segment queue in `electron/dayRecorder.mjs`: each closed segment becomes a
  `transcripts` row.
- **Tests:** a queue test with a stubbed whisper. `tests/meetingPipeline.test.ts` stays
  green.

### PR 6 — Assistant (`feat/day-recorder-assistant`)

**Files:**
- Load the `claude-api` skill before writing this code: it covers model IDs, SDK and
  caching.
- `electron/dayAssistant.mjs`:
  - a Messages API client (pick the SDK or plain fetch at that time; a new dependency runs
    through `snyk test`);
  - key from `safeStorage` / Keychain;
  - a `BATCH_MIN` batcher over new text;
  - a zod schema of allowed actions, with anything else rejected and logged;
  - cost accounting into `assistantUsage`, and the hard cap writing `capPaused`;
  - `sendImage(logger, …)`, where the logger is a required parameter and writes `imageSent`
    before the request is made;
  - the end-of-day summary.
- `electron/linearDrafts.mjs`: approval is the only code path that calls Linear. The Linear
  key is also in Keychain.
- **UI:**
  - the review queue (drafts with Approve and Discard);
  - the end-of-day review (actions with labelled Undo);
  - the daily record page, with links to segments and screenshots.

**Tests:**
- `tests/dayAssistant.test.ts`, with a stubbed HTTP client:
  - schema rejection;
  - the cap skips a batch;
  - the image log is written before the request;
  - the TypeScript check fails without a logger (`// @ts-expect-error` test).
- `tests/linearDrafts.test.ts`: no request to `api.linear.app` before approval.
- `security-review` and `gstack-cso` run on this PR (F5), along with Codex.

## Files that change (summary)

- **New:** `native/gs-capture/`, `scripts/build-gs-capture.mjs`,
  `electron/{dayRecorder,dayAssistant,linearDrafts}.mjs`, `electron/capture.html`,
  `src/capture/`, `src/components/dayRecorder/`, `convex/{dayRecorder,assistant}.ts`, and
  the test files listed above.
- **Modified:** `convex/schema.ts`, `convex/search.ts`, `convex/_generated/*`,
  `electron/main.mjs`, `electron/preload.cjs`, `electron/meetingProcessor.mjs` (extraction
  only), `src/lib/recorder.ts` (export the constant only), `package.json`,
  `build/entitlements.mac.plist`.

## Risks

- **SCK or CoreAudio behaviour differs from the docs.** The spike gate in PR 1 stops the
  plan before any production code depends on it.
- **The signed build differs from the dev build** for TCC. Every PR from PR 3 onward that
  touches capture is proven on a signed package, not just `npm run dev`.
- **Swift toolchain only on the Mac.** CI is ubuntu, so CI exercises only the JS side with
  the fake helper. The helper's own proof is the manual signed-build run recorded in the
  PR.
- **Third-party data in a public repo.** Fixtures are synthetic only (`SYNTHETIC` header),
  the media root is outside the repo, and the pre-commit secret and binary scans run on
  every commit.
- **Scope.** Six PRs. If any fix-review loop passes 3–4 rounds, stop and reassess scope
  (lesson L42).

## Proof (becomes VERIFY)

- Per PR: `npm run verify` (oxlint, tsc, vitest), `npm run build`, and `snyk test` when
  dependencies change.
- **PR 1:** `spike-findings.md`, with screenshots and measurements for every question.
- **PR 3 and later, on a signed `npm run package` build:**
  - `codesign -d --entitlements - "dist/mac-arm64/Geekspace.app"` and the same for the
    helper;
  - a 2-hour soak RSS log (helper and capture window each grow less than 50 MB after
    10 minutes);
  - screenshots of the three failure paths: mic unplugged, permission revoked, helper
    killed.
- **PR 4:** a FaceTime test call taken through told, declined and timeout; the media folder
  listing shows no call files for declined or timed-out calls.
- **PR 6:** a network log showing no Linear request before Approve; the `assistantUsage`
  row matching the console's token count for one batch.
- **Final:** one full 8-hour day on the Mac Studio. The daily record links resolve, and the
  purge dry-run count is correct.

## Options not taken

- **Electron `desktopCapturer` only:** it can't exclude a background window, which fails
  F1.
- **Agent SDK for reasoning:** it shares ARCHITECT's credit pool and is hard to cap (intent
  open question 6).
- **Convex `_storage` for media:** screenshot volume and purge cost (intent open
  question 4).
- **Provenance fields instead of an action log:** they can't undo edits (intent open
  question 7).
- **A single large PR:** it would exceed what the review gate and Codex can examine
  meaningfully.

## Deviations
<!-- appended during implementation -->

- **2026-10-18, PR 1, gate (2) tripped → system audio re-planned (James).**
  ScreenCaptureKit's app filter did not exclude audio from Chromium/Electron apps: −15 dBFS
  leaked, 3 of 3 runs, because the audio plays from a windowless helper SCK cannot list. It
  also missed windowless apps and leaked about 150 ms when a denylisted app launched
  mid-stream. James chose to prototype a CoreAudio process tap. Excluding by bundle ID
  (`<id>` + `<id>.helper`, macOS 26+) was silent in every case, including late launches,
  on the signed build. **Change:** PR 3 takes system audio from the tap; SCK keeps
  screenshots. The helper's minimum macOS rises from 14 to 26. That fits v1, which is Mac
  Studio only (macOS 27). F1's intent ("never captured") holds.
- **2026-10-18, PR 1, gate (3) passed; no headphones fallback.** CoreAudio process objects
  report audio use, but only by 100 ms polling on macOS 27.0 (listeners miss the mic).
  PR 4's mic pause and call detector poll.
- **2026-10-18, PR 1, Q4 partly run.** Zoom and a Chromium stand-in were tested. FaceTime,
  Teams and Slack were not, so PR 4's Proof adds one test call each to the existing FaceTime
  call. FaceTime goes through `avconferenced`, which showed mic input with no call active.
- **2026-10-18, PR 1, the spike build used a temporary electron-builder config** (outside the
  repo) to add the helper as an extra resource, and drove the signed binary through
  `ELECTRON_RUN_AS_NODE` so app code was unchanged. PR 3 makes the `extraResources` entry
  permanent.
