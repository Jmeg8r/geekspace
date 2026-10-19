# gs-capture protocol v1

The contract between `gs-capture run` (native helper) and the Electron supervisor
(`electron/dayRecorder.mjs`, plan PR 3c). The supervisor is built against this document,
and a change here bumps `v`.

## Invocation

```
gs-capture run --media-root <abs dir> [--denylist id,id] [--shot-sec 30] [--duration s]
```

- `--media-root` must be an existing absolute directory. Files go under `<media-root>/<day>/`.
- `--denylist` takes app bundle IDs (`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`, the same shape the
  Convex boundary accepts). The helper refuses an invalid entry.
- `--duration` is for proofs only. The supervisor runs the helper until it stops it.
- **A denylist change means a restart.** The helper reads its arguments once. The supervisor
  stops it and spawns a new one, so there is no in-band control channel to get wrong.

## Output

One JSON object per line on **stdout**, keys sorted. Every line has `"v": 1` and an
`"event"`. Lines are never interleaved: writes are serialized.

| event | fields | meaning |
|---|---|---|
| `ready` | `pid`, `shotSec`, `denylist` | arguments accepted; capture starts |
| `heartbeat` | `t` (epoch ms) | every 5 s, after a fresh Screen Recording check passes |
| `shot` | `day`, `path`, `takenAt`, `appBundleId`, `menuBarBlanked`, `ocrText`, `ocrMs` | a changed frame was written |
| `stopped` | `reason` | clean end (only with `--duration`) |

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

## Failure

On any failure the helper writes `gs-capture: <message>` to **stderr** and **exits non-zero**.
There is no error event. Failures include a missing permission, a ScreenCaptureKit call that
hangs past 10 s (a process-exiting watchdog), an unwritable file, and a menu bar that can't
be found to blank while the denylist is non-empty. The supervisor treats each of these as "Not
recording" (spec R3):

- a non-zero exit, or any exit not preceded by `stopped`;
- no line at all (heartbeat included) for more than 10 s;
- a line that is not valid JSON, or whose `v` is not 1. That line is dropped and logged
  **without its contents**.

## Coming in later PRs

- **3b-2:** `segment` events (system audio: `kind`, `path`, `start`, `end`), plus the tap's
  `tapRebuilt`/`tailDropped`/`sessionUnverified`, carried over from the spike form.
- **3b-3:** `audioUse` events from the process watcher (PR 4's mic pause and call detection).
