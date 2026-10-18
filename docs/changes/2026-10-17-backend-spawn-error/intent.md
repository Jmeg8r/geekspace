---
change: 2026-10-17-backend-spawn-error
status: draft
track: T1
author: claude
accepted_by: pending
linear: pending
source: follow-up reported in forge PR #68 (prebake-spawn-error), "Reported, not changed: electron/convexBackend.mjs"
---
# Intent: a backend that fails to spawn must fail fast and cleanly at app startup

## Problem

`electron/convexBackend.mjs` `startOrAttach()` spawns the bundled `convex-local-backend`
with `--instance-secret <secret>` in argv and attaches no `error` listener. When the spawn
fails asynchronously (EACCES, ENOENT), the probe in plan.md shows, in a real Electron 42
main process:

1. **Raw crash dialog.** The `error` event is unhandled, so it becomes an uncaught
   exception and Electron's default handler shows "A JavaScript error occurred in the main
   process" with the stack. On macOS that dialog is modal and blocks the main thread.
2. **30 s hang.** Node emits no `exit` for a never-spawned child, so `exitInfo` is never set
   and `waitHealthy` polls the full 30 s before "did not become healthy within 30000ms".
   The real cause (EACCES) never reaches the "Geekspace couldn't start" dialog or the log.
3. **5 s more on quit.** `managed` is true and `child` is non-null, so `stopBackend()`
   (run from `before-quit`) sends SIGTERM to nothing and waits out its 5 s SIGKILL timer.

**The instance secret does not leak today.** Electron's default handler prints
`error.stack`, which has no `spawnargs`; the probe found 0 hits by value in stdout, stderr
and `convex.log` (positive control: 1 hit in `config.json`). The secret is still one
`console.error(err)` away: the error object carries it in `spawnargs`, and any future
`uncaughtException` handler or log line that inspects the object would print it.

## What "done" looks like

With a non-executable dummy binary (temp appData, `GEEKSPACE_CONVEX_BINARY`; the shared
`~/.cache` binary is never touched):

1. `startOrAttach()` rejects in well under 1 s with `Convex backend failed to start: EACCES`
   — no uncaught exception, no Electron crash dialog, no `spawnargs` in the message.
2. The failure is written to `convex.log` (code only), so "Open Log Folder" shows it.
3. `stopBackend()` and `killBackendSync()` return immediately for the never-spawned child.
4. The secret appears nowhere in output or log, by value (with a positive control).
5. A vitest unit test fails before the fix and passes after.

## Out of scope

- A global `process.on("uncaughtException")` handler in `electron/main.mjs` — a policy
  decision (log? quit? show what?) bigger than this fix.
- A shared `spawnBackend()` helper across prebake, the probe and this file (same reason
  as PR #68: three call sites with different stdio/lifecycle needs).
