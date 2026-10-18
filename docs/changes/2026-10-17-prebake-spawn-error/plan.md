---
change: 2026-10-17-prebake-spawn-error
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: handle prebake's backend spawn errors without leaking the instance secret

## Files that change

- `scripts/prebake-seed.mjs` — the only code change.
- `docs/changes/2026-10-17-prebake-spawn-error/` — this folder.

## Order of work

1. Pre-fix control → verify: with the harness below, the unfixed script prints a secret
   value and/or leaves a `gs-prebake-*` dir. Recorded here under **Proof**.
2. Fix, copying PR #66's pattern (commit 10803fa):
   - `child.on("error", …)` stores the error; `waitHealthy(child, spawnError)` rethrows it
     as `backend failed to start: <code>` (the original carries `spawnargs`).
   - `waitHealthy` **throws** instead of calling `die()`, so the `finally` runs on every
     startup failure (today `die()` = `process.exit` skips it).
   - The `finally`'s stop skips a child with no `pid` (never spawned, never emits `exit`;
     today it would wait out the 5 s SIGKILL timer).
   - On failure, the `finally` also removes `WORK` (today it is removed only on success,
     so every failure leaves `selfhosted.env` + `config.json` behind).
3. Post-fix proof → verify: same harness, assertions below pass.
4. `npm run verify` → verify: green, output recorded.

## Risks

- Removing `WORK` on failure also removes `backend.log`, which helped debug a failed bake.
  The log is not printed either (it may contain secrets); the error message itself
  (code / exit code / timeout) is the signal, and the bake is re-runnable. If James wants the log kept, the alternative is deleting
  only `selfhosted.env` and `config.json`.
- Failures *after* the `finally` (snapshot copy) still leave `WORK`; unchanged, out of scope.

## Proof

Harness (never chmods the shared `~/.cache` copy):

```
H=$(mktemp -d); mkdir -p "$H/.cache/convex/binaries/<pinned>"
cp ~/.cache/convex/binaries/<pinned>/convex-local-backend "$H/.cache/convex/binaries/<pinned>/"
chmod 644 "$H/.cache/.../convex-local-backend"     # passes the hash check, spawn → EACCES
T=$(mktemp -d); HOME=$H TMPDIR=$T node scripts/prebake-seed.mjs > out.txt 2>&1; rc=$?
```

Assertions: `rc == 1`; for each of `adminKey`, `instanceSecret` from
`.convex/local/default/config.json`, `grep -cF <value> out.txt` is 0 (by value, never
printed); positive control: grep for a string known to be in the output
(`prebake work dir`) returns ≥1; `ls $T | grep gs-prebake-` is empty.

The harness uses a fake `.convex/local/default/config.json` with dummy, distinctive
`adminKey`/`instanceSecret` values (the binary never runs, so real secrets are not needed),
and removes it afterwards.

### Pre-fix control (origin/main 4f39fe7, 2026-10-17)

```
rc=1
positive control 'prebake work dir': 1
instanceSecret hits: 1        ← printed inside spawnargs of the unhandled 'error' event
adminKey hits: 0
leftover dirs in TMPDIR: 1 [gs-prebake-by6C5K]
  contents: backend.log config.json selfhosted.env
```

## Reported, not changed: electron/convexBackend.mjs

Same spawn shape (`--instance-secret` in argv, no `error` listener). In the Electron main
process an unhandled spawn `error` becomes an uncaught exception (no
`process.on("uncaughtException")` handler in `electron/main.mjs`); `waitHealthy` there would
otherwise wait the full 30 s because `exitInfo` is never set. Whether Electron's crash
dialog / stderr prints `spawnargs` is unverified. Proposed as a separate follow-up change.

## Options not taken

- Extracting a shared `spawnBackend()` helper for prebake, the probe and convexBackend —
  three call sites with different stdio/lifecycle needs; a refactor beyond this fix.
