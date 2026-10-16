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

## Deviations

- **Test-only commit `65fb50b`:** 14 tests failed for the stated reasons (missing exports,
  transcript in the list, no reconcile, an unknown status accepted, an edited page
  overwritten, the microphone left open). The in-place rebuild test passed on `main`; it
  is the control showing an untouched page is still updated in place.
- **Wording:** the button is labelled "Re-run AI", so messages say "use Re-run AI"
  instead of "Reprocess". The reconcile test now matches that wording.
- **Added:** the status chip shows summary progress per section, and the model check is
  cached by inode, size and mtime. Hashing the 148 MB model takes 124 ms; the cached
  check takes 1 ms, measured against the installed model.
- **Conservative choice:** a meeting from before `generatedContent` existed gets a new
  notes page on Re-run AI, never an overwrite, because the app can't tell whether that
  page was edited.
- **Not unit-tested:** the shared in-flight `ensureModel` download (reviewed by reading),
  the "Quit Anyway" branch after a failed save, and the window-close path. The close path
  runs the same function as quit.
- **Suite 150/150; verify and typecheck pass.** The `convex/_generated` changes in the
  worktree come from the running `convex dev`'s codegen and are not committed.
- **Live, Electron window on the worktree backend.** Chromium's fake audio device couldn't
  read the synthetic wav (its audio sandbox blocks the path; the log suggests
  `--no-sandbox`). It recorded silence, so speech was supplied by uploading the same wav
  as a meeting's audio and running Re-run AI. Renderer steps were driven over CDP using
  the app's own module instances.
  - Silent capture: 38 s recorded at −91 dB failed loud ("No audio captured… peak
    −91.0 dB"), with the audio already uploaded.
  - Reload mid-recording: on the next load, reconcile marked the meeting "recording was
    lost". The list row carried 7 fields and no transcript.
  - Re-run AI from audio: whisper plus `qwen2.5:7b-instruct` in 6.2 s, with an accurate
    transcript, one decision, two action items, and the notes page written with
    `generatedContent`.
  - Ollama unreachable (`127.0.0.1:9`): status error "Summary failed: Ollama not
    reachable…", with the 399-character transcript kept. After the URL was restored, Re-run
    AI finished in 1.3 s with no transcribing phase, and the transcript was unchanged.
  - Edited notes page plus Re-run AI: the edited page was untouched and a new page was
    created.
  - Quit mid-recording (Quit Geekspace from the menu): the native dialog appeared.
    - First answer: the recording continued and the app stayed open (Keep Recording).
    - Second answer: the app quit after saving. The meeting holds 63 s of audio and
      "Saved when the app quit. Use Re-run AI…", and the backend stayed up.
    - My automated clicks on both dialogs were refused by the desktop tool, so each was
      answered outside the tool. The recorded state is the evidence.
- **Codex review round 1 (`86bdb21`): GATE FAIL, one [P1] and one [P2], fixed together.**
  Both had one cause: after `recorder.stop()` the audio existed only inside one in-flight
  save.
  - [P1] A failed save on quit discarded the audio, so "Keep App Open" kept nothing. The
    same loss already happened on `main` when a normal Stop's upload failed.
  - [P2] During the upload the renderer reported "not recording", so a second Cmd-Q
    skipped the guard and stopped the backend mid-upload.
  - Fix, for the whole class:
    - New `src/lib/audioSaver.ts` holds the stopped recording until it is attached and
      refuses a concurrent save. Its dependencies are injected, because the project lint
      bans module mocks.
    - The meeting detail offers **Retry save**.
    - The quit guard counts a save in flight or unsaved audio as active.
    - Main blocks quit and window close while its own save handshake runs.
  - Tests: 4 in `tests/meetingPipeline.test.ts`. An earlier module-mock version of the
    same cases failed 3/3 on the pre-fix code. Suite 154/154.
  - Live: a simulated upload outage left the audio held with "Couldn't save the audio…
    use Retry save". Retry save then stored it (17 s).
