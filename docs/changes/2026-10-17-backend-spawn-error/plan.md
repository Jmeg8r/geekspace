---
change: 2026-10-17-backend-spawn-error
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: handle the runtime backend's spawn errors in convexBackend.mjs

## Files that change

- `electron/convexBackend.mjs` — the only code change.
- `tests/convexBackend.test.ts` — new unit test.
- `docs/changes/2026-10-17-backend-spawn-error/` — this folder, including `probe/`.

## Order of work

1. Pre-fix probe → verify: hang + crash dialog reproduced, secret absent (done; **Proof**).
2. Failing test, committed before the fix → verify: `npx vitest run tests/convexBackend.test.ts`
   fails on the current code. It mocks `electron` (`app.getPath` → temp dir,
   `isPackaged: false`), stubs `fetch` to reject (so a dev `convex dev` on :3210 can't make
   it attach), writes a dummy `config.json`, points `GEEKSPACE_CONVEX_BINARY` at a 0644
   file, and asserts:
   - `startOrAttach()` rejects with `/failed to start: EACCES/` within 5 s, and the message
     does not contain the dummy secret;
   - no `uncaughtException` fired;
   - `stopBackend()` resolves in < 1 s and `killBackendSync()` doesn't throw.
   (Skipped on Windows, where file mode doesn't block execution.)
3. Fix, same pattern as PR #68 (`scripts/prebake-seed.mjs`) / PR #66:
   - `child.on("error", …)` records `spawnError` (reset to null per spawn) and logs
     `Backend failed to start: <code>` — code only, never the error object.
   - `waitHealthy` checks `spawnError` after each probe, before `exitInfo`, and throws
     `Convex backend failed to start: <code>. See <log>`.
   - The `error` handler also clears `child`, so `stopBackend` / `killBackendSync` hit their
     existing `!child` early return for a never-spawned process.
4. Post-fix probe + test → verify: assertions in **Proof** flip.
5. `npm run verify`, `snyk test` → verify: green / no new issues; output recorded.

## Risks

- `error` can also fire for a *running* child (a failed `kill()`). Clearing `child` then
  would orphan the process on quit. Guard: only treat it as a spawn failure when
  `child.pid === undefined`; otherwise just log the code.

## Proof

Harness: `probe/run.sh <repo> <out>` runs `probe/main.mjs` in real Electron with a temp
appData holding a dummy `config.json` (distinctive fake `instanceSecret`) and a 0644 dummy
binary via `GEEKSPACE_CONVEX_BINARY`. It replaces `dialog.showErrorBox` with a logger so
the run is unattended (in the real app that modal blocks the main thread until dismissed,
so the 30 s wait starts after the user clicks OK). :3210 was free (`lsof` empty).

### Pre-fix (origin/main 4f39fe7, Electron 42.11.8, 2026-10-17)

```
rc=0 wall=35s
positive control '[probe': 4
secret hits in stdout/stderr: 0
secret hits in convex.log: 0
grep-by-value positive control (config.json): 1
[probe +0.1s] uncaughtException listeners: 1          ← Electron's own default handler
[probe +0.1s] showErrorBox title="A JavaScript error occurred in the main process"
              body="Uncaught Exception:\nError: spawn $A/fake-backend EACCES\n    at ..."
[probe +30.3s] startOrAttach rejected: Convex backend did not become healthy within 30000ms.
[convexBackend] Stopping backend (SIGTERM)…
[convexBackend] Backend did not exit in time — SIGKILL.   ← +5 s for a never-spawned child
[probe +35.3s] stopBackend + killBackendSync returned
```

### Post-fix

_(filled in during step 4)_

## Deviations

_(none yet)_
