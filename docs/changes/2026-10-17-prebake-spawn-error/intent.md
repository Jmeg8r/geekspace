---
change: 2026-10-17-prebake-spawn-error
status: draft
track: T1
author: claude
linear: pending
source: side session from forge PR #66 Codex round 1 [P2] (scripts/probe-schema-failure.mjs, commit 10803fa)
---
# Intent: a failed backend spawn in prebake must not leak the instance secret or leave secrets on disk

## Problem

`scripts/prebake-seed.mjs` runs on every `npm run package`. It spawns the pinned
`convex-local-backend` with `--instance-secret <secret>` in argv and attaches no `error`
listener. If the spawn fails asynchronously (EACCES on a binary that passed its hash check,
ENOENT), Node dies on the unhandled `error` event and prints the error object, whose
`spawnargs` contain the instance secret. The `finally` never runs, so the temp work dir
`gs-prebake-*` stays on disk with `selfhosted.env` (admin key) and `config.json`
(admin key + instance secret).

Two neighbouring paths have the same cleanup gap: `waitHealthy` calls `die()`
(`process.exit`) from inside the `try`, which also skips the `finally`; and the work dir is
only removed on the success path, so any thrown failure leaves it behind.

Forge PR #66 fixed the identical bug in `scripts/probe-schema-failure.mjs` (commit 10803fa).

## What "done" looks like

With a non-executable copy of the pinned binary (HOME pointed at a temp dir; the shared
`~/.cache` copy is never touched), `node scripts/prebake-seed.mjs`:

1. exits 1 with a message naming the error code only;
2. prints none of the secret values from `.convex/local/default/config.json` (checked by
   value, with a positive control);
3. leaves no `gs-prebake-*` dir in the temp dir.

A pre-fix run of the same setup shows the leak (secret in output and/or leftover dir).

## Out of scope (reported, not changed)

`electron/convexBackend.mjs` has the same spawn shape with no `error` listener; see plan.md.
