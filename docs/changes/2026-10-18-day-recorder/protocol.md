# gs-capture protocol v1

The contract between `gs-capture run` (native helper) and the Electron supervisor
(`electron/dayRecorder.mjs`, plan PR 3c). The supervisor is built against this document,
and a change here bumps `v`.

## Invocation

```
gs-capture run --media-root <abs dir> [--denylist id,id] [--shot-sec 30] [--segment-sec 300]
               [--call-hold-max-sec 1800] [--duration s]
```

- `--media-root` must be an existing absolute directory. Files go under `<media-root>/<day>/`.
- `--denylist` takes app bundle IDs (`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`, the same shape the
  Convex boundary accepts). The helper refuses an invalid entry.
- `--segment-sec` is `SEGMENT_SEC` (spec R2), at least 2. Values below 300 are for proofs.
- `--duration` is for proofs only. The supervisor runs the helper until it stops it.
- **Stopping:** the supervisor sends `SIGTERM` (or `SIGINT`). The helper stops the tap,
  settles the held tail, finalizes the open segment, waits up to 2 s for OCR still in
  flight (60 s at the end of a `--duration` run), writes `stopped` with
  `"reason": "signal"` and exits 0. Audio still held back at that moment is released only
  if no new denylisted process appeared since the last poll; otherwise it is dropped
  (`tailDropped`).
- Signal handling is installed **before** `ready`, so any stop after `ready` ends with
  `stopped`. A signal sent before `ready` can arrive while the process is still starting up
  and end it with the default disposition (exit 143, no lines). Nothing has been captured at
  that point. A supervisor that stops a helper before its `ready` should expect this.
- **A denylist change means a restart.** The helper reads its arguments once. The supervisor
  stops it and spawns a new one. The only in-band control is the call hold (Commands, below).
- `--call-hold-max-sec` caps how much call audio is held (default 1800: the 15-minute notice
  timeout plus its one extension). Audio past the cap is not held; `callReleased` says so.

## Commands (plan PR 4a)

The supervisor writes one command per line on the helper's **stdin**. They drive the call
hold (spec R5, F3): while a call waits for its recording notice, system audio is kept **in
memory only** and reaches disk only after the notice.

- `call hold`: the open system segment is finalized (so it holds no call audio), and from
  here released tap audio is kept in memory as 16 kHz mono 16-bit PCM (32 KB/s, about 58 MB
  at the default cap). Writes `callHeld`.
- `call release`: the notice was given. The held audio is written as `segment` lines with
  `"kind": "call"` and `call-HHmmss-SSS-<epochMs>.m4a` names (16 kHz mono AAC, at most
  `--segment-sec` each, a new file at any gap), then `callReleased`. Recording continues as
  usual (`sys-` segments) after it.
- `call discard`: declined or timed out. The held audio is dropped, never written. Writes
  `callDiscarded` with `"reason": "command"`.
- A stop (signal) while a call is held drops it the same way, with `"reason": "stop"`.
- An unknown command, `call hold` while one is held, or `call release`/`call discard` with
  none held is a supervisor bug: the helper fails (stderr, non-zero exit).
- The commands carry no notice id. The supervisor attaches the `noticeGiven` event it
  released with to each `call` segment, and stores a `call` segment only after it sent
  `call release` (Convex `addSegment` refuses one without a given notice too).

## Output

One JSON object per line on **stdout**, keys sorted. Every line has `"v": 1` and an
`"event"`. Lines are never interleaved: writes are serialized.

| event | fields | meaning |
|---|---|---|
| `ready` | `pid`, `shotSec`, `segmentSec`, `denylist` | arguments accepted; capture starts |
| `heartbeat` | `t` (epoch ms) | every 5 s, after a fresh Screen Recording check passes |
| `shot` | `day`, `path`, `takenAt`, `appBundleId`, `menuBarBlanked`, `ocrText`, `ocrMs` | a changed frame was written |
| `segment` | `kind`, `day`, `path`, `start`, `end`, `peak` | a finished system-audio segment was written |
| `tapRebuilt` | `t`, `trigger`, `arrivedBundles`, `droppedWindows`, `droppedMaxRms`, `addedProcesses`, `addedBundles`, `excludedProcesses`, `rebuildMs` | a new denylisted process appeared; held audio was dropped and the tap rebuilt |
| `tailDropped` | `t`, `droppedWindows`, `droppedMaxRms`, `arrivedBundles`, `unjudged`, `addedProcesses`, `addedBundles` | at stop, a denylisted process appeared after the last poll; the held tail was dropped |
| `sampleRateChanged` | `t`, `from`, `to` | a rebuilt tap runs at a new rate (output device changed); later segments use it |
| `sessionUnverified` | `t`, `livedMs`, `endedBy` | a tap session ended before its first IO cycle could be expected (under 200 ms); informational |
| `audioUse` | `t`, `app`, `denylisted`, `input`, `output` | an app started or stopped using audio input or output |
| `stopped` | `reason` | clean end: `duration` (proofs) or `signal`. Always the **last** line: nothing is written after it |

More detail on the fields:

- **`shot.path`** is `<day>/shot-HHmmss-SSS-<epochMs>.heic`, relative to the media root. That
  is the shape `dayRecorder.addScreenshot` accepts. The local time is for people; the epoch
  milliseconds keep the name unique when local time repeats in the DST fall-back hour. A shot
  is written whole under a hidden name and then linked into place, so a path is never
  announced for a partial file and an existing file is never replaced (the helper fails
  instead).
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
- **OCR runs off the capture loop** (`OCRQueue.swift`). A `shot` line is written when its
  OCR finishes, so it can arrive well after `takenAt`: the first OCR in a process can take
  ~36–52 s. Lines still arrive in capture order. At most 4 frames wait for OCR; while all 4
  slots are taken, the next capture waits rather than being dropped. A shot whose OCR hasn't
  finished by the stop deadline is never announced. Its file is an orphan, which the
  retention sweep removes.
- **`segment`** is system audio from the CoreAudio tap, with the denylist excluded by bundle
  ID (each entry plus `<id>.helper`) and by live process object.
  - `kind` is always `"system"` from the helper. Mic segments come from the renderer (PR 3d).
  - `path` is `<day>/sys-HHmmss-SSS-<epochMs>.m4a`: mono AAC, 32 kbps, at the tap's sample
    rate, named for the segment's start as shots are, and placed the same way: never over an
    existing file. It is the shape `dayRecorder.addSegment` accepts. `day` is the local day the segment
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
- **`audioUse`** (plan PR 3b-3) reports an app's audio input and output when either
  changes. It is polled every 100 ms, because on macOS 27.0 the listeners never fire for
  mic use (spike Q3). It exists for PR 4's mic pause (spec F2) and call detection (F3).
  - `app` is the owning app's bundle ID: the process's own app, else its parent's (a
    Chromium `<id>.helper` maps to the browser). An app with no name at all is not
    reported.
  - **Every denylisted app is folded into ONE entry** with `app: null` and
    `denylisted: true`. Its `input`/`output` are true while any denylisted app uses audio.
    A denylisted app is never named, by the same rule as `shot.appBundleId`. "Denylisted"
    includes everything in the tap's current exclusion, such as a helper orphaned from a
    denylisted app (PR #78), so the mic pause and the tap never disagree.
  - Ignored: `com.apple.replayd` and `com.apple.avconferenced`, which report input for our
    own capture (spike Q3, Q4); the helper itself; and the supervisor with every process it
    started (Electron's renderer records the mic).
  - At start, every app already using audio is reported once. After that, only changes
    are reported. `input: false, output: false` means the app stopped.
- **`callHeld`** (`t`), **`callReleased`** (`segments`, `heldSec`, `overflowed`) and
  **`callDiscarded`** (`heldSec`, `reason`: `command` or `stop`) report the call hold with
  counts only, never audio.
- **`tapRebuilt` / `tailDropped`** carry only counts, levels and bundle IDs, never audio.
  **Their bundle fields can name a denylisted app** (`addedBundles`, `arrivedBundles`).
  They are diagnostics. The supervisor must not store or log them, or `audioUse`'s and
  `shot`'s anonymity would be undone (PR 3c).
  `trigger` is `listener` when the HAL's process-list notification reported a denylisted
  process being added (`arrivedBundles`; `unclassified` for one that was already exiting), and
  `poll` when only the 100 ms poll of live processes found it. The listener catches a process
  that starts and exits between polls. `tailDropped.unjudged: true` means arrivals were still
  being judged when the stop's 5 s deadline ran out, so the tail was dropped unjudged.
  `droppedMaxRms` above 0 means the drop discarded audible audio.

## Failure

On any failure the helper writes `gs-capture: <message>` to **stderr** and **exits non-zero**.
There is no error event. Failures include a missing permission, a ScreenCaptureKit call that
hangs past 10 s (a process-exiting watchdog), an unwritable file, and a menu bar that can't
be found to blank while the denylist is non-empty. On the audio side they include a tap that
delivers no samples within 1 s of being (re)built or stops delivering for 1 s at any point
(an output device unplugged), process classification that has not completed a pass for 5 s
(held audio can't be judged, so it is never released unjudged), a tap buffer whose channel layout is not
the tap's, and a segment that cannot be written, finalized or read back. The supervisor
treats each of these as "Not recording" (spec R3):

- a non-zero exit, or any exit not preceded by `stopped`;
- no line at all (heartbeat included) for more than 10 s;
- a line that is not valid JSON, or whose `v` is not 1. That line is dropped and logged
  **without its contents**.

