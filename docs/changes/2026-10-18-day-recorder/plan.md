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

  Results below use the corrected leak counter from Codex round 3. Any loud window that does
  not overlap the control tone counts as a leak, before or after the control.

  | Run | Leaked windows | Control windows captured | Rebuild |
  |---|---|---|---|
  | Without the rebuild (control) | **15** | 12 | none |
  | Rebuild, runs 1 and 3 | **0**, **0** | 11, 12 | 6 and 5 dropped |
  | Rebuild, run 2 | **1** | 11 | 5 dropped |
  | Rebuild, diagnostic runs a–l (12 runs) | **0** in every run | captured every run | 5–6 dropped each |

  - **One leaked window in 15 rebuild runs, not attributed.** Run 2 had a single 100 ms
    window above the leak threshold. It predates the per-window detail logging
    (`leakedDetail`), so which audio it held is unknown. Twelve further runs with detail
    logging found no leak.
  - A plausible cause is the control tone's own audio continuing past its logged stop
    because of output latency. That is **unverified**, so it is not recorded as the
    cause.
  - PR 3c's 2-hour soak keeps the detail logging and must attribute any recurrence before
    v1 relies on the tap.
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
- **2026-10-18, PR 3a, Codex round 3 (1 × P2), fixed.** The harness counted a leak only
  *before* the control tone started, so a late leak could read as zero. It now excludes
  just the windows overlapping the control (allowing for the 100 ms window). Codex's repro
  case, a leak at 3900 ms after a 2700–3700 ms control, now counts as a leak. The main
  proof was re-run with this counter; see the table in the PR 3a entry above.
- **2026-10-18, PR 3a, Codex round 4 (1 × P2), fixed. The review loop stops here (L42 cap).**
  The "tap delivered no samples" check counted samples cumulatively, so a rebuilt tap that
  started but delivered nothing passed on the previous session's samples, and capture
  would have gone silent unnoticed. Each session now has its own baseline: a (re)built tap
  must deliver samples within 1 s, or the helper exits non-zero. Regression runs on the
  final binary: the rebuild proof (0 leaked, control captured) and the tail proof (0
  leaked, tail dropped) both passed with the check active.
- **2026-10-18, PR 3a, final Codex check (1 × P2), fixed. It was the same class as round
  4.** A rebuild in the last second could still go unverified: the in-loop check never
  reached its 1 s deadline, and the shutdown check was cumulative. Per L41 (a same-class
  finding means the fix was instance-shaped), the class is fixed: **every session is judged
  when it ends**, at a rebuild or at shutdown.
  - A session that lived at least 200 ms (about 20 IO cycles) and delivered nothing fails
    loudly.
  - A shorter session is reported as `sessionUnverified`, never passed silently.
  - Regression runs passed: rebuild 0 leaked with the control captured; tail 0 leaked with
    the tail dropped.
  - This last commit had no further Codex round, because the loop had reached its cap.
    James reads it in the PR.
- **2026-10-18, PR 3b is split again, into 3b-1 to 3b-3.**
  - **3b-1 (this one):** `gs-capture run` with protocol v1 (`protocol.md`) and the
    screenshot pipeline.
  - **3b-2:** system-audio segments through the tap. Those need real PCM held back and
    dropped, not RMS windows.
  - **3b-3:** process-audio events, the build script, packaging and the signed-build proof.
- **2026-10-18, PR 3b-1, menu-bar ownership comes from `NSWorkspace`.** Probed in a CLI with
  top-level `await`: `menuBarOwningApplication` followed two app switches, so Swift's async
  main delivers the notifications. `CGWindowList`'s topmost window lagged one sample. The
  menu bar is a Window Server window at layer 24, `0,0` 1920×30 points on the Mac Studio.
- **2026-10-18, PR 3b-1, OCR always runs both passes and merges them.** The second pass is
  accurate OCR on a copy binarised at luminance 190. The spike's "retry when few lines"
  needed a threshold to tune; merging doesn't. Fixtures (`pr3b1-ocr-merged.json`), 1x:
  - accurate alone: pooled word recall **0.826**, 107 ms;
  - merged: **0.976**, 226 ms a kept frame (positional merge, after Codex round 1; the
    first string-based merge scored 0.979).
  - A new synthetic `11-settings-mixed` fixture (black and grey labels on `#ececec`) read
    **nothing** in the plain pass, not just the grey lines. So it doesn't show the failure
    the fixture was added for; it shows a whole-frame miss on that background, which
    merging recovers.
- **2026-10-18, PR 3b-1, menu-bar blanking proof** (`run-menubar`, 3 of 3 runs). The run is
  `gs-capture run --denylist com.apple.TextEdit`, with TextEdit frontmost showing the
  canary.
  - **Denylisted:** every frame whose menu bar TextEdit owned had a black band (mean
    luminance 0), no canary in the frame's OCR, and `appBundleId: null`.
  - **Control (no denylist):** the band carried content (luminance 128), TextEdit's
    **Format** menu was read in it, and the canary was in the frame. So both would have
    leaked.
  - **Two pitfalls hit on the way.**
    - `sips --cropOffset` did not crop where asked. The band is now cropped with the
      helper's own `ocr --crop`, and checked by luminance.
    - A visual check of a downscaled frame was misread as "not blanked". The pixel
      measurement (luminance 0.3) is what counts.
  - **Focus moved during runs** (someone was using the Mac). Frames whose menu-bar owner
    wasn't denylisted were rightly left alone, so the proof asserts per frame rather than
    per run.
- **2026-10-18, PR 3b-1, a denylisted app is not named in the shot either.** `appBundleId`
  is `null` while a denylisted app owns the menu bar. This is the conservative choice:
  when a work app was in use is information too.
- **2026-10-18, PR 3b-1, Codex round 1 (1 × P1, 1 × P2), both fixed. Both decisions are
  now pure functions with `swift test` coverage.**
  - **P1: the menu bar could leak during an app switch.** The owner was sampled only
    *before* the capture, so a switch to a denylisted app while the capture was in flight
    left its menus in the frame unblanked. `Run.menuBarDecision` now samples before **and**
    after: if either sample is denylisted the band is blanked and the app is not named.
    When two allowed owners disagree, no app is named either.
  - **P2: the OCR merge changed content.** Deduplicating by string dropped repeated lines
    ("Pending" under two tasks) and appended second-pass lines at the end.
    `OCR.merge` now works by position:
    - a second-pass line is dropped only when it covers a first-pass line (half of the
      smaller box);
    - repeats elsewhere are kept;
    - everything is put in reading order.
  - **Tests** (`native/gs-capture/Tests`, 11 cases, run locally because CI doesn't build
    Swift). A **mutation check** shows they bite:
    - putting the before-only decision back fails exactly the switch-during-capture test;
    - putting the string dedupe back fails 4 of the 5 merge tests.
  - Both live proofs were re-run on the fixed binary: `run-menubar` 3 of 3, and OCR recall
    0.976.
- **2026-10-18, PR 3b-1, Codex round 2 (1 × P1), fixed by closing the class.** Before and
  after samples still miss an **allowed → denylisted → allowed** switch during a capture:
  both say "allowed", yet the frame holds the denylisted app's menus. Ownership can't be
  observed *during* a capture, so the round-1 approach couldn't be made complete.
  - **Fix:** whenever the denylist is non-empty, **every frame's menu bar is blanked.**
  - **Cost:** the menu-bar strip (app menus, clock, status icons), not window content.
  - **App naming:** the app is still named only when both samples agree and neither is
    denylisted.
  - **Tests:** 12 `swift test` cases. A mutation back to endpoint-only blanking fails
    exactly the mid-capture test.
  - **Live proof re-run:** `run-menubar` 3 of 3. Every denylisted-run frame had a black
    band; the control read TextEdit's Format menu and the canary.
- **2026-10-18, PR 3b-1, Codex round 3 (2 × P2), both fixed.**
  - **A shot with no app could not be stored.** PR 2's `addScreenshot` required a bundle-ID
    string. `appBundleId` is now optional in the schema and the mutation, and still validated
    when present. The supervisor omits it for `null` (`protocol.md`). Test first: a no-owner
    shot stores, and an invalid ID is still refused.
  - **A revoked permission could go unnoticed for up to `--shot-sec`.** Each heartbeat now
    makes an authorization check first, through `Screen.content()`: the call every capture
    depends on, with its process-exiting 10 s watchdog. A heartbeat therefore means
    "capture still authorized", not just "process alive".
    - **Unverified:** that the call fails promptly after a *live* revocation. That is part of
      the R3 proof with James at the Mac (PR 3c), not claimed here.
  - **Also fixed, found in the smoke test:** `--duration` overran by up to a whole
    `--shot-sec` (12 s asked, 30 s taken). The wait is now capped at the time remaining.
- **2026-10-19, PR 3b-2, system-audio segments.** `gs-capture run` now writes system audio
  from the tap as segments (`protocol.md`: `segment`, `tapRebuilt`, `tailDropped`,
  `sessionUnverified`, and `--segment-sec`).
  - **The PR 3a loop is shared, not copied.** `TapRunner` (`Tap.swift`) holds the rebuild,
    delivery and tail-check logic. Both `tap` (the proof command) and `run` use it, through
    a `TapSink` protocol: the RMS meter for `tap`, and a `PCMHold` of real mono PCM for
    `run`. The PR 3a proof was re-run on the shared loop with the same result: **0 leaked
    windows in 3 of 3 runs**, control captured every time, 5–6 windows dropped per
    rebuild. The no-rebuild control still leaks (17).
  - **AAC `.m4a`, not Opus.** AVFoundation writes AAC natively and the transcriber's ffmpeg
    path decodes it. Opus in CAF is less reliably handled by ffmpeg. The format is mono at
    32 kbps, about 2.4 MB per 5-minute segment.
  - **A rebuild closes the segment.** Dropped audio becomes a gap *between* segments, so a
    file's own timeline always matches its `[start, end]`, and PR 5's transcript time ranges
    can rely on it.
  - **SIGTERM finalizes.** The supervisor stops the helper with a signal (a denylist change
    is a restart), so the open segment is finalized and announced before exit 0.
  - **For PR 3c (purge):** a crash can leave a hidden `.partial-*.m4a`, and a kill between
    writing and announcing a file leaves a shot or segment with no Convex row. Purge works
    from rows, so it must also sweep files in day folders older than the retention period.
  - **Proof** (`node scripts/spike-day-recorder.mjs run-segments`, 3 runs):
    - SpikeTone (denylisted, 440 Hz) plays throughout. A second instance starts at 2 s and
      forces a rebuild, a non-denylisted 660 Hz control plays at 3.5 s, and SIGTERM comes
      at 9 s with 3 s segments.
    - Every segment is converted alone through the transcriber's exact ffmpeg call
      (`meetingProcessor.mjs`, 16 kHz mono wav).
    - Each 100 ms window is then measured with a Hann-windowed Goertzel at 440 Hz and 660 Hz.

    | Run | Tonal 440 Hz windows (leak) | Control windows | Segments | Rebuild dropped | Stop |
    |---|---|---|---|---|---|
    | 1–3 | **0**, **0**, **0** | 21 each | 4 each | 6 windows, silent | `signal`, no partials |
    | Negative control, nothing denylisted | **88** (fails, exit 1) | 21 | 4 | none | `signal` |

    - **The leak gate was tightened after the first run, and here is why.** The first run
      flagged 2 windows at 440 Hz (0.004 and 0.0025). Both were within 30 ms of the control
      tone's start and stop. The same windows read *higher* at 370 Hz and 520 Hz, which
      neither tone uses, and the windows next to them read 0 at 440 Hz. That is the
      broadband click of a gated sine.
    - A window now counts as a leak only if 440 Hz is more than 3 × the louder reference
      band. Excluded windows are still recorded (`broadband` in the result). The negative
      control shows the gate is not blind.
    - The 3b-1 `run-menubar` proof still passes with audio running.
    - `swift test`: 20 tests, including an AAC round trip in which each segment decodes
      alone.
    - Evidence: `spike-evidence/results/pr3b2-run-segments-*.json` and
      `pr3a-second-instance-rebuild-3b2-*.json`.
  - **Not covered here:** memory over 8 hours (R2) is PR 3c's 2-hour soak. Changing the
    default output device mid-run (headphones plugged in) is not tested live. The
    aggregate is built on the output device found at start (but see Codex round 1 below).
- **2026-10-19, PR 3b-2, Codex round 1 (3 × P2), all fixed.** The gate passed, but each
  finding was a real gap in the long-running path.
  - **Delivery that stopped after it started went unnoticed.** The check covered only the
    first second after a (re)build, and the screenshot heartbeat kept running. `TapRunner`
    now fails when the sample count has not advanced for 1 s at *any* point. The check is
    shared, so `tap` gets it too.
  - **A pause in delivery was joined into one segment.** `end` is start plus samples, so
    audio resumed after sleep would have been stamped too early. A chunk more than 500 ms
    from where the segment's samples end now closes the segment. Test first: a 1 h pause
    gives two segments with the right times. Disabling the check fails that test (mutation
    run).
  - **A rebuilt tap at a new sample rate would have been written at the old rate.** After a
    rebuild the hold is empty and the segment closed (the drop does both), so the hold and
    the writer are retuned there and `sampleRateChanged` is reported. Both refuse a retune
    with anything held or open.
  - **Re-proof after the fixes:** `run-segments` 3 of 3 (0 leaks, 21 control windows, 4
    segments each), the PR 3a proof once (0 leaked, control heard in 7 windows) and
    `swift test` (24 tests). The stall check is **not** proven live, because that would
    need an output device unplugged mid-run. It is PR 3c soak material.
- **2026-10-19, PR 3b-2, Codex round 2 was untagged; round 3 ran tagged (1 × P1, 1 × P2), both fixed.**
  Round 3 used the `codex exec` custom-instructions path, which requires a severity tag on
  every finding.
  - **P1: a denylisted process that starts, plays and exits between two polls was never
    seen.** A poll compares only live processes, so the held audio was released and written.
    This gap was present in PR 3a's design as well.
    - **Fix:** `ProcessArrivals` (`Tap.swift`) listens for HAL process-list notifications
      and classifies each added object at once, while its pid and bundle ID can still be
      read. A denylisted arrival forces `TapRunner` to drop and rebuild on the next tick,
      before the caller releases. An arrival also forces a tail drop at stop. An added
      object whose pid is already unreadable counts as denylisted. The listener is off when
      the denylist is empty.
    - **Measured, and why a heuristic was removed:** the HAL sends every list notification
      **twice**, about 1 ms apart. A first version treated "nothing added or removed" as an
      object that came and went. With the duplicates, that produced 3 spurious rebuilds in
      every run, each costing held audio. That rule is gone.
    - **Residual:** an object added *and* removed inside the handler's ~1 ms read latency
      leaves no trace. It would have had to produce audio in that time.
    - **Proof** (`tap-transient-instance`): polls 2.5 s apart. Instance 2 plays for 0.4 s and
      then **exits** (SpikeTone's new `linger` argument is set to 0), about 1.1 s before the
      next poll. That is checked from its own `exiting` log and from its pid being gone.
      - The first attempt was invalid: SpikeTone lingers 2 s after its audio stops by
        default, so a poll caught the still-live process.
      - Control (`--listen 0`): **5 windows leaked**, no rebuild.
      - Listener: **0 leaked in 3 of 3 runs**, one rebuild each, triggered by the listener,
        dropping silence. The listener fired before the tone played.
      - A window ending 103–128 ms after the *control* tone's logged stop appeared in 3 of 8
        tap runs, including a listener-off one. That is the control's output tail. This
        proof counts windows within 150 ms after the control stops as `controlTail` and
        reports them, not as a leak. The 3a counter is unchanged.
    - **Re-run on the listener:** `run-segments` 3 of 3 (0 leaks, rebuild by `listener`),
      the PR 3a proof (0 leaked) and `swift test` (24 tests).
  - **P2: a line could follow `stopped`.** The shot loop and heartbeat keep running during
    shutdown. `stopped` is now written as the terminal line: `emit` refuses every line after
    it under the same output lock, so a line in progress finishes first. A shot written but
    not announced in that window is an orphan file, covered by the PR 3c sweep noted above.
    `run-segments` asserts the last line is `stopped/signal` (3 of 3).
- **2026-10-19, PR 3b-2, Codex round 4 (tagged, 2 × P1), both fixed.** Both were races in
  the round-3 listener.
  - **Audio could pass the hold while `tick` blocked.** The release used the time *after*
    `tick` had checked arrivals. A flag raised while `tick` blocked (for example writing
    `tapRebuilt` to a full pipe) could miss audio that had meanwhile become old enough to
    release.
    - **Fix:** the release boundary is taken **before** the arrival check, in both `run`
      and `tap`. A later flag belongs to a process added after that moment, so none of its
      audio is old enough. A slow tick now delays a release; it never widens one.
  - **A process exiting mid-classification read as allowed.** `Tap.denylisted` answers a
    yes/no question, so an unreadable bundle ID or parent became "no".
    - **Fix:** the listener now uses `Tap.classify`, which returns `denylisted`, `allowed`
      or `unreadable`, with every property read status-checked (`ProcWatch.checkedPid` and
      `checkedBundleID`). An unreadable result is flagged and forces a drop.
    - A parent that is not an app (launchd, a shell) is `allowed`, not `unreadable`.
      Measured: the bundle-less control tone caused no extra rebuild in any run.
  - **Re-proof:**
    - `tap-transient-instance`: control **5 leaked**; listener **0 in 3 of 3**, one
      listener rebuild each.
    - `run-segments`: 3 of 3, 0 leaks, 21 control windows, last line `stopped/signal`.
    - PR 3a proof: 0 leaked.
    - `swift test`: 28 tests (4 new classification cases).
- **2026-10-19, PR 3b-2, Codex round 5 (tagged, 2 × P1, 1 × P2): the listener moves to a
  follow-up PR (James).**
  - Both P1s were the same class as round 4: races inside the `ProcessArrivals` listener.
    - Classification still in flight on its queue when audio is released.
    - A parent that exits mid-lookup reads as a non-app parent.
  - Two rounds of same-class findings point to a design that needs its own review, so the
    review loop stopped (L42 cap).
  - **What moves:** `ProcessArrivals`, its tri-state classification, the
    `tap-transient-instance` proof and SpikeTone's `linger` argument. They move to
    `feat/day-recorder-arrivals`, which starts by reverting the removal commit, plus a
    redesign of the release cap. For example: release only up to the time the arrivals
    queue last *finished* classifying, minus the hold.
  - **What PR 3b-2 keeps:**
    - poll-only detection, as proven in PR 3a;
    - the release boundary taken before the poll (round 4; correct ordering without the
      listener too);
    - the terminal `stopped` line (round 3);
    - the round-5 P2 fix below.
  - **OPEN RISK, accepted until the follow-up merges:** a denylisted process (a second
    instance or a helper) that **starts, plays and exits between two 100 ms polls** has its
    held audio released and written.
    - The `tap-transient-instance` control reproduced it: 5 leaked windows, with polls 2.5 s
      apart.
    - The same gap exists on `main` since PR 3a. It is not new here.
    - **Exposure:** the process must live under 100 ms of poll interval plus whatever part
      of the 500 ms hold had not yet passed. A process that is still alive at the next poll
      is caught and its held audio dropped (PR 3a proof).
    - **Not acceptable for v1.** The follow-up must merge before PR 3c's soak is counted as
      evidence for R4.
  - **P2, fixed: signal handling now comes before `ready`.** Before this, a SIGTERM sent
    just after `ready` hit the default disposition and ended with no `stopped`. Handlers are
    installed first now. A stop during startup has no recorder to stop, and nothing to lose,
    because the first segment needs the 500 ms hold to pass.
    - **Probe:** SIGTERM sent the instant `ready` appears, **5 of 5:** `ready`, `stopped`,
      exit 0.
    - A signal *before* `ready` can still arrive during process startup (exit 143, no
      lines). `protocol.md` says so.
- **2026-10-19, `feat/day-recorder-arrivals` (follow-up to PR 3b-2): the listener's redesign.**
  This branch reverts the removal commit, so `ProcessArrivals` and the
  `tap-transient-instance` proof are back as they stood at round 4. It closes the OPEN RISK
  above. **Not ready to merge.** Codex round 5's two P1s are still open here:
  - **Release can pass classification still in flight.** `tick` reads only published flags;
    `changed()` publishes after classifying every added object. Planned fix: the arrivals
    queue stamps when it last *finished* a pass, and release is capped at that stamp minus
    the hold. A stalled classifier then holds audio back instead of letting it through.
  - **A parent that exits mid-lookup reads as a non-app parent (allowed).** Planned fix:
    re-check the parent pid after resolving it, and return `unreadable` if it is gone.
  - Proof plan: the existing transient proof (control must leak, listener 0 in 3 of 3),
    plus unit tests for the release cap and the parent re-check. Then a tagged Codex round.
- **2026-10-19, PR 3b-2, Codex round 6 (tagged, 0 × P1, 1 × P2): gate passed; the P2 is fixed.**
  - The finding: the `run-segments` negative control (`GS_RUN_DENYLIST=""`) exited 1 on the
    "no rebuild" assertion *before* its leak check ran. Its exit code therefore did not prove
    the detector.
  - The fix: the rebuild is required only when something is denylisted.
  - Re-run: the negative control now fails on the leak check, **"89 window(s) carried the
    denylisted tone"**, exit 1. A normal run passes: 0 leaks, 21 control windows, 4
    segments, `stopped/signal`.
- **2026-10-19, `feat/day-recorder-arrivals`: both round-5 P1s fixed by redesign, not by patch.**
  - **Release is capped at the last *completed* classification pass.**
    - `ProcessArrivals` stamps each pass with its start time (`checkedThrough`). The stamp
      is published together with that pass's flags, under one lock.
    - `TapRunner.tick` now *returns* the release limit. It reads the limit at entry, before
      it takes flags, so every flag behind the limit has been acted on before the caller
      releases. Both callers (`run`, `tap`) release against it. The ordering lives in one
      place.
    - Each tick also requests a pass, so the limit advances when nothing notifies. At most
      one is queued.
    - A classifier stalled for 5 s fails the run (spec R3), rather than holding without
      bound.
    - **Result:** a slow or stuck classifier now delays audio. It can no longer let audio
      through.
  - **A parent that has exited reads as `unreadable`.** After the app lookup returns no
    bundle ID, the parent's liveness is checked with `kill(pid, 0)`. If it is alive now, it
    was alive during the lookup, so "not an app" is real. If it is gone, it is unknown, and
    unknown is dropped.
  - **Unit tests (32):**
    - a pass publishes its flags with its limit;
    - a stalled pass holds the limit back and shows no flag;
    - unreadable arrivals are flagged;
    - an exited parent is `unreadable`.
    - Mutation check: with the limit taken from the wall clock, both cap tests fail.
  - **Live proof of the race** (`GS_TRANSIENT=slow-classifier`): polls every 700 ms, a
    1.5 s hold, a 0.1 s second instance, and every classification slowed to 2.2 s with the
    proof-only `--classify-delay-ms`.

    | Run | Leaked | Rebuild dropped |
    |---|---|---|
    | Control, release by the clock (`--release-cap 0`) | **2** (115 and 221 ms after start) | silence |
    | Capped, 3 of 3 | **0, 0, 0** | **loud audio** (0.15–0.17 RMS): the cap held instance 2's tone until its flag |

    - Every capped run flagged instance 2 as `unclassified`. After 2.2 s it had exited, so
      the fail-closed path was exercised too.
    - Runs where instance 2 met a poll are rejected by the harness and re-run.
  - **Regression:** the fast transient proof (control 5 leaked, listener 0), `run-segments`
    (0 leaks, rebuild by `listener`, `stopped/signal`) and the PR 3a proof (0 leaked).
  - The residual is unchanged: an object added and removed inside the ~1 ms handler read
    latency leaves no trace.
- **2026-10-19, `feat/day-recorder-arrivals`, Codex #78 round 1 (1 × P1, 1 × P2), both fixed.**
  - **P1: a slow judgement blinded observation.** Snapshots and classification shared one
    serial queue. While an allowed process A was being judged, a denylisted B could start
    and exit unseen, and the next snapshot moved the limit past it.
    - **Fix:** the two are split.
      - The HAL handler's queue only *snapshots*: the list, and each new object's pid,
        bundle and parent, read while it lives (`Tap.identity`).
      - A second serial queue *judges* (`Tap.judge`: the parent's app lookup and liveness).
      - Each observed arrival is a ticket bounded by the previous snapshot's start. Release
        is capped at the oldest outstanding ticket, or the last snapshot's start.
      - A ticket leaves under the lock that publishes its flag.
  - **P2: shutdown could hang on a stuck judgement.** Stopping cancels the tick, and with it
    the stall check, before `finish` waited on the listener.
    - **Fix:** `settle(timeoutMs: 5000)` runs one more snapshot and waits for the judge
      queue to drain, with its own deadline. Past it, the tail is dropped as `unjudged` and
      never released. Shutdown then completes normally.
  - **Unit tests (34):**
    - B living entirely during A's stuck judgement is still flagged;
    - a slow judgement holds the limit at its arrival's bound while snapshots keep going;
    - `settle` gives up on a stuck judgement;
    - an already-gone arrival is flagged without judgement.
    - Mutation check: judging on the snapshot queue again (the old design) fails the B test.
  - **Live proof** (`GS_TRANSIENT=b-during-a`): the slow-classifier timing, plus A, a silent
    allowed process (SpikeTone at 0 Hz, so the RMS meter can't mistake it for a leak). B
    starts about 300 ms after A, and the harness checks that B exits inside A's 2.2 s
    judgement and before the next poll.

    | Run | Leaked | Rebuild |
    |---|---|---|
    | Control: the previous binary `d00a65d` (one queue) | **2** | **none**: B was never observed |
    | New, 3 of 3 | **0, 0, 0** | by the listener, on B's own bundle ID; dropped B's tone (0.18 RMS) |

    - **Cost, visible in the proof:** B's judgement waited behind A's 2.2 s one, so its
      drop landed while the control tone played and discarded it too. The control was heard
      in 2 windows, not the usual 11. A drop discards everything held. With real
      (sub-millisecond) judgements that window is tiny.
  - **Shutdown deadline, live:** an allowed arrival 0.6 s before the end, with judgement
    slowed to 7 s. The helper waited 5 s, reported `tailDropped` with `unjudged: true` (12
    windows), wrote its summary and exited 0.
  - **Regression:** slow-classifier capped (0 leaked), fast transient (control 5, listener
    0), `run-segments` (0 leaks, `stopped/signal`), PR 3a proof (0 leaked), `npm run
    verify` (39 files, 343 tests).
  - Evidence: `pr78-b-during-a.json` and `pr78-shutdown-unjudged-tail.json` (see the
    bundle index below).
- **2026-10-19, `feat/day-recorder-arrivals`, Codex #78 round 2 (1 × P1, 1 × P2), both fixed.**
  - **P1: an `unreadable` helper was dropped once and then captured.** Take a helper with no
    bundle ID whose denylisted parent exits before its judgement. It is judged `unreadable`
    and its held audio is dropped. But the rebuild's exclusion came only from a re-poll,
    which can no longer tie the orphan to the denylist, and the snapshot already counts it
    as known.
    - **Fix (the class, not the instance):** verdicts carry their object
      (`ProcessArrivals.Flag`). Every object judged denylisted or unreadable joins a
      `denied` set, which is pruned when the object leaves the list. Every exclusion is now
      `TapRunner.exclusion(polled:denied:)`, at build, at each rebuild check and at the
      shutdown tail. Whatever produced the verdict, the object stays excluded while it lives.
    - **Unit test:** a helper whose parent exits before judgement stays in `deniedLive`
      across snapshots and leaves it only when it leaves the list. Mutation check: without
      recording `unreadable` in `denied`, the test fails.
    - **Live proof** (`tap-orphan-helper`, with SpikeTone's new `spawn-child` mode):
      - SpikeTone (denylisted) starts a bare child tone. The child is playing before the
        parent exits (checked from the log), then plays on as an orphan for about 4.6 s.
      - Judgement is slowed to 2.2 s, so the child is judged after its parent is gone.
      - A non-denylisted control plays after the child stops.

      | Run | Leaked | Listener rebuild excluded |
      |---|---|---|
      | Control: the previous binary `b746be6` | **31** (from 1.7 s after the parent exits) | **0** processes |
      | Fixed, 3 of 3 | **0, 0, 0** | **1** process (the orphan) |

  - **P2: the transient proof judged "between polls" against a computed schedule.** Polls
    are rescheduled from each tick, and a listener check resets them. Run `new-2` of the
    b-during-a proof had a poll-triggered rebuild during B's life and was wrongly counted.
    - **Fix:** a run is rejected when any `tapRebuilt` with `trigger: poll` names the tone's
      bundle, meaning a real poll saw instance 2. The computed-schedule check is gone, and
      the old b-during-a "new" evidence was deleted and re-run.
    - **Re-run** under the gate: **3 valid of 3 tries, 0 rejected.** A poll saw B in none of
      them. 0 leaks. The only rebuild in each is the listener's, which drops B's tone
      (0.18 RMS). The `d00a65d` control passes the gate too: it has no rebuild at all.
  - **Regression on this build:**
    - slow-classifier capped: 0 leaked;
    - fast transient: control 5, listener 0, no poll saw instance 2;
    - `run-segments`: 0 leaks, `stopped/signal`;
    - `npm run verify`: 39 files, 343 tests;
    - `swift test`: 36 tests.
    - **PR 3a proof: 3 runs, 0 / 0 / 1 leaked.** The one window ended 105 ms after the
      control tone's logged stop (0.065 RMS), inside the 103–128 ms control-tail band
      measured on this tap. The 3a counter deliberately has no tail allowance, so it can't
      tell the two apart. It is the same pattern as PR 3a's unattributed run 2. Recorded as
      **likely the control's output tail, not proven**. PR 3c's soak keeps the detail
      logging.
- **2026-10-20, `feat/day-recorder-arrivals`, Codex #78 round 3 (1 × P1, 2 × P2): the class is fixed.**
  - **The P1 was the same class as round 2, and my round-2 fix covered only one instance of
    it.** Exclusion was sticky only for what the *listener* had judged. A helper excluded by
    the **initial poll** (playing under a live denylisted parent when the tap started) was
    never judged. Once its parent exited, an unrelated rebuild re-polled it out of the
    exclusion.
    - **The class fix:** `TapRunner.exclusion = poll ∪ denied ∪ (previous exclusion ∩
      alive)`. Once an object is excluded by **any** path, it stays excluded until it leaves
      the process list. A rebuild can only add exclusions.
    - **Unit test:** an object excluded before stays excluded while alive, and leaves the
      exclusion when it leaves the list. 37 tests in all.
    - **Live proof** (`GS_ORPHAN=baseline tap-orphan-helper`): the child is already playing
      under a parent that lives 2 s when the tap starts. The parent exits. Then an unrelated
      short denylisted instance forces a rebuild. Normal judgement speed.

      | Run | Leaked | Decisive rebuild kept the child excluded |
      |---|---|---|
      | Control: previous binary `db5b2ff` | **20** (from 1.5 s after the parent exits) | no (it re-polled the orphan out) |
      | Fixed, 3 valid | **0, 0, 0** | yes (the child's pid is in `excludedPids`) |

      Two attempts were rejected by the scenario's own preconditions and re-run: one fixed
      run where the tap started outside the parent's life, and one control run with missing
      log events.
  - **P2: the poll gate could be fooled by a mixed listener/poll rebuild.** `tapRebuilt` now
    records `pollDue`, `addedBundles` read *before* the rebuild, and `excludedPids`. The
    transient proof rejects any run where a due poll's additions name the tone.
    - b-during-a re-run under that gate: **3 valid, 0 rejected, 0 leaks.** In each run the
      only rebuild is the listener's (`pollDue: false`).
  - **P2: the orphan proof did not require its decisive rebuild.** Both variants now require
    a rebuild after the parent exits and before the child stops, and that it still excludes
    the child's pid (arrival variant: the listener's `unclassified` rebuild).
    - Arrival variant re-run: **3 of 3**, 0 leaks, decisive rebuild present and excluding
      the child. The old arrival-variant evidence was replaced.
  - **Regression on this build:**
    - slow-classifier capped: 0 leaked;
    - fast transient: control 5, listener 0;
    - `run-segments`: 0 leaks, `stopped/signal`;
    - PR 3a proof: **0 / 0 / 0**;
    - shutdown deadline: `tailDropped` with `unjudged`, exit 0;
    - `npm run verify`: 39 files, 343 tests.
- **2026-10-20, `feat/day-recorder-arrivals`: the evidence is bundled, one file per proof.**
  - **Why:** the forge's AI review read 8 of the PR's 33 changed files and failed closed. 25
    of the 33 were per-run evidence JSON.
  - **What changed:** each run is now stored verbatim inside one file per proof, labelled with
    the commit it was recorded in (from `git log`) and, for a control, the helper binary that
    produced it. All 25 runs were checked equal to their source files before the sources were
    removed (a positive control showed the check reports a mismatch). PR 3b-2's own
    `pr3a-second-instance-rebuild-3b2-*.json` and `pr3b2-run-segments-1.json` are restored to
    their state on `main`, and this branch's re-runs of them live in the bundles.
  - **Bundle index** (`spike-evidence/results/`):

    | File | Runs |
    |---|---|
    | `pr78-b-during-a.json` | control from the previous binary `d00a65d`, 3 fixed |
    | `pr78-orphan-helper.json` | arrival: control from `b746be6`, 3 fixed; baseline: control from `db5b2ff`, 3 fixed |
    | `pr78-transient-instance.json` | listener-off control, 3 listener |
    | `pr78-slow-classifier.json` | uncapped control, 3 capped |
    | `pr78-run-segments.json` | 1 |
    | `pr78-3a-second-instance.json` | 3 |
    | `pr78-shutdown-unjudged-tail.json` | 1, the helper's output lines and exit code |
- **2026-10-20, PR 3b-3: `audioUse` events, the build script, packaging, and the signed-build proof.**
  - **`audioUse`** (`AudioUse.swift`, `protocol.md`) is polled every 100 ms on the audio
    control queue (spike Q3), for PR 4's mic pause (F2) and call detection (F3).
    - **Denylisted apps are never named.** They are folded into one `app: null,
      denylisted: true` entry, by the same rule as `shot.appBundleId`.
    - **"Denylisted" includes the tap's current exclusion**, so a helper orphaned from a
      denylisted app (PR #78) pauses the mic too. F2 and the tap can't disagree.
    - **Ignored:** `replayd` and `avconferenced` (our own capture, Q3/Q4), the helper
      itself, and the supervisor with its children.
    - **Found while documenting:** `tapRebuilt`/`tailDropped` name denylisted bundles in
      their diagnostic fields. `protocol.md` now says the supervisor must not store or log
      them (a **PR 3c** requirement).
  - **Build and packaging:**
    - `scripts/build-gs-capture.mjs` (`npm run build:gs-capture`, run by `package`) does a
      release `swift build` on macOS, fails loudly if the binary is missing, and skips
      with a message on other platforms.
    - `mac.extraResources` ships it as `Contents/Resources/gs-capture`.
    - `extendInfo` gains a real `NSAudioCaptureUsageDescription`.
    - The helper's deployment target is now **macOS 26** (bundle-ID taps), and two
      always-true `#available` checks are gone.
    - `tests/dayRecorderPackaging.test.ts` checks the packaging config. A missing helper or a
      generic usage string only shows on end-user machines.
  - **Proof:**
    - `swift test`: 41 tests, 4 of them new for `audioUse`.
    - `run-audio-use`, **3 of 3**: the allowed app is named on start and stop. The
      denylisted one appears only anonymously, and its ID is in no `audioUse` line (the gate
      compares whole values, with a positive control). Latency was −17 to +84 ms.
    - **Signed `npm run package`:** `codesign --verify --deep --strict` passes. The bundled
      helper is signed with Hardened Runtime, team `Z4CHD4858S`, and the app's **five
      inherited entitlements**, the same set spike Q7 settled; nothing new is needed. Its
      minimum OS is 26.0, and the real usage string is in the Info.plist.
    - **`signed-run`** runs the bundled helper from inside the signed app, with Geekspace as
      the TCC-responsible process (`scripts/spike/signed-run.cjs`, the spike's Q7 method
      now kept in the repo). **3 runs, all exit 0, ending `stopped`.** Frames were kept,
      segments convert through the transcriber's ffmpeg call, and `audioUse` names the
      allowed app and keeps the denylisted one anonymous.
    - Evidence: `pr3b3-run-audio-use.json` and `pr3b3-signed-build.json`.
  - **Observed twice, cause unverified: the first OCR after every fresh package takes about
    35 s** (35.3 s and 35.8 s, on two separately signed packages). Every later frame took
    440–620 ms. It is tied to the first run of each new build, and the cause (a Vision model
    load for the new code identity, perhaps) is not proven. **In practice, capture would
    stall for about 35 s after every app update.**
    - OCR runs synchronously in the capture loop, so a slow OCR stalls screenshots, and
      `--duration` overran to 35.8 s.
    - **For PR 3c:** consider moving OCR off the capture loop, and watch first-launch OCR
      time in the soak.
  - **Still open (needs James at the Mac):** the clean-TCC-state proof (a new macOS user),
    to settle whether the tap needs its own grant (spike Q7). This Mac already has
    Geekspace's grants from the spike. The proofs above show the packaged helper works
    under them, not on a fresh install.
- **2026-10-20, PR 3b-3, Codex round 1 (1 × P1, 1 × P2), both fixed.**
  - **P1: a child with its own bundle ID under a denylisted parent could be named.**
    `audioUse` checked the parent only when the child was not an app itself.
    - **Fix:** `AudioUse.isDenylisted` is now a pure, tested function: the tap's exclusion
      plus the listener's denied set (`TapRunner.knownDenied`), or the process's bundle, its
      app, or its **parent's app** matches the denylist.
    - **Measured before choosing fail-closed:** 6 of 37 live process objects
      (`systemsoundserverd`, `mediaremoted`, `audiomxd`, …) are other users' daemons whose
      parent is unreadable. Treating an unreadable parent as denylisted would pause the mic
      on every alert sound. So an unreadable parent is not denylisted, and a process that
      is unreadable because it has exited is skipped. A daemon can't be a child of a user's
      denylisted app. A live orphan reads launchd as its parent and is covered by the
      tap's and the listener's denied sets.
    - Tests: 44, including the child, orphan and daemon cases. Mutation check: without the
      parent clause, the child test fails.
  - **P2: `signed-run` checked only that an anonymous event existed.** Both proofs now share
    `audioUse` violation checking over every line: no whole value is the denylisted ID
    or `<id>.…`, and every denylisted line has a null app. Codex's mixed sequence is
    rejected.
  - **Re-proof:** `run-audio-use` 3 of 3, 0 violations. A fresh signed package passes
    `codesign --verify --deep --strict`, and the helper's entitlements equal the app's.
    `signed-run` 3 of 3, exit 0, 0 violations.
- **2026-10-20, PR 3b-3, Codex round 2 (0 × P1, 1 × P2): gate passed; the P2 is fixed.**
  - **The finding:** the daemon exemption covered only `audioUse`'s own check. A system
    daemon *arriving after the baseline* went through PR #78's arrival classification. There
    an unreadable parent means `unreadable`, so the daemon was **denied**. The tap then
    excluded its audio, and through `knownDenied()` `audioUse` folded it in anyway.
  - **The fix, in the shared path:** `Tap.identity` records `otherUser` when a process's
    parent can't be read but the process is alive. `Tap.classify` judges such a process by
    its own bundle only. Unreadable *because it is gone* stays `unreadable` (fail closed),
    and #78's orphan path (a parent that dies after the snapshot) is unchanged.
  - Tests: 46, including a daemon arriving after the baseline that must not reach `denied`.
    Mutation check: without the `otherUser` branch, both new tests fail.
  - **Regression on this build (dev):** `run-audio-use` (0 violations), orphan arrival and
    baseline (0 leaked, decisive rebuild kept the child excluded; one attempt rejected by
    its own precondition and re-run), b-during-a (0 leaked), `run-segments` (0 leaked),
    `npm run verify` (40 files, 348 tests).
  - **Not re-run:** the signed package. The signed-build proof above was taken at `8e6c619`.
    This change is classification logic only, with no packaging or signing change, so it was
    proven on the dev build.
- **2026-10-20, PR 3b-3, Codex round 3 (1 × P1), fixed across its class.**
  - **The finding:** the round-2 `otherUser` test used `kill(pid, 0)`, which **succeeds for
    a zombie** (exited, not yet reaped). A denylisted app's short-lived child that exited
    mid-classification could therefore be judged another user's process, and `allowed`.
  - **Measured before fixing:** `proc_pidinfo` fails with **EPERM** for every unreadable
    live object here (5 daemons) and with **ESRCH** for a zombie, while `kill(pid, 0)`
    succeeds on that zombie.
  - **The same weakness had a second instance:** the orphan rule's `parentAlive` also used
    `kill`, so a denylisted parent that had exited but was not yet reaped counted as alive,
    and its orphan read as `allowed`.
  - **Fix, for the whole class:** one `Tap.lookup` (`proc_pidinfo`) returns `parent`,
    `otherUser` (EPERM only) or `gone` (ESRCH, zombies included). Liveness, `otherUser` and
    `audioUse`'s skip all come from it. `kill(pid, 0)` is no longer used.
  - Tests: 48. One test spawns a **real zombie** and asserts it reads as gone, while
    `kill(pid, 0)` succeeds on it. Mutation check: with `kill`-based liveness, it fails.
  - **Regression (dev build):** `run-audio-use` (0 violations), orphan arrival and baseline
    (0 leaked, child excluded), b-during-a (0 leaked), `run-segments` (0 leaked),
    `npm run verify` (40 files, 348 tests).

