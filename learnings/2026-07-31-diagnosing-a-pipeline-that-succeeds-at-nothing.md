# Diagnosing a pipeline where every stage succeeds and the output is worthless

**Date:** 2026-07-31
**Context:** "Since the last changes to this app the meeting recording no longer works."
Geekspace records mic audio → ffmpeg → whisper.cpp → Ollama summary. Two 40+ minute
meetings produced garbage notes while reporting `status: "done"`.

## The problem (one line)
A recording pipeline captured 43 minutes of digital silence and every stage — permission,
capture, upload, conversion, transcription, summarization — reported success.

## The approach (plain steps)
1. **Distrust the symptom report AND the code.** "No longer works" says nothing about
   *where*. Before reading a single line of the pipeline, list every gate that could
   produce it (bridge present, tools found, permission, entitlement, post-stop pipeline)
   so you know what evidence would discriminate between them.
2. **Ask the machine, not the source.** ffmpeg/whisper/model/Ollama all present; TCC said
   mic *granted*; `codesign -d --entitlements` proved the entitlement was really in the
   signature of both the app and the renderer helper. Four hypotheses eliminated with
   shell commands, zero by reading code.
3. **Find where the failure recorded itself.** The app stores meetings in a local Convex
   SQLite. Querying every completed meeting gave a **regression timeline** in one shot:
   nine good transcripts (10k–54k chars), then two of 631 and 347 chars reading
   `"you you you…"` — whisper's known hallucination on silence.
4. **Measure the payload, not its interpretation.** The transcript is whisper's *opinion*
   of the audio. Run `ffmpeg -af volumedetect` on the stored blob: `mean -91.0 dB`. That
   is not "quiet", it is all-zero samples. The bug is upstream of everything I'd been
   reading.
5. **Reproduce outside the app to split app vs environment.** Enumerate inputs
   (`system_profiler SPAudioDataType`), then capture 3s from each with ffmpeg. The system
   default input measured −91.0 dB; the real mic measured −42.9 dB. Same silence with
   Geekspace not running ⇒ environmental. Root cause: macOS had made a Bluetooth
   *speaker* the default input; its HFP endpoint advertises a 16 kHz mono input that
   emits nothing. `getUserMedia` opened it happily.
6. **Fix the cause, then harden the class.** Tell the user to change the device (theirs to
   do); in code, add device pinning, a live silence warning, and a level gate before
   transcription.

## The judgment calls (what was NOT done, and why)
- **Did not accept the user's "since the last changes" premise — but did not dismiss it on
  the timeline either.** The timeline was *consistent* with a regression (last good run
  predated the last commits). Only the mechanism settled it: the diff was purely additive
  IPC handlers, and the silence reproduced with the app closed. **Verify a premise by
  mechanism; timeline correlation is not enough to confirm or deny.**
- **Did not pattern-match whisper's hallucinations.** The existing guard stripped
  `[BLANK_AUDIO]`; the obvious "fix" is to also match `"you"`, `"Thank you."`,
  `"Thanks for watching!"`. That is an unwinnable arms race against a model's output.
  Gate the *signal* instead — it catches every silent-input cause, and fails in seconds
  instead of after a 30-minute whisper run.
- **Did not invent threshold numbers.** Calibrated dB floors from the user's own
  recordings. This exposed a case round numbers would have missed: one failure peaked at
  −13 dB (loud) but averaged −76.5 dB, so a peak-only gate passes it. **Both** floors were
  required, and only real failure data showed that.
- **Did not change the OS setting or merge without being asked.** System settings and
  one-way doors stay with the user.
- **Did not add a React testing stack** to test one call-site bug. Extracted the decision
  into a pure function (`resolveMicChoice`) and tested that instead.

## The reusable rule
**When every stage reports success but the output is worthless, stop reading code and
measure the actual payload at each boundary — the defect is upstream of everything
reporting OK.** A stage that "succeeds" on an empty input is not evidence of health.
Prefer a check on the physical signal (bytes, dB, row counts) over a check on some
downstream component's interpretation of it.

Two corollaries earned the hard way in the same session:

- **A detector that counts ticks lies when throttled.** My silence warning did
  `silentMs += 120` per `setInterval` tick; browsers throttle background windows to ~1 Hz,
  so it ran 8× slow — exactly when a meeting window is minimized. Measure elapsed *reality*
  (`Date.now()` deltas), never iterations. A monitor with the same failure mode as the
  thing it monitors is worse than none.
- **"No error" and "not run" are indistinguishable — assert a positive.** A cleanup `rm`
  silently did nothing when a zsh glob failed to match and aborted the command; a
  CodeRabbit thread auto-resolved on force-push and was stamped "✅ Addressed" by commits
  that only moved line numbers; `pr_review_gate.py` returned SAFE while the review was
  still running and about to file a Major bug. In all three, the absence of a complaint
  was read as success. Re-check the state itself.
