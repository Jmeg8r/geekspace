---
change: 2026-09-29-dev-wait-for-backend
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: `npm run dev` must not race `convex dev` for the Convex port

## Files that change

- `package.json`, the `electron` script only:
  `wait-on tcp:127.0.0.1:5173 && cross-env ...` becomes
  `wait-on -t 120000 tcp:127.0.0.1:5173 tcp:127.0.0.1:3210 && cross-env ...`.
  - `-t` is `wait-on`'s timeout in milliseconds. 120000 is two minutes: enough for
    `convex dev`'s first-run binary download, short enough to fail while someone is
    still watching. A timeout exits 1, and `concurrently -k` in `dev` then stops the
    other two processes, so the failure is loud.
  - Both resources are waited for. Verified with `wait-on` 8.0.5: a missing resource
    fails the whole call.
- `docs/USER-GUIDE.md`:
  - a bullet next to line 34 saying that `npm run dev` waits for the backend on :3210
    before it opens the window, so the app attaches to `convex dev`'s backend;
  - correct the troubleshooting row at line 180 ("App opens but no data (dev only)"),
    which predates the standalone work and now contradicts the code: an unpackaged
    `electron .` with nothing on :3210 starts the bundled backend against the app data
    dir. It says so, and warns about the shared port.
- `README.md`, the dev note around line 168: one sentence pointing at the same fact.

Not changed: `electron/*.mjs` (see the intent's constraints).

## Order of work

1. Edit the `electron` script → verify: `jq -r .scripts.electron package.json` shows the
   new line, and `npm run lint` and `npm run verify` pass.
2. Prove the wait on the branch, using the script's own `wait-on` arguments:
   - nothing on :3210 → exit 1 with `Timed out waiting for: tcp:127.0.0.1:3210`;
   - a listener on :3210 and Vite up → exit 0;
   - both are already proven with `-t 3000` on the un-edited tree; re-run them against
     the edited `package.json` script.
3. **Live probe** (nothing here needs the real data): run the real `npm run dev` from
   the worktree, on a **copy** of the dev Convex state (`.convex/local/default` and
   `.env.local`, both gitignored, deleted afterwards). The check is the app's log lines,
   not the UI, so #41 does not matter → verify: the `[app]` output shows "Attached to an
   already-running Convex backend on :3210" and never "Starting backend", and
   `~/Library/Application Support/Geekspace/convex` is unmodified afterwards (mtime and
   journal files, checked before and after). The `logs/` sibling gets a line appended on
   every unpackaged run today; that is existing behaviour, not part of this check. As
   an extra guard, confirm before the run that `~/.cache/convex/binaries/` still lacks
   the bundled version, so a spawn cannot succeed even if the wait fails.
4. Fault case, on the real script: start Vite alone (`npm run frontend`), leave :3210
   empty, and run `npm run electron` → verify: after 120 seconds it exits non-zero with
   `Timed out waiting for: tcp:127.0.0.1:3210`, and no Electron window opens. (Killing the
   backend script instead would make `concurrently -k` stop everything at once and never
   reach the timeout.)
5. Docs edits → verify: `git diff --stat` shows only those three files plus the change
   folder.
6. Commit, push to the forge, open the PR → verify: CI green (Typecheck & tests, Dependency
   Audit, secret-scan), the ai-review gate reads it.
7. Codex review, posted verbatim → merge on James's approval → comment on #28 that this
   touched only script and docs → close #40 with a link.

## Risks

- **A slow first run** (a backend binary download over a slow link) can exceed the
  2-minute wait. Mitigation: the message names the port, and a re-run finds the binary
  cached. 120000 is documented in the plan, and can be raised in one place.
- **A wait that succeeds for the wrong reason:** if the *installed app* holds :3210, the
  wait passes at once and Electron attaches to it. That is the recorded "don't run both
  at once" case, out of scope here, and unchanged from today.
- **#28 conflict:** #28 rewrites `package.json` (51 lines). It does not edit this
  script line, so a rebase should be trivial.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| script | `jq -r .scripts.electron package.json` | waits for 5173 and 3210, `-t 120000` |
| timeout | the script's `wait-on` call with nothing on :3210 | exit 1, "Timed out waiting for: tcp:127.0.0.1:3210" |
| success | the same with a listener on :3210 and Vite up | exit 0 |
| live | `npm run dev` on a data copy | "Attached to an already-running Convex backend"; no "Starting backend" |
| real data | mtime and journals of `~/Library/Application Support/Geekspace/convex` before and after | unchanged |
| verify | `npm run verify` | pass, 44/44 |
| CI | PR head statuses | green |

## Options not taken

- **A `GEEKSPACE_NO_SPAWN` guard in `convexBackend.mjs`:** with the wait, `npm run dev`
  only reaches Electron once :3210 answers, so the guard adds little, and it edits the
  file #28 rewrites.
- **Removing dev spawning (issue #40's original proposal):** deletes a deliberately built
  capability, and rested on a consequence I had not verified.
- **Docs only, close #40:** leaves the race.

## Deviations

None yet.
