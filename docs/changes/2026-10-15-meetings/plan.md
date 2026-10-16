---
change: 2026-10-15-meetings
status: accepted
track: T2
intent: ./intent.md
linear: pending
---
# Plan: guard the quit, keep every transcript, summarise the whole meeting

## Files that change

- `electron/meetingProcessor.mjs` (and its `.d.mts`):
  - `isNoSpeech(transcript)` strips bracketed and parenthesised whisper markers as tokens,
    then checks for at least 5 characters (replaces the character-class regex).
  - `summarizeTranscript(transcript, type, url, model)`:
    - A short transcript is summarised in one request, as today.
    - A longer one is split on whitespace into sections of at most 24,000 characters.
      Each section is summarised, then one merge request combines the partial notes.
    - Progress is reported per section.
  - The parser throws on a missing or empty summary instead of substituting a placeholder.
  - `processMeeting` returns `{ transcript, summaryError }` when only the summary fails.
  - `toolStatus` / `ensureModel` use `verifiedFile` / `downloadVerifiedFile` with the
    pinned size and SHA-256, and concurrent calls share one in-flight download.
- `electron/verifiedDownload.mjs` (new, adapted from PR #28):
  - HTTPS-only, with redirects followed by hand (at most 5).
  - Streams through a hash, rejects anything over the expected size, and writes to a
    unique `.part` file (`wx`, mode 600).
  - Renames into place only after both the size and the hash match, and always removes
    the `.part` file.
- `electron/main.mjs`:
  - `gs:meeting:summarize` runs the summary only, for Reprocess when a transcript exists.
  - Quit guard. The renderer reports whether a recording is active. If one is, the window
    `close` and app `before-quit` handlers show "Save recording and quit / Keep recording".
    - On Save, the main process asks the renderer to stop and upload, waits for its reply,
      and only then runs the existing backend shutdown and quits.
    - If the save fails, a second dialog offers "Quit anyway / Keep app open".
    - The guard runs before the backend shutdown, because the upload goes to that backend.
- `electron/preload.cjs`: narrow additions only. `meetings.summarize(...)`, plus a
  `recorder` object with `setActive(bool)`, `onSaveRequest(cb)` and
  `saveDone({ ok, error? })`.
- `src/lib/meetingPipeline.ts`:
  - `saveRecording()` (stop, upload, attach) is split out of `finishRecording()`; the quit
    path calls it alone and marks the meeting "Saved when the app quit, use Reprocess".
  - `runAi` saves the transcript before reporting a summary error.
  - `reprocessMeeting`:
    - With a transcript, it summarises only.
    - Otherwise it fetches the audio with a timeout and checks `ok`.
    - Every failure sets status error. The caller no longer leaves an unhandled rejection.
- `src/lib/recorder.ts`: `start` claims a "starting" state before the permission prompt.
  - A cancel during the prompt invalidates that start, so a late grant stops its tracks.
  - Construction failures release the stream and reset to idle.
  - It also reports active/inactive through the new bridge.
- `src/lib/meetingsBridge.ts`: typed wrappers for the new calls.
- `src/App.tsx`: wires the save-request handler, and calls `meetings.reconcileInterrupted`
  once on launch.
- `src/components/meetings/MeetingsView.tsx`: Reprocess catches errors and shows them. The
  list uses the slimmer row type.
- `convex/meetings.ts`:
  - `list` returns only the list fields: no transcript, summary, points or generated
    content.
  - `reconcileInterrupted({ before })` turns meetings stuck in recording / uploading /
    transcribing / summarizing that started before this launch into errors. The message
    depends on whether audio was saved.
  - `setStatus` validates `status` against the known set and clears a stale error when
    the meeting leaves the error state.
  - `buildNotesPage` stores `generatedContent`. On rebuild it updates the page only if
    the page still holds exactly what the app last wrote; otherwise it creates a new page.
- `convex/schema.ts`: `meetings.generatedContent: v.optional(v.string())`.
- Tests:
  - New: `tests/meetingSummary.test.ts` (stubbed Ollama HTTP),
    `tests/verifiedDownload.test.ts` (stubbed fetch, temporary directory) and
    `tests/meetingsData.test.ts` (convex-test).
  - Extended: `tests/meetingAudio.test.ts` (speech check) and `tests/recorder.test.ts`
    (start races).

## Order of work

1. Tests → fail for the stated reasons; commit test-only.
2. Speech check, summary parser, sectioned summaries, transcript-kept-on-summary-failure →
   processor tests pass.
3. Verified download → download tests pass.
4. Convex: slim list, reconcile, status validation, edit-safe notes page → data tests pass.
5. Recorder start races → recorder tests pass.
6. Quit guard (main, preload, pipeline, App) and Reprocess-from-transcript.
7. Live probes in the Electron window on the worktree backend, with synthetic speech from
   macOS `say` played into the mic. Probes: quit mid-recording → Save → relaunch; Ollama
   stopped → transcript kept → restart Ollama → Reprocess; an edited notes page survives
   Reprocess. Then verify and build.

## Risks

- The quit guard changes the shutdown order. The backend must stay up until the upload
  finishes. Proven live, and the save has a 2-minute limit so a hung upload can't block
  quitting forever.
- Merge request quality on very long meetings depends on the local model. The test proves
  every section reaches the model; quality is checked by eye on one long synthetic
  transcript.
