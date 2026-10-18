---
change: 2026-10-18-day-recorder
status: draft
track: T3
author: james
accepted_by:
linear: pending
source: conversation
---
# Intent: Day Recorder — an assistant that hears and sees the workday and keeps Geekspace current

## Problem

The workday produces commitments, decisions and status in conversations, calls and screens
that Geekspace never sees. Today the only capture is a meeting recording that James starts by
hand. To-dos, time blocks and status updates are entered manually after the fact, or not at
all. Nothing produces a record of the day or an archive that can be searched later.

## Proposed outcome

- **Capture, local:** James can turn on a Day Recorder that records the microphone, system
  audio and periodic screenshots on his own machine. It is clearly visible when it is on,
  and it pauses or resumes in one click. Transcription (whisper.cpp) and screenshot OCR run
  locally.
- **Reasoning, Claude:** transcript and OCR text go to Claude for reasoning. A screenshot
  image goes to Claude only when it is asked for, and each send shows as a visible, logged
  event.
- **Autonomy level 2:**
  - *Inside Geekspace,* the assistant acts on its own. It adds to-dos and blocks calendar
    time. Every action is tagged as the assistant's, undoes in one click, and appears in an
    end-of-day review.
  - *Outside Geekspace,* for example a Linear status update, the assistant only drafts.
    Nothing is sent until James approves it.
- **Daily record:** each day produces a summary plus an audio and visual timeline that links
  to the source moments.
- **Archive:** past days can be searched and mined, subject to a retention policy.

## Affected users and systems

- James, on the Mac Studio only in v1. Windows capture is later, after Phase B.
- Other people whose voices or screens get captured: call participants, who are notified,
  and the rare in-person visitor, who sees the indicator. See open question 1.
- Code that exists today:
  - `src/lib/recorder.ts` (the singleton mic recorder)
  - `electron/meetingProcessor.mjs` (ffmpeg → whisper.cpp → Ollama)
  - the `meetings` and `timeBlocks` tables
  - the scheduler in `convex/scheduling.ts`
  - ARCHITECT's Claude lane (`electron/architect.mjs`, Agent SDK)
  - `build/entitlements.mac.plist` and the `extendInfo` usage strings
- New macOS permissions: Screen Recording, and System Audio Recording or a ScreenCaptureKit
  audio grant. Each needs its entitlement, not just a usage string (repo review standard).

## Constraints

- **Sequencing:** v1 is Mac Studio only and starts now, independent of Phase B (Windows +
  Outlook, read-only Microsoft Graph). Windows capture waits for Phase B. Multi-machine job
  routing is Phase D, not this change.
- **Never silent:** capture fails loudly on a missing or dead device, the same discipline as
  `recorder.ts`'s silence detection. It also never runs without a visible indicator.
- **Local first:** raw audio, screenshots, transcripts and OCR text stay on the machine.
  Only text, plus images sent on demand, goes to Claude.
- **Public repo:** geekspace is public on GitHub. Capture logic, fixtures, logs and test data
  must contain no real recordings, screenshots or transcripts.
- **Exclusions are enforced at capture time, not filtered afterwards:** excluded apps and
  windows (employer and work systems first) are never screenshotted or transcribed. Data
  that was never captured cannot leak.
- **Cost:** Claude usage is continuous, so it needs a per-day budget and a visible meter.
  Proofs must not spend the Agent SDK credit pool unless James agrees, the same rule as
  agent-mcp.
- **Assistant time blocks** must survive the scheduler. Today `timeBlocks` requires a
  `taskRowId`, and the scheduler re-plans every unlocked future block.
- **No leak through the renderer:** new IPC stays narrow and named, per the
  `electron/preload.cjs` standard.

## Out of scope

- Fine-tuning a local model. That is a later experiment.
- The hype video, which comes after Phase C.
- Multi-machine routing (Phase D).
- Sending anything external without approval.
- Writing to Outlook (Phase B is read-only).

## Success signals

- **A full 8-hour capture on the Mac** has these properties:
  - renderer memory stays flat, because audio is written as rolling segments, not held in
    memory;
  - a pulled mic, or a revoked Screen Recording permission, raises a visible warning within
    `SILENCE_WARN_SEC`;
  - an excluded app in the foreground produces zero screenshots and zero OCR rows, and a test
    asserts that count.
- **Assistant actions:** a test fixture transcript containing a commitment ("I'll send the
  deck by Thursday") produces one tagged to-do and one time block. One-click undo removes
  both. A scheduler re-run does not delete the block.
- **External drafts:** a Linear draft appears in the review queue. A network probe shows
  nothing sent to Linear before approval.
- **Call notice:** every captured call segment has a logged recording-notice event, and a
  test fails if call audio is stored without one.
- **Image sends:** every image sent to Claude appears in an event log with its timestamp, and
  a test fails if an image request bypasses the log.
- **Daily summary:** produced for a test day, with each item linking to its source segment.
- **Repo gates:** `npm run verify` and `npm run build` pass. The packaged, signed build
  passes `codesign -d --entitlements -` and shows the new capture entitlements.

## Open questions

1. ~~**Consent for other people's audio.**~~ **Decided (James, 2026-10-18): announce and
   capture.** Calls are captured, mic and system audio, and the other parties are given a
   recording notice. This brings system-audio capture into v1, along with its macOS
   permissions and entitlements. Still open: how the notice reaches every party (spoken,
   in-chat, or both), what proves it was given (a logged event per call), and what happens
   to an in-person conversation picked up by the always-on mic, where no notice step exists.
   This is a product default, not legal advice.
   **In-person (James, 2026-10-18): a visible indicator is enough.** James works from home
   full time in a dedicated office by himself, so bystanders are rare. The decision depends
   on that setup. A recording indicator shows whenever the mic is live, and pause is one
   click for the moment someone walks in. If the app is used on the road (the MacBook Pro
   travels), this decision needs revisiting.
2. ~~**Exclusions.**~~ **Decided (James, 2026-10-18): a denylist only.** Everything is
   captured except the apps James lists. There is no pre-seeded work list and no automatic
   pause on the work VPN. Accepted risk: a work app missing from the list gets captured.
   Still open: what the denylist matches on (app bundle ID, window title, browser profile or
   domain), and whether it also covers hours.
3. ~~**Retention.**~~ **Decided (James, 2026-10-18):** raw audio and screenshots are deleted
   after 30 days. Transcripts, OCR text and summaries are kept indefinitely for the archive.
   The storage budget is unmeasured. Audio is estimated at about 2.5 GB a month (Opus at
   32 kbps, 8 hours a day, 22 days), and screenshot volume depends on an interval not yet
   chosen. Measure both during the capture spike. Still open: whether the archive is
   encrypted at rest, and whether deletion also reaches backups (Time Machine).
4. ~~**Storage location.**~~ **Decided (James, 2026-10-18): files on disk, with an index
   in Convex.** Raw media goes to dated folders under the app data directory
   (`electron/dataDirectory.mjs`). Convex holds paths, timestamps and derived text only. The
   30-day purge deletes files, and the media folder is a candidate for Time Machine
   exclusion. This differs from Meetings, which uses `_storage`. The spec decides whether
   Meetings moves to the same model.
5. ~~**Machine.**~~ **Decided (James, 2026-10-18): Mac Studio only.** This matches the
   solo-office consent decision and allows a larger whisper model with no battery budget.
   The MacBook Pro does not capture in v1.
6. ~~**Claude lane.**~~ **Decided (James, 2026-10-18): the Messages API with its own
   budget.** It uses a dedicated API key from an environment variable or a config file
   outside the repo, never committed. Calls are batched: periodic extraction plus the end of
   day. The app enforces a hard daily spend cap. This is separate from ARCHITECT's Agent SDK
   credit pool. Still open: the cap amount, the batch interval, and the model per job.
7. ~~**Undo model.**~~ **Decided (James, 2026-10-18): a new `assistantActions` log.** Each
   action records its kind, target ID, previous value and source segment. Undo applies the
   inverse. The same log feeds the end-of-day review and the "why did it do this" link.
   Existing tables are not changed for provenance. Still open: how assistant time blocks
   survive the scheduler (a task row per block, locked blocks, or a new block kind). That
   choice is for the spec.
8. ~~**Phase B.**~~ **Decided (James, 2026-10-18): start the Mac capture spike now.** v1 is
   Mac-only and does not touch Phase B code. The spike covers rolling segments, system
   audio, OCR and the storage measurement.
