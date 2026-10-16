---
change: 2026-10-15-meetings
status: accepted
track: T2
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a meeting recorder that never silently loses a meeting

## Problem

From the 2026-10-11 reassessment, re-read against `main` at `12b2073`. Audio already goes to
Convex storage before transcription starts (`meetingPipeline.ts`), so a crash during the
AI steps leaves a recording you can reprocess. The remaining gaps:

1. **Quitting mid-recording throws the meeting away.** The audio lives only in renderer
   memory until Stop. Cmd-Q, closing the window, or a restart for an update during a
   meeting discards it with no warning, and the meeting record stays in "recording"
   forever.
2. **Interrupted meetings spin forever.** A meeting left in recording / uploading /
   transcribing / summarizing when the app closed keeps that status on the next launch,
   with no error and no Reprocess prompt.
3. **"Hello world" is rejected as no speech.** The blank-audio check
   `/[\s[\]BLANK_AUDIO()]+/gi` is a character class: it deletes every B, L, A, N, K, U, D,
   I and O, not the token `[BLANK_AUDIO]`. Short real recordings fail as "No speech detected".
4. **Long meetings are summarised from the first ~24,000 characters only** (about 25–30
   minutes of speech). The rest never reaches the model, and the notes don't say so.
5. **A failed summary throws away the transcript.** If Ollama is down or returns junk
   after a 30-minute whisper run, the transcript is discarded with the error. Reprocess
   then repeats the whole transcription.
6. **A broken summary is shown as a real one.** An unparseable or empty model response
   becomes the text "No summary produced." with status done.
7. **Reprocess can wipe your edits and can get stuck.** Re-running rebuilds the notes page
   over any changes you made to it. If the audio fetch fails, the meeting stays in
   "transcribing" and the error goes unhandled.
8. **The whisper model download is only size-checked.** Any file over 100 MB counts as the
   model. No hash check is done, and two downloads at once write to the same `.part` file.
9. **The meetings list loads every transcript.** `meetings.list` returns full transcripts
   and summaries, and progress updates re-send the whole list while a meeting is
   processing.
10. **Starting can leave the microphone open.** `recorder.start` only marks itself as
    recording after the permission prompt resolves. A second start while the prompt is up
    opens a second microphone. A cancel during the prompt doesn't release the microphone
    when access is granted later. If `MediaRecorder` throws (e.g. an unsupported codec),
    the open stream is never stopped. In each case the mic indicator stays lit.

## Proposed outcome

- Quitting while recording asks first. Choosing Save stops the recording, uploads it and
  then quits, so the meeting can be processed next launch. Cancel keeps recording.
- On launch, any meeting stuck mid-pipeline becomes an error. If its audio was saved, the
  error says "Interrupted, use Reprocess". If not, it says the recording was lost.
- The no-speech check strips whisper's non-speech markers (`[BLANK_AUDIO]`, `[Music]`,
  `(silence)` and similar) as tokens, so any real speech of 5 or more characters passes.
- Long transcripts are summarised in sections, then merged into one set of notes, so the
  whole meeting is covered.
- A failed summary saves the transcript and sets an error. Reprocess then summarises from
  the saved transcript without transcribing again.
- An empty or unparseable summary is an error, never a placeholder.
- Reprocess never overwrites a notes page you've edited (it creates a new one), and any
  failure sets an error.
- The model download is checked against its known size and SHA-256 (147,964,211 bytes,
  `a03779c8…6d002`). I confirmed both against Hugging Face's metadata and the copy already
  on this Mac. Concurrent requests share one download.
- The list query returns only what the list shows.
- A start in progress blocks a second start, a cancelled start releases the microphone
  when permission arrives, and a failed start always releases it.

## Affected users and systems

- Anyone recording meetings in the desktop app (mac now, Windows in Phase B).
- Electron main + preload gain three narrow, named calls: a quit-state flag, quit
  confirmation, and summarise-from-transcript. No passthroughs.
- Schema: `meetings.generatedContent` (optional) records what the app last wrote to the
  notes page, so edits can be detected.
- geekspace is public on GitHub, so every commit here is published when it syncs.

## Constraints

- No real meeting audio in tests or probes. Proofs use synthetic audio on the isolated
  worktree backend, and the Ollama tests use a stubbed HTTP server.
- Audio and recording code fails loud (project review standard): every new failure path
  ends in a visible error state, never an empty or placeholder result.

## Out of scope

- **Crash-safe capture (writing audio to disk while recording).** This would cover a hard
  crash or power loss, not just a quit. Recommended for Phase C (C1). The Day Recorder's
  continuous capture needs the same disk spool, and building it once there avoids two
  designs. See the open question.
- Hearing the other side of a call (system audio). That is Phase C.

## Success signals

- Failing-first tests:
  - "Hello world" passes the speech check, and `[BLANK_AUDIO]` alone fails it.
  - A 60,000-character transcript reaches the model in full, across several requests.
  - An unparseable summary throws.
  - A summary failure still returns the transcript.
  - A bad-hash or oversized download is rejected and leaves no file behind.
  - `meetings.list` has no transcript field.
  - Stale in-flight meetings become errors.
  - Reprocess leaves an edited notes page alone.
  - Each of the three recorder start cases ends with the microphone released, or with a
    single microphone open.
- Live: record a short synthetic meeting in the Electron window. Quit mid-recording and
  choose Save, and the meeting survives. Relaunch and an interrupted meeting shows
  Reprocess. Stop Ollama, and the transcript is kept and Reprocess summarises without
  re-transcribing.
- `npm run verify` and `npm run build` pass.

## Open questions

1. Crash-safe capture: Phase C (accepted with the recommendation, 2026-10-15).
