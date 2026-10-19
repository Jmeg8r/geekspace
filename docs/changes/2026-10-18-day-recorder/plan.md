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
    (`<id>` and `<id>.helper`, plus any child-process bundles the watcher reports) and by
    live process objects, with `TapAutoStart` off; a tap that delivers no samples fails
    loudly (spike Q2);
  - **first proof obligation:** a second instance of a denylisted app that starts audio
    mid-tap leaked in the spike (27–31 × 100 ms). The watcher must trigger a tap rebuild that
    discards held-back system audio. Prove zero leaked windows with the spike's
    `late-second-instance` scenario before anything else in PR 3 builds on the tap;
  - Vision OCR, accurate, at point resolution, retried once on a luminance-thresholded copy
    when a frame yields few lines (spike Q5);
  - a process-audio watcher that polls every 100 ms (listeners alone miss mic use on macOS
    27.0) and ignores `replayd`, `avconferenced` and our own processes (spike Q3, Q4);
  - a 10 s watchdog on every SCK call that exits the process non-zero, so the supervisor
    shows "Not recording"; a task-group timeout is not enough, because a hung SCK call
    ignores cancellation (spike Q1);
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
  also missed windowless apps and leaked 150–390 ms when a denylisted app launched
  mid-stream. James chose to prototype a CoreAudio process tap. Excluding by bundle ID
  (`<id>` + `<id>.helper`, macOS 26+) plus live process objects was silent for helpers,
  windowless apps, late launches and concurrent instances, including on the signed build.
  One case still leaks: a second instance that starts audio after the tap exists. PR 3
  must close it first (above). **Change:** PR 3 takes system audio from the tap; SCK keeps
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
- **2026-10-18, PR 2, `assistantActions` is a typed union, not `before`/`after` blobs.**
  - v1 actions only *create* things (`createTask`, `createBlock`, `draftLinear`), so undo
    needs what was created and what it looked like then.
  - A `v.any()` blob would add a type-erased dictionary, which the repo's review standards
    reject.
  - Effects of one proposal share a `groupId`: the task's row id, or the draft's id. One
    undo reverses the whole group, and the whole group is checked before anything is
    reversed.
- **2026-10-18, PR 2, "changed since" uses a row fingerprint, not `updatedAt`.**
  - Two writes in the same millisecond would compare equal under `updatedAt`.
  - Instead, a sorted-key fingerprint of title, properties and content is taken *after* the
    reflow (`convex/lib/dayRecorder.ts` `rowFingerprint`).
  - A block counts as changed if its start, end or locked flag differ. A draft counts as
    changed once it is no longer pending.
- **2026-10-18, PR 2, no daily cap set means the assistant does not run.** The cap amount
  is still an open spec question, so `assistant.capStatus` reports `reached: true` until
  James sets one.
- **2026-10-18, PR 2, media paths are stored as `<day>/<file>` relative to the media root.**
  - The boundary rejects absolute paths, `..`, separators within the file name, and a day
    folder that doesn't match the record's own day.
  - So nothing the purge later resolves can point outside the root. PR 3 still re-checks
    the resolved path, as defence in depth.
- **2026-10-18, PR 2, the assistant writes tasks to the oldest visible task-source
  database.** The spec didn't name one. It is the same notion of a task database the
  scheduler uses.
- **2026-10-18, PR 2, Day Recorder settings have their own mutation**
  (`dayRecorder.updateSettings`). `settings.update` re-plans the schedule on every save,
  and none of these settings affect the plan.
- **2026-10-18, PR 2, retention reads through `["purgedAt", time]` indexes.** Segment and
  screenshot rows are kept forever, because the text outlives the media. A time-only scan
  would read the whole purged history on every run.
- **2026-10-18, PR 2, codegen ran against a throwaway local backend.**
  - The backend had an empty temp database on port 3290, the same pattern as
    `probe:schema-failure`, so the dev deployment was never contacted.
  - No backend was running for the PR #64 procedure, and starting `convex dev` would have
    pushed this branch's schema into James's dev data.
- **2026-10-18, PR 3 is split into sub-PRs 3a–3e.** One PR for all of it would recreate
  #71's failure: the forge's AI review stops reading past a large diff, and splitting is
  what got #72 and #73 through. Each sub-PR touches its own files:
  - **3a:** the tap's second-instance leak (this entry).
  - **3b:** the production helper (screenshots, OCR, watchdog, JSON-lines protocol), the
    build script and packaging.
  - **3c:** the supervisor, media root, purge, and the FileVault and Time Machine gates.
  - **3d:** mic capture, IPC and preload, and `probe:segment-decode`.
  - **3e:** the UI and the a11y pass.
- **2026-10-18, PR 3a, the second-instance leak is closed.** `gs-capture tap --rebuild-ms
  100 --hold-ms 500` does two things:
  - It polls the denylisted process objects every 100 ms. When a new one appears, it
    stops IO, **drops every held window**, rebuilds the tap and aggregate around the new
    list, and restarts.
  - It holds each 100 ms window back 500 ms before releasing it.
  - A guard refuses a hold shorter than two polls.
- **Proof** (`node scripts/spike-day-recorder.mjs tap-second-instance`, `--by both`). Each
  run added a positive control: a **non-denylisted** tone (a bare `spike-tone`, so no
  bundle ID) starting 1.5 s after instance 2. That shows the tap still captures after a
  rebuild.

  | Run | Leaked windows before the control | Control windows captured | Rebuild |
  |---|---|---|---|
  | Without the rebuild (control) | **17** | 11 | none |
  | Rebuild, run 1 | **0** | 10 | 6 dropped, 82 ms |
  | Rebuild, run 2 | **0** | 11 | 5 dropped, 99 ms |
  | Rebuild, run 3 | **0** | 10 | 5 dropped, 103 ms |

  - Every run had 0 leaks before instance 2 started, so instance 1 stayed excluded.
  - An earlier control run with no control tone leaked 28 windows. The spike saw 27–31.
  - In every rebuild run the watcher found instance 2's process object 75–82 ms *before*
    its tone logged "started". The hold-back is a margin, not the main defence.
  - The cost is system audio lost during each rebuild (5–6 windows, about 0.5 s, plus the
    rebuild itself). Only a new denylisted process triggers one.
  - Evidence: `spike-evidence/results/pr3a-second-instance-*.json`.
- **2026-10-18, PR 3a, Codex round 1 (2 × P2), both fixed.**
  - **Shutdown tail.** `releaseAll()` emitted the last `--hold-ms` of windows unchecked.
    Shutdown now stops IO, polls once more, and drops the tail (event `tailDropped`) if a
    new denylisted process appeared.
  - **`--by bundle --rebuild-ms` is refused.** Bundle-only mode tracks no process objects,
    so the rebuild could never fire.
  - **Tail proof** (corrected after Codex round 2; see the next entry).
  - **Timing sweeps without `--poll-stop-ms` were dropped.** The real tail window is about
    20 ms, smaller than `open -n` launch jitter (about 300 ms), so most runs fell outside
    it. One unforced hit (3.72 s) also dropped its tail with 0 leaked (seen in run output;
    its result file was not kept).
- **2026-10-18, PR 3a, Codex round 2 (2 × P2), both fixed.**
  - **The round-1 tail proof was weaker than claimed.** Windows kept being released after
    polls stopped, so most of instance 2's audio could leave before the shutdown check
    ran. Under `--poll-stop-ms` nothing is released once polls stop, so the check judges
    the whole unpolled span. Each drop now reports `droppedMaxRms`, which shows directly
    whether the check discarded real audio or silence.
  - **A malformed `--rebuild-ms` (for example `100ms`) silently turned protection off.**
    `--follow-ms` had the same parse, so both now use `Args.optionalDouble`: nil when
    absent, a failure when invalid.
  - **Corrected tail proof:** `--poll-stop-ms 1500`, instance 2 at 2.6 s, so only the
    shutdown check stands between instance 2 and a leak.

    | Run | Leaked | Shutdown check | Loudest dropped window |
    |---|---|---|---|
    | `--tail-check 0`, runs 1–3 | **11**, 0, 0 | off | — |
    | Check on, runs 1–3 | 0, 0, 0 | dropped 21 windows | 0 (silence) |
    | Check on, run 4 | **0** | dropped 21 windows | **0.177 RMS (about −15 dBFS)** |

    - Whether instance 2 leaks at all depends on which of the two live processes the OS's
      bundle-ID exclusion silences, and that varies between runs (it leaked 1 time in 3
      unprotected).
    - Runs 1–3 with the check on dropped silence. Run 4 dropped audible leaked audio at the
      original leak's level and released none of it. That run is the evidence the check
      matters; it is not inferred from zero-leak runs alone.
    - Results: `spike-evidence/results/pr3a-second-instance-tailcheck-*.json`.
