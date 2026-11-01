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
  - **Observed three times, cause unverified: the first OCR after every fresh package takes
    about 35 s** (35.3 s, 35.8 s and 36.6 s, on three separately signed packages). Every later frame took
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
- **2026-10-20, PR 3b-3, Codex round 4 (1 × P1), fixed; the review loop pauses at the cap.**
  - **The finding:** `audioUse.poll` called `Tap.lookup` and then `Tap.parentPid`, a second
    lookup. If the child exited in between, a readable denylisted parent was thrown away
    (TOCTOU).
  - **Fix:** one lookup per process, with the parent derived from it. No other site reads
    process state twice: `Tap.identity` and the poll's rule read once, and `parentAlive` is a
    deliberate later re-check.
  - 48 tests, `run-audio-use` (0 violations), `npm run verify` (40 files, 348 tests).
  - **Rounds 1–4 each found a real race or rule gap in reading process state** (parent
    check, daemon exemption, zombie liveness, double lookup). Round 4 is the top of the
    3–4 round cap (L42), so the next step is James's decision, not a fifth round by default.
- **2026-10-20, PR 3b-3, Codex round 5 (final): GATE PASS, `[P2] none`, on `6a8f9fb`.**
  - The signed package was rebuilt from a clean tree at `6a8f9fb`. `codesign --verify --deep
    --strict` passes. The helper is signed with the runtime flag, team `Z4CHD4858S`, and
    entitlements equal to the app's, with minimum OS 26.0. No Swift source is newer than
    the bundled build.
  - `signed-run`: **3 of 3**, exit 0, 0 anonymity violations, ending `stopped`. The first
    OCR took 36.6 s again.
  - Evidence: `pr3b3-signed-build.json` (built from `6a8f9fb`).
  - This commit changes only docs and evidence. The code is exactly what round 5 reviewed.

- **2026-10-20, PR 3c (part 1), the supervisor, service, gates and purge.** This part covers
  the JS side of 3c. The proofs that need James at the Mac come in the next part (below).
  - **Files:**
    - `electron/dayRecorder.mjs`: the supervisor, built against `protocol.md`.
    - `electron/dayRecorderService.mjs`: settings become a running helper.
    - `electron/dayRecorderGates.mjs`: the FileVault and Time Machine checks.
    - `electron/dayRecorderMedia.mjs`: the media root, the path guard and the purge.
    - `electron/dayRecorderRuntime.mjs`: assembles the real parts.
    - Wiring in `electron/main.mjs`.
  - **Main has its own Convex client.** The spec says "the existing client", but the main
    process had none, and capture can't depend on a window being open.
    - `ConvexClient` uses `anyApi`, because `convex/` isn't packaged and the generated `api`
      is `anyApi` anyway.
    - Settings arrive by subscription to `dayRecorder.getSettings`, so turning the recorder on
      reaches the helper with no IPC yet (PR 3d).
  - **The tray indicator moves to 3e** with the rest of the UI. 3c reports status through
    `service.onStatus`.
  - **Every start runs both gates.**
    - FileVault must report exactly `FileVault is On.`.
    - The media root needs `tmutil addexclusion` (sticky form), confirmed by `isexcluded`
      reporting `[Excluded]`.
    - A check that can't run counts as failed. A failed gate gives the state `blocked`, with
      copy saying how to fix it, plus a `capError` event.
  - **A denylist or `shotSec` change restarts the helper** (protocol.md). Changes are applied
    one at a time, so two helpers never run at once (tested with three overlapping changes).
  - **No automatic restart after a failure.** The state stays "Not recording" with a
    `capError` event until the settings change or the app relaunches. Retrying could loop on
    a revoked permission. **This is James's call;** a bounded retry is easy to add.
  - **Nothing captured is logged.**
    - A failed screenshot write logs the path and the error *name* only, because a Convex
      argument-validation error echoes its arguments, OCR text included.
    - `tapRebuilt` and `tailDropped` are logged as counts. Their bundle fields are never
      stored.
    - Tests check every log for synthetic secret strings.
  - **The purge works from rows, then sweeps folders.**
    - Expired rows from `expiredMedia` are deleted through `resolveMediaPath`. It accepts only
      `<day>/<file>`, resolves symlinks, and refuses anything outside the root. A file that
      is already gone is still marked purged.
    - Then day folders whose *whole* day is past retention are removed: orphans,
      `.partial-*` files and all. The day that straddles the cutoff waits a day.
    - Only real directories named `YYYY-MM-DD` are touched, never a symlink or the key blob.
    - A refused row is never marked purged, and the loop stops instead of re-serving it.
      Such a row can't be created through `assertMediaPath`, so this is defence in depth.
    - The purge runs at each start and every 6 h. R14 asks for daily; 6 h covers a Mac that
      slept through a run.
  - **Live probe** (real helper under the real supervisor, unsigned dev build, counts only;
    the media was deleted afterwards):
    - A clean stop took 63–77 ms and ended `stopped`.
    - After `SIGKILL` on the helper, "Not recording" came 61–65 ms later (R3 asks for 10 s).
  - **The probe found the first-OCR stall again. A new code identity triggers it, but so
    does something else.**
    - The first two 15 s runs after a fresh build stored 0 shots. Heartbeats continued, so the
      status correctly stayed Recording: system audio was capturing.
    - A copy re-signed with a new ad-hoc identifier had a first OCR of **38.9 s**. The next
      run of the same copy took 0.5 s.
    - **But it isn't identity alone.** About 25 minutes later the same, already-warm binary
      took **36.3 s** on its first OCR again (direct run, 2026-10-21). So the stall also
      comes back after time or idleness, perhaps a Vision model cache being evicted. The
      trigger is **unverified**.
    - **In practice:** capture can go about 40 s without screenshots on an ordinary launch,
      not just after an update.
    - **Open (James):** move OCR off the helper's capture loop (Swift; not in this JS part).
      That now looks necessary rather than optional.
  - **Verify:** `npm run verify` (44 files, 406 tests) and `npm run build` both pass. The
    shared `node_modules` lacked `jsdom` (added on `main` earlier), so `npm install` was run
    in the root checkout; the lockfile is unchanged.
  - **Still to do in 3c, with James at the Mac, on a signed `npm run package`:**
    - the 2-hour soak RSS log, keeping the PR 3a leak detail logging so any recurrence of the
      one unattributed window is attributed;
    - the R3 screenshots for a revoked permission and a killed helper;
    - the stalled-delivery check with an output device unplugged mid-run;
    - the clean-TCC-state proof (spike Q7).
- **2026-10-20, PR 3c, F5 security gates on #80.**
  - **`security-review`:** no high-confidence findings. It considered and rejected
    candidates for command injection, argv injection, traversal, symlinks, TOCTOU, logging
    and IPC.
  - **`gstack-cso`** (run `1792555010920-c54230bb614ca230`, diff scope, `--code`): finished
    as **partial**. It was static only, because the doctor found no qualified scanner images,
    and the Swift sources outside the diff were not assessed.
  - **The CSO's one finding, `4016f9d6` (low, high confidence, fixed):**
    - Convex checks a row's `day`/`path` and its `takenAt`/`start` separately, and the local
      backend accepts unauthenticated calls. So a forged row with an old time and a
      current-day path made the purge delete a live recording, inside a 0700 folder that
      caller can't otherwise touch.
    - **Fix:** the purge now refuses any row whose path day is newer than the local day of
      the retention cutoff. Test first: it failed before the guard and passes with it.
    - The Convex handlers still don't tie `day` to the capture time. That would be a schema
      boundary change, so it's left for James's call, not made here.
- **2026-10-21, PR 3c, Codex #80 round 1 (6 × P1, 1 × P2): all fixed, each test first.**
  - **P1, OCR could reach the console through the Convex client.** It logs a failed
    mutation's server error, which echoes the arguments, before the promise rejects. Its
    logger is now `contentFreeLogger`: warnings and errors keep only their level, and `log`
    and `logVerbose` are dropped.
  - **P1, a second quit skipped the recorder stop.** It also lost the process-exit kill.
    `createQuitHold` now holds every quit until the stop finishes and then quits once.
    `main.mjs` keeps the recorder handle for the exit kill, and the service's `killSync`
    reaches a supervisor that is still stopping.
  - **P1, a clean stop didn't wait for the final segment's row.** Row writes are now tracked,
    and `stop()` waits up to `DRAIN_MS` (5 s) for them, logging any still pending. Tested
    with the fake helper announcing a segment during SIGTERM.
  - **P1, turning the recorder off stopped retention.** The purge now runs on the first
    settings and on its interval for the service's whole life: off, blocked or recording
    (R14). Off macOS there is no media root, so there is no purge either.
  - **P1, a restart reported Recording with no helper.** The old supervisor's
    stopping/off states now count, and the gates run under `starting`.
  - **P1, malformed or wrong-version lines kept Recording alive.** protocol.md's Failure
    section is now followed: such a line means Not recording (`protocol`). The helper gets
    SIGTERM, then SIGKILL after the grace period. Lines after a failure are still stored,
    but they no longer re-arm the watchdog.
  - **P2, an apply waiting on a gate could start after shutdown or after Off.** Each await
    in `applyNow` is now followed by a check for shutdown or a newer apply.
  - `npm run verify`: 44 files, 418 tests. The live probe still ends `stopped`, and "Not
    recording" now comes 68 ms after a SIGKILL. No real helper line was rejected.
- **2026-10-21, PR 3c, Codex #80 round 2 (1 × P1, 1 × P2): both fixed, test first.** Round 2
  confirmed that all seven round-1 fixes close their failures.
  - **P1, retention stopped when Convex failed or stalled.** The folder sweep ran only after
    every database call succeeded, and a query left pending while the client reconnected
    kept `purging` set forever.
    - **Fix:** each Convex call in the purge is bounded by `PURGE_DB_TIMEOUT_MS` (60 s).
    - A failed or timed-out database phase is logged as `dbFailed`, and the database-free
      day-folder sweep runs anyway.
  - **P2, diagnostic events skipped validation, but their fields are logged.**
    - `tapRebuilt` now needs a `trigger` of `listener` or `poll` and numeric counts.
      `tailDropped` needs a count and the `unjudged` flag. `sampleRateChanged` needs numeric
      rates, and `sessionUnverified` a numeric `livedMs`.
    - A line that breaks these shapes counts as a protocol violation.
    - Checked against the Swift emitter (`Tap.swift`, `Segments.swift`): it always sends
      these fields.
- **2026-10-21, PR 3c, Codex #80 round 3 (1 × P1, `[P2] none`): fixed, test first.** Round 3
  confirmed that both round-2 fixes close their failures and match the Swift emitter.
  - **P1, retention still waited for the first settings response.** A settings subscription
    that errors, or never connects, held back the purge for the whole session.
  - **Fix:** retention starts when the service is created (macOS only) and runs on its
    interval from then on. Settings now govern capture only.
  - The interval timer is `unref`'d, so it never keeps the process alive on its own.
- **2026-10-21, PR 3c, Codex #80 round 4: GATE PASS (`[P1] none`, 1 × P2), and the loop stops
  here (L42 cap).** Round 4 confirmed the round-3 retention fix.
  - **P2, fixed after the pass, test first:** the recorder's log stream had no `error`
    listener. A log file it can't open, or a full disk, would have thrown an uncaught
    exception in the main process, even with recording off.
  - `createFileLog` now reports a stream error once through a console fallback and sends
    later lines there too.
  - **This commit has had no Codex round.** Whether to run a final check on it is James's call.
  - Codex reported that the vitest suites can't run in its read-only sandbox (it can't
    create temp dirs). It checked with direct Node probes instead; `npm run verify` here
    covers the suites.
- **2026-10-21, PR 3c, James's decisions on the open items** (his words: "go with your
  recommendations for 1-4").
  - **Bounded automatic retry.** A helper that exited or went silent is retried after
    `RETRY_DELAYS_MS` (5 s, 30 s, 120 s), then left Not recording.
    - Never retried: a permission failure (a message matching `/permission/i`, such as
      `SCShareableContent failed (Screen Recording permission?)`), a spawn failure, or a
      protocol violation.
    - Every failure and every retry is a `capError` event, so a flapping helper stays
      visible. The status carries `retryInMs` while a retry is pending.
    - The budget resets after a run that stays recording for `RETRY_RESET_MS` (10 min), or
      on any settings change. Off, a newer apply, or shutdown cancels a pending retry.
  - **Convex ties a row's day to its capture time.** `assertCaptureDay` in
    `addScreenshot` and `addSegment` requires the capture time to fall inside the window
    when local day D exists somewhere: D 00:00Z − 14 h to D+1 00:00Z + 12 h (UTC−12 to
    UTC+14). This closes CSO finding 4016f9d6 at the trust boundary as well as in the purge.
  - **Move OCR off the helper's capture loop:** its own PR, before the soak.
  - **A final Codex check** covers these changes and the round-4 P2 fix.
- **2026-10-21, PR 3c, final Codex check on `2fa4d33`: GATE PASS (`[P1] none`, 1 × P2).** It
  covered the changes since round 4. The P2 is fixed, test first:
  - A native ScreenCaptureKit denial ("The user declined TCCs for application, window,
    display capture", spike Q7) has no "permission" in it, so it was being retried.
  - The match is now `/permission|declined TCC/i`.
  - A stable failure marker or exit code from the helper would be sturdier than matching
    message text. That is a helper change, left for the OCR PR or later.
- **2026-10-21, PR 3c, CI's "Typecheck & tests" was red on #80 from `2fa4d33` on.** All
  three heads failed, while every local and Node 22 container run passed.
  - The runner's log, read from the forge's `actions_log` store, named two service tests
    that waited on the wall clock: a purge-interval count (2 where at least 3 was expected
    in 70 ms) and the retry-budget reset (4 starts, expected 5). The shared runner was too
    slow for 20–30 ms windows.
  - **Fix:** `tests/dayRecorderService.test.ts` now runs on vitest fake timers throughout,
    and the fake supervisor's stop is a microtask. The two purge counts are now exact (4).
  - **Proof:** 20 runs of the Day Recorder suites in a `node:22` container limited to one
    CPU had 0 failures.
- **2026-10-21, OCR moves off the helper's capture loop** (James's decision, made before the
  3c soak; branch `feat/day-recorder-ocr-off-loop`).
  - **Why:** the first OCR in a process stalls for ~36–52 s, after a new build and again
    after time or idleness (PR 3c Deviations). Inline, it held up every capture behind it.
  - **`OCRQueue.swift`:** a serial worker with a backlog of 4 frames (~32 MB at 1920x1080
    points).
    - The capture loop reserves a slot before each capture and gives it back for an
      unchanged frame. While all 4 slots are taken, it waits instead of dropping a frame.
    - `shot` lines keep capture order. Only their timing changes: a line is written when its
      OCR finishes.
  - **Stop:** after the audio is finalized, OCR in flight gets up to 2 s on a signal. That
    fits the supervisor's 8 s stop grace alongside the 5 s audio tail. A `--duration` run
    waits up to 60 s.
    - A shot still in OCR at the deadline is never announced. Its file is an orphan, which
      the PR 3c sweep removes, and a stderr line says so.
  - **Protocol:** `v` stays 1. No event or field changed, only when `shot` lines arrive.
    `protocol.md` says so.
  - **Proof:**
    - `swift test`: 53 tests, 5 of them new for `OCRQueue`. They cover order, the calling
      thread not blocking, the capacity bound, release, and the drain timeout.
    - Live run on a copy re-signed with a fresh identity, to force the stall: the first OCR
      took **52.0 s**. Frames were still captured at 0.6 s, 10.6 s and 20.6 s (inline, the
      second capture would have come at ~52 s), and their lines arrived in capture order.
      The run had 11 heartbeats and exited 0 ending `stopped`.
  - **Not covered:** a signed `npm run package` run and the 2-hour soak. Both are 3c
    part 2, with James at the Mac.
  - **Codex #82 round 1: GATE PASS (`[P1] none`, 2 × P2), both fixed.** Both affect only
    `--duration` proof runs; the supervisor never passes `--duration`.
    - **A full backlog could run past `--duration`.** The slot wait now checks the
      deadline, and a slot taken after it expires is given back.
    - **SIGTERM couldn't shorten a duration drain.** The duration stop holds `shutdownLock`
      while it drains. The signal handler now notes the signal under its own lock first, and
      `OCRQueue.drain(until:)` re-reads its deadline every 100 ms. So the drain drops to the
      2 s signal allowance.
    - `swift test`: 54 tests, one new for the shrinking deadline.
    - Live, on a re-signed copy with `--duration 10` and SIGTERM at 15 s: it exited at
      17.0 s, and the last frame was captured at 5.7 s.
- **2026-10-21, PR 3c part 2, the runbook is ready:** `part2-runbook.md`.
  - **Covers:** the signed package and its checks, the three R3 failure proofs, the 2-hour
    R2 soak, leak attribution after the soak, and the clean-TCC check (spike Q7).
  - **New tools:**
    - `scripts/soak-rss.mjs` samples RSS per process role and media-file counts, and judges
      the 50 MB rule. It reads no content.
    - `scripts/day-recorder-ctl.mjs` handles on/off and time markers, writing the same
      settings the future Settings switch will.
  - **Runtime change:** the recorder log's `status:` line now carries the error and any
    pending retry. That makes the log the R3 timing record until the UI lands in 3e.
  - **Tested locally:** `soak-rss` against a live unsigned helper (it found the helper and
    passed), and `ctl mark` with its label check. **Not exercised:** `ctl on`/`off` against
    a running packaged app, which needs the backend from step 2.
- **2026-10-21/22, PR 3c part 2, first run on the signed build (part2-runbook.md).** Built
  from `aa71ee6` (#80 with #83 merged in). Evidence: `pr3c-part2-signed.json`.
  - **Step 1, signature: pass.** Signed with `Developer ID Application: James Cruce
    (Z4CHD4858S)`, not notarized. `codesign --verify --deep --strict` passes. The helper has
    the runtime flag and team `Z4CHD4858S`, with the same five entitlements as the app.
    - Prebake needs the gitignored `.convex/local/default/config.json`, so it was copied into
      the worktree (mode 600). Prebake only copies it into its own scratch directory.
  - **Step 2, recorder on: pass.** Recording 1.4 s after the settings change.
    - The first screenshot was on disk 25 s after `ready`.
    - The media root is `[Excluded]` from Time Machine and `drwx------`, so F8 and the
      0700 mode hold in the signed build.
    - No TCC prompt appeared: Geekspace kept its grants from the spike. Step 6 covers the
      first-grant case.
  - **Step 3a, helper killed: pass.** "Not recording" came 1.9 s after the marker (an upper
    bound, since it includes the marker script's own start-up). A retry followed at 5 s, and
    recording was back 6.3 s after the kill.
    - **Retry cap:** four kills gave retries at 5 s, 30 s and 120 s, then no retry. It stayed
      Not recording, checked for 10 s.
    - **Seen, for 3e:** while a retry clears the failed supervisor, a `status: off` line
      comes between `notRecording` and `starting`. A UI would flash "Off" there.
  - **Step 4, 2-hour soak: pass (R2).** Growth from the 10-minute mark:
    - helper +8.4 MB, main +1.0 MB, renderer +0.3 MB, backend +15.1 MB, other helpers
      +4.6 MB;
    - one helper pid for all 120 minutes;
    - 0 tap rebuilds, 0 dropped tails, 0 Not recording, 0 failed row writes and 0 Convex
      client errors in the log.
    - **Media:** 24 segments in 2 h (one per 5 min), split 20 / 4 across local midnight,
      plus 31 screenshots on a mostly static screen.
    - **A logger bug the run caught, now fixed:** `soak-rss` counted only today's folder, so
      its totals dropped to 0 at midnight. It now counts every day folder. The capture
      itself was fine.
    - **Two orphan `.partial-` segments** were written at 22:16:44 and 22:17:06 local, the
      exact times of the first two SIGKILLs. That is the known orphan case, which the 30-day
      sweep removes. The last two kills came within 0.4 s of `ready`, before any segment
      began.
  - **Step 5, leak attribution after the soak: pass.** The PR 3a second-instance proof ran
    3 times with the **signed** helper: 0 leaked windows each time. The positive control was
    heard in 11, 12 and 11 windows. PR 3a's unexplained window did not recur.
  - **Still open, needing James:**
    - 3b: Screen Recording revoked in System Settings. Changing security settings is
      James's to do.
    - 3c: the output device unplugged (physical).
    - 6: the clean-TCC check, which needs a new macOS user.
- **2026-10-22, PR 3c part 2, step 3b (Screen Recording revoked): pass, and the proof changed.**
  - **Revoking reaches the running helper.** macOS's "won't take effect until Geekspace is
    quit and reopened" warning doesn't apply to ScreenCaptureKit. On the first try, the
    running helper failed with `SCShareableContent failed (Screen Recording permission?):
    The user declined TCCs…` and reported Not recording, with no retry in the 60 s before
    the quit.
    - That first try *looked* like a miss: the 10-minute watch ended at 12:59:34, before
      the switch was flipped at about 13:02. Read correctly, it was a detection.
  - **Timed redo:** the helper reported Not recording at **09:38:44.949** local. James's
    hand-pressed `date +%T`, run right after his click, read **09:38:46**, so detection came
    within about the 1–2 s between his click and his key press. That is well inside R3's
    10 s, and consistent with the 5 s heartbeat authorization check. There were 0 retry
    lines after it.
  - **Relaunch while revoked:** fails 103 ms after `ready` with the same message, and no
    retry.
  - **Restore:** the switch went back on, then a quit and reopen gave `recording` 1.4 s after
    start-up. The quit was clean each time: the recorder `stopped` before the backend.
  - **Orphan:** the helper's failure exit left its open segment as `.partial-` (the known
    case). The sweep removes it.
  - **Unverified:** macOS's log has no `tccd` entries for these changes, so the switch-off
    times come from James's notes only.
- **2026-10-22, PR 3c part 2, step 3c (output device unplugged): pass, but not as the runbook
  expected.** An output change is not a capture failure for the CoreAudio tap. It follows the
  new default device without losing audio, so there is nothing for "Not recording" to report.
  - **First run** (unplug at 12:06:56): no failure, and the helper kept the same pid. Sound
    was captured through the Bluetooth speaker the output moved to, at 12:08:03. But nothing
    was playing across the unplug, so the run couldn't show continuity, and it was re-run.
  - **Re-run with a continuous 440 Hz tone** looped through the current default output. James
    plugged the USB device in and selected it at **12:10:23**, then pulled it at **12:11:16**.
    - Per-second RMS of the segment from 12:09:55 to 12:12:29: **no drop at either switch**.
    - The window has 1 silent second, at 12:10:07, 16 s before the first switch: a longer gap
      between tone loops.
    - The same helper (pid 70704) ran throughout, with no failure and no retry.
    - One routine `tap rebuilt (listener)` came at 12:12:52, after both switches.
  - **Changed in the proof:** R3's "unplug → Not recording" isn't a real failure mode for this
    tap. What R3 needs here is "no *silent* loss", and the level trace proves exactly that.
  - **Still unproven live:** the 1 s stalled-delivery check (PR 3b-2). No scenario stopped
    delivery, so it stays covered by `swift test` only.
- **2026-10-31, PR 3c part 2, step 6 (clean-TCC check on a fresh macOS user): pass, and spike
  Q7 is answered.** The signed app ran in a new standard user, "GS Test", through
  `signed-run.cjs`, so Geekspace was the TCC-responsible process.
  - **Two prompts appeared:**
    1. "'Geekspace' would like access to record your system audio", with our
       `NSAudioCaptureUsageDescription` text.
    2. "'Geekspace' is requesting to bypass the system private window picker and directly
       access your screen and audio".
  - **Answer to Q7: the tap needs its own grant.** Afterwards Geekspace was listed under
    **System Audio Recording Only** and *not* under Screen & System Audio Recording. Spec
    "Security and data" is updated.
  - **Result with both allowed:** exit 0, ending `stopped`. There were 2 screenshots, and
    7 audio segments, each with a peak of about 0.256 from the looping test sound, so system
    audio was captured.
  - **Not kept:** the pre-grant outcome. `clean-tcc-1` ran several times and overwrote
    itself, so the prompts are the pre-grant evidence.
  - **Unverified:** whether the "bypass the picker" approval persists or macOS asks again.
    If it lapses, capture fails loudly (3b).
  - **For 3e:** the onboarding copy must prepare the user for both prompts.
  - Evidence: `cleanTcc` in `pr3c-part2-signed.json`, plus three cropped screenshots
    (`pr3c-clean-tcc-*.png`). They were cropped to the prompts and the Settings pane, because
    the full screenshots show the desktop.
- **PR 3c part 2: done.** Steps 1, 2, 3a, 3b, 3c, 4, 5 and 6 pass on the signed build. Proofs
  changed by what was observed:
  - **3b:** a revoke is caught live, within about 1–2 s of the click.
  - **3c:** an output change is no failure for the tap, and the proof is now "no silent loss".
  - **Still unproven live:** the 1 s stalled-delivery check, covered by `swift test` only.
  - **For 3e's UI:** hide the `status: off` blip during a retry.
- **2026-10-31, PR 3c, final Codex check before ready: 4 rounds, ending with a clean PASS.**
  The scope was the code since `2fa4d33`: the TCC-wording retry fix, the fake-timer tests,
  the status-line logging, `soak-rss` and `day-recorder-ctl`.
  - **Round 1 (FAIL; 1 × P1, 1 × P2):**
    - P1: `ctl on` and `settings` printed the whole settings object, denylisted bundle ids
      included.
    - P2: `soak-rss` passed if the helper vanished after the first sample.
    - Fix: a safe settings view (the denylist as a count), and a verdict that requires the
      helper in every sample and a warmup baseline. The decisions moved to
      `scripts/lib/dayRecorderTools.mjs`.
  - **Round 2 (FAIL; 2 × P1, 1 × P2):**
    - Errors were treated as the script's own by message text, which a backend error could
      imitate.
    - The Convex HTTP client printed backend `logLines` itself, the same class as the
      main-process P1 in #80's round 1.
    - The soak took no sample after its last sleep.
    - Fix: `CtlUsageError` (decided by type), `{ logger: false }`, and `soakSchedule` with a
      final sample at the end. A script-level test now runs the real ctl against a fake
      backend.
  - **Round 3 (PASS; 1 × P2):** any `gs-capture` counted as the helper. Fix: `processRole`
    counts only `Geekspace.app/Contents/Resources/gs-capture`.
  - **Round 4 (PASS, `[P1] none`, `[P2] none`):** the review loop stops here (L42 cap).
  - `npm run verify`: 45 files, 466 tests.
- **2026-10-31, PR 3c, re-check after the dependency bumps (#86, Electron 42.11.18).** A
  signed `npm run package` from `ed5cadf` passed runbook steps 1 and 2.
  - The signature and entitlements matched the earlier run.
  - Recording began 3.4 s after `on`, screenshots landed, and a finished system-audio
    segment was written.
  - The first attempt was rejected: settings left on from earlier started the recorder at
    launch, before `on`. The redo went off, then a marker, then on.
  - Evidence: `~/gs-part2-evidence/post-deps-2026-10-31/`.
- **2026-10-31, PR 3 is now 3a–3e with 3d split in two (James).** Same reason as the first
  split: #80's 30 files strained the ai-review gate.
  - **3d-1:** the renderer's controls, IPC and preload, and a saved pause.
  - **3d-2:** mic capture, its own preload, and `probe:segment-decode`.
- **2026-10-31, PR 3d-1, pause is a saved setting (James).**
  - `settings.dayRecorderPaused` is apart from `dayRecorderEnabled`, so a paused recorder
    stays paused across a relaunch or crash.
  - Runtime-only pause would let a crash quietly resume recording, because the recorder is
    still enabled.
  - The service treats paused like stopped, reports `paused`, and never retries a failure
    once paused. Turning the recorder on clears a saved pause (`day-recorder-ctl on` too).
- **2026-10-31, PR 3d-1, the preload exposes only the controls that exist.**
  - `dayRecorder` has `status`, `setEnabled`, `pause`, `resume` and `onEvent`.
  - `noticeGiven`/`noticeDeclined` move to PR 4. `requestImage`, `approveDraft`, `undo` and
    `setApiKey` move to PR 6, each with its feature, so the preload never exposes a stub.
  - Each control is a settings patch, not a direct call into the service: capture follows
    settings by subscription, so a control behaves the same now and after a relaunch.
  - `electron/dayRecorderIpc.mjs` registers the four channels through `main.mjs`'s
    `handle()`, which refuses any sender but the app page. `setEnabled` refuses anything
    but a boolean. A recorder that failed to start says "not running" rather than
    reporting off.
- **2026-10-31, PR 3d-1, live probe (signed package from `245b913`, through the real
  page).** The DevTools protocol called `window.geekspace.dayRecorder.*` in the running
  app's page, so the real preload, IPC and `handle()` path ran.
  - The namespace exposed exactly the five calls.
  - `setEnabled(true)` reached Recording with one helper. `pause()` stopped it: zero
    helpers, status `paused`.
  - A real quit and relaunch came back `paused`, with no `starting` in the log first and no
    helper. `resume()` reached Recording again, and `setEnabled(false)` reached off with
    zero helpers.
  - `setEnabled("yes")` returned `{ ok: false, error: "setEnabled needs true or false" }`,
    and the status stayed `paused`.
  - **For 3e:** pause emits `stopping`, then `off`, then `paused`, because the supervisor's
    own `off` is passed through first. The UI should not flash Off on pause.
  - Evidence: `~/gs-part2-evidence/pr3d1-ipc-2026-10-31/status.log` (status lines only).
- **2026-10-31, PR 3d-2, mic capture.** Built as planned, with these changes from plan.md:
  - **`capture.html` is at the repo root, not under `electron/`.** It's a second Vite page
    next to `index.html`, so `src/capture/main.ts` builds into `dist/capture.html`.
  - **The capture window has its own module, `electron/captureWindow.mjs`,** so the app and
    `probe:segment-decode` open the same window. It's hidden, sandboxed, and denies popups
    and navigation. `backgroundThrottling` is off, because a hidden window's timers would
    otherwise slow the segment clock and the silence meter.
  - **`main.mjs` gains `appWindows()`.** Five lookups took "the first window" as the app
    window: the meeting quit guard, second instance, activate, the title-bar overlay, and the
    status push. The hidden window would have broken each of them.
  - **The next recorder starts before the old one stops**, at every boundary, so the gap is
    zero or a slight overlap rather than lost audio. One emit queue keeps a segment's last
    chunk ahead of its `segmentEnd`.
  - **An empty segment is the controller's call, not the writer's.** The probe's first run
    flagged a clean stop as a mic failure: a stop just after a boundary leaves a final segment
    with no audio yet. The writer now drops an empty segment (no file, no row) and reports it.
    Mid-recording that is a dead mic (`noAudio`); at a stop it is not.
  - **The mic degrades loudly (James, 2026-10-31).** A denied, missing, lost, silent or
    misbehaving mic becomes the mic's own state on Recording plus a `capError`. Screens and
    system audio carry on.
  - **Sender check.** `micController` accepts `gs:mic:event` and `gs:mic:config` only from
    its own window's `webContents`. `micSegments` checks every message before it touches the
    disk: sizes are capped, start times must be near now, segments must be in order, and at
    most two may be open.
  - **Shared code.** `recorder.ts` exports `SILENCE_LEVEL` and `rmsLevel` (the same math,
    moved). `meetingProcessor.mjs` exports `convertToWhisperWav` (the same ffmpeg command,
    which `processMeeting` now calls), `findFfmpeg` and `measureVolume`. GitNexus rated this
    HIGH because Meetings flows are touched; the Meetings suites pass unchanged (43 tests).
  - **Opus averages about 129 kbps, so a 5-minute segment is about 4.8 MB,** not the 2 MB
    estimated. The 64 MB per-segment cap still leaves room.
  - **The mic prompt (`NSMicrophoneUsageDescription`) now names the Day Recorder.**
- **2026-10-31, PR 3d-2, proofs.**
  - **`probe:segment-decode`** (Chromium's fake device, 3 s segments): segment 2, copied
    alone into an empty folder, decoded to 3.00 s of 16 kHz wav through
    `convertToWhisperWav`, and was not silent. The boundary gap was about 0 ms. It passed 3
    runs out of 3.
    - **Check of the check:** the same path decodes a whole segment but refuses that segment
      cut at its second Matroska Cluster, which is what a timeslice continuation is. So
      PR #70's failure class is caught.
    - A mutation that split one continuous recorder also failed the probe, but at the writer
      ("segment 0 was not started"), so that run did not test the decode step.
  - **Signed `npm run package` from `33aad2a`, real mic, real 300 s segments:**
    - `setEnabled(true)` gave `mic: starting` then `ok` 448 ms later, and the status was
      `{ status: "recording", mic: { state: "ok" } }`.
    - Four segments landed exactly on the 5-minute boundaries, mode 600. Each decoded **alone**
      to 299.94 or 300.00 s and was not silent.
    - `pause()` finalized the open segment (70.44 s, decodes alone). The hidden window closed,
      the helper stopped, and no partial was left.
    - Each of the five files has exactly one `kind: "mic"` row in the backend store, checked
      read-only by count.
    - Evidence: `~/gs-part2-evidence/pr3d2-mic-2026-10-31/` (`decode.txt`, `status.log`).
      Lengths and levels only; no audio left the machine.
  - **The run found log noise:** `mic: off` on every non-recording status, and a repeated
    `status: recording`. Fixed in `d2137ff`, which changes logging only.
  - **Security review: no findings.** Two rejected candidates were closed anyway: a start far
    off the clock (an Invalid Date day folder) and an unchecked `silentSec`.
  - **Still to prove live, with James at the Mac:** a denied mic (revoke it in System
    Settings) and an unplugged input. Unit tests cover both.
  - **The verification trap this time:** the first wait-for-segments script reported "0
    finished" because `touch -t` read a UTC time as local and set a marker about 4 hours in
    the future. A file listing showed the segments were there.
- **2026-10-31, PR 3d-2, Codex round 1: FAIL, 5 × P1 and 2 × P2.** All seven are fixed test-first
  (red commits `e1de53e` and `ea6dc36`).
  - **The controller works toward the latest request, not what happens to be open.** A
    `wanted` flag: a stop while macOS is asking for permission cancels the start; a start
    during a stop runs once the stop is done; two starts during one ask share it, so they
    open one window, not two. A later stop waits for a teardown the window began itself
    (device lost), so a quit can't close the backend before the last row is in. A failure
    keeps the mic down until the next stop and start, because the runtime calls start on
    every Recording status.
  - **A window that says stopped unasked, with no error first, is a failure** (`windowGone`),
    not a quiet mic off.
  - **A broken segment is dropped.** A refused chunk, a failed or short write, or a chunk the
    window could not read (`chunkFailed`) leaves the segment with no file and no row.
    Writes loop until every byte has landed.
  - **A recorder that will not start is never announced.** `segmentStart` goes out only after
    `start()` returns. A failure at a boundary still finishes the old segment.
  - **The capture window's startup is now `src/capture/micWindow.ts`**, split out of
    `main.ts` so it can be tested without a DOM. The stop listener is registered first; a
    stop during config or getUserMedia starts nothing, lets go of the mic, and still says
    stopped.
  - **A silent mic records one capError per episode** (`mic: no signal for N s`).
  - **The decode probe now fails a boundary gap past 250 ms.** It passed after the fix, with a
    gap of about -1 ms.
  - **Two sessions worked on this round at once.** The handoff's author was still running, so
    two sessions shared the worktree. The fix was splitting the work by hunk, not by file:
    the controller and writer fixes were written in one session, the capture side and probe
    in the other.
