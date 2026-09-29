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

Results of the plan's proofs, run 2026-09-29, and the departures from the plan text.

- **Wait proof (step 2), with the script's own arguments and `-t 3000`:** neither port up
  → exit 1, "Timed out waiting for: tcp:127.0.0.1:5173, tcp:127.0.0.1:3210"; 5173 up and
  3210 down (the race) → exit 1, "Timed out waiting for: tcp:127.0.0.1:3210"; both up →
  exit 0. `wait-on` prints a stack trace after the message, but the message is the first
  line.
- **Live probe (step 3), real `npm run dev`:** the `[app]` output shows the wait-on line,
  `convex dev` reporting functions ready at 15:15:44, and then
  "Attached to an already-running Convex backend on :3210" at 19:15:49Z (15:15:49 local).
  0 lines of "Starting backend" and 0 of "binary not found". The real data dir
  (`~/Library/Application Support/Geekspace/convex`) was identical before and after: 391
  files with the same mtimes and sizes, the same sqlite SHA-256 prefix (`84eeb4477b876ca9`),
  and no journal files.
- **What that probe does and does not show.** The worktree's Electron binary was not
  installed (it was set up with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`), so `electron .`
  downloaded it after the wait returned, which itself delayed the window by several
  seconds. The run confirms the intended order and the attach. It does not prove by
  itself that the race would have hit without the fix; that rests on the 2026-09-29
  observation in the intent (the data-dir warning logged while `convex dev` was still
  downloading) and on step 2's case B. I did not run the un-fixed script as a control,
  because a spawn on the installed app's data dir is the hazard being closed.
- **Fault case (step 4), real script:** Vite stand-in on :5173, nothing on :3210,
  `npm run electron` → exit 1 after 122 seconds with "Timed out waiting for:
  tcp:127.0.0.1:3210", and no Electron process was started.
- **The step 3 guard held but was not needed:** `~/.cache/convex/binaries/` had only
  `precompiled-2026-09-28-5c7cb5b`, not the bundled `precompiled-2026-07-21-82d5e9f`.
- **`convex dev` regenerated three files under `convex/_generated/`** (the same
  drift seen while probing #39: a missing `lib/predicates` entry and a typed `env`).
  Reverted, to keep this change to script and docs.
- **`USER-GUIDE.md` row "App opens but no data (dev only)" was replaced,** not only
  supplemented: it predates the standalone work and contradicted what `startOrAttach`
  does. That is outside the plan's literal "one sentence" but inside its intent.
- **Process slip while cleaning up:** `pgrep -f` matched my own tool shell, whose command
  text held the worktree name, and I killed it. No effect on the work. The rest of the
  cleanup used a bracketed pattern (`[g]eekspace-devwait`) that cannot match itself.
