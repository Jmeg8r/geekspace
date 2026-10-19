# gs-capture protocol v1

The contract between `gs-capture run` (native helper) and the Electron supervisor
(`electron/dayRecorder.mjs`, plan PR 3c). The supervisor is built against this document,
and a change here bumps `v`.

## Invocation

```
gs-capture run --media-root <abs dir> [--denylist id,id] [--shot-sec 30] [--segment-sec 300] [--duration s]
```

- `--media-root` must be an existing absolute directory. Files go under `<media-root>/<day>/`.
- `--denylist` takes app bundle IDs (`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`, the same shape the
  Convex boundary accepts). The helper refuses an invalid entry.
- `--segment-sec` is `SEGMENT_SEC` (spec R2), at least 2. Values below 300 are for proofs.
- `--duration` is for proofs only. The supervisor runs the helper until it stops it.
- **Stopping:** the supervisor sends `SIGTERM` (or `SIGINT`). The helper stops the tap,
  settles the held tail, finalizes the open segment, writes `stopped` with
  `"reason": "signal"` and exits 0. Audio still held back at that moment is released only
  if no new denylisted process appeared since the last poll; otherwise it is dropped
  (`tailDropped`).
- **A denylist change means a restart.** The helper reads its arguments once. The supervisor
  stops it and spawns a new one, so there is no in-band control channel to get wrong.

## Output

One JSON object per line on **stdout**, keys sorted. Every line has `"v": 1` and an
`"event"`. Lines are never interleaved: writes are serialized.

| event | fields | meaning |
|---|---|---|
| `ready` | `pid`, `shotSec`, `segmentSec`, `denylist` | arguments accepted; capture starts |
| `heartbeat` | `t` (epoch ms) | every 5 s, after a fresh Screen Recording check passes |
| `shot` | `day`, `path`, `takenAt`, `appBundleId`, `menuBarBlanked`, `ocrText`, `ocrMs` | a changed frame was written |
| `segment` | `kind`, `day`, `path`, `start`, `end`, `peak` | a finished system-audio segment was written |
| `tapRebuilt` | `t`, `droppedWindows`, `droppedMaxRms`, `addedProcesses`, `addedBundles`, `excludedProcesses`, `rebuildMs` | a new denylisted process appeared; held audio was dropped and the tap rebuilt |
| `tailDropped` | `t`, `droppedWindows`, `droppedMaxRms`, `addedProcesses`, `addedBundles` | at stop, a denylisted process appeared after the last poll; the held tail was dropped |
| `sampleRateChanged` | `t`, `from`, `to` | a rebuilt tap runs at a new rate (output device changed); later segments use it |
| `sessionUnverified` | `t`, `livedMs`, `endedBy` | a tap session ended before its first IO cycle could be expected (under 200 ms); informational |
| `stopped` | `reason` | clean end: `duration` (proofs) or `signal`. Always the **last** line: nothing is written after it |

More detail on the fields:

- **`shot.path`** is `<day>/shot-HHmmss-SSS.heic`, relative to the media root. That is the
  shape `dayRecorder.addScreenshot` accepts. Files are written atomically, so a path is never
  announced for a partial file.
- **`shot.appBundleId`** is the app that owns the menu bar, sampled before and after the
  capture. It is `null` when either sample is denylisted (when a work app was in use is
  information too), when the two samples differ, or when no app owns the menu bar. The
  supervisor stores `null` by **omitting** `appBundleId` (it is optional in
  `dayRecorder.addScreenshot`), never by guessing.
- **`shot.menuBarBlanked`** is `true` whenever the denylist is non-empty. The menu-bar band is
  then painted black before hashing, encoding and OCR, because a switch to a denylisted app
  *during* a capture can't be observed (plan.md, PR 3b-1).
- **`shot.ocrText`** is the full OCR text of the frame. **It must never reach a log.** It goes
  only into Convex (`screenshots.ocrText`). The same rule applies to any future field that
  carries captured content.
- Unchanged frames (dHash within 8 bits on a 32-wide grid) produce no line. The heartbeat
  still does.
- **`segment`** is system audio from the CoreAudio tap, with the denylist excluded by bundle
  ID (each entry plus `<id>.helper`) and by live process object.
  - `kind` is always `"system"` from the helper. Mic segments come from the renderer (PR 3d).
  - `path` is `<day>/sys-HHmmss-SSS.m4a`: mono AAC, 32 kbps, at the tap's sample rate. It
    is the shape `dayRecorder.addSegment` accepts. `day` is the local day the segment
    *started*. A segment closes at `--segment-sec`, at local midnight, at a tap rebuild, at
    stop, and when delivery resumes more than 500 ms away from where the segment's samples
    end (sleep and wake, a clock step). One file never mixes sample rates.
  - Each file is a complete container that decodes on its own (spec R2). It is written as
    a hidden `.partial-` file, read back after it is finalized and only then renamed and
    announced, so a path is never announced for a partial or unreadable file.
  - `start` and `end` are epoch ms. `end` is computed from the samples written, so the
    file's own timeline matches `[start, end]`. Audio dropped by a rebuild is a gap
    *between* segments (about 0.5–0.6 s), never inside one.
  - `peak` (0–1) is the loudest sample. A silent segment is normal (nothing was playing);
    whether to skip transcribing it is PR 5's decision.
- **`tapRebuilt` / `tailDropped`** carry only counts, levels and bundle IDs, never audio.
  Detection is the 100 ms poll of live processes only. A denylisted process that starts and
  exits between two polls is not seen: see plan.md, "open risk", and the follow-up PR.
  `droppedMaxRms` above 0 means the drop discarded audible audio.

## Failure

On any failure the helper writes `gs-capture: <message>` to **stderr** and **exits non-zero**.
There is no error event. Failures include a missing permission, a ScreenCaptureKit call that
hangs past 10 s (a process-exiting watchdog), an unwritable file, and a menu bar that can't
be found to blank while the denylist is non-empty. On the audio side they include a tap that
delivers no samples within 1 s of being (re)built or stops delivering for 1 s at any point
(an output device unplugged), a tap buffer whose channel layout is not
the tap's, and a segment that cannot be written, finalized or read back. The supervisor
treats each of these as "Not recording" (spec R3):

- a non-zero exit, or any exit not preceded by `stopped`;
- no line at all (heartbeat included) for more than 10 s;
- a line that is not valid JSON, or whose `v` is not 1. That line is dropped and logged
  **without its contents**.

## Coming in later PRs

- **3b-3:** `audioUse` events from the process watcher (PR 4's mic pause and call detection).
