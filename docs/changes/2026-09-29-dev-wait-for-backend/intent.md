---
change: 2026-09-29-dev-wait-for-backend
status: draft
track: T1
author: james
accepted_by:
linear: pending
source: conversation
---
# Intent: `npm run dev` must not race `convex dev` for the Convex port

## Problem

Issue #40, corrected in its own comment thread (2026-09-29). The documented contract is that
in dev the backend is `convex dev`'s, with data in the repo's `.convex/`, while the
packaged app owns `~/Library/Application Support/Geekspace/` (`docs/USER-GUIDE.md:34`,
README).

`npm run dev` starts `convex dev`, Vite and Electron together, and the `electron` script
waits only for Vite (`wait-on tcp:127.0.0.1:5173`). So Electron can reach
`startOrAttach()` before `convex dev`'s backend is listening on :3210, find nothing
healthy, and take the **spawn** path: ensure the app data dir, then start the bundled
binary against `~/Library/Application Support/Geekspace/convex`. Observed 2026-09-29: at
12:27:59Z the app logged the data-dir version warning (past the spawn decision) while
`convex dev` was still on "Downloading Convex backend binary". It did not spawn only
because the bundled-version binary was not in the convex CLI cache on that machine.

The unpackaged spawn path is deliberate (dev-cache binary lookup, repo-seeded data dir),
so this is a startup-ordering bug, not a reason to remove the path.

## Proposed outcome

- `npm run dev` opens Electron only after something is answering on :3210, so the app
  attaches to `convex dev`'s backend and never starts its own from that command.
- If nothing answers within a bounded time, the dev loop fails with a message that names
  the port, instead of hanging or falling through to the app's real data.
- The docs say what an unpackaged app does when it finds nothing on :3210.

## Affected users and systems

- geekspace developers running `npm run dev`. geekspace is public on GitHub, so every
  commit here is published when it syncs.
- Open PR #28 rewrites and reformats `electron/convexBackend.mjs`. This change does not
  touch that file, to avoid a conflict. #28 does not edit the `electron`, `dev` or
  `dev:web` script lines.

## Constraints

- No change to `electron/*.mjs`: the deliberate unpackaged spawn path stays.
- Cross-platform: the fix uses `wait-on`, which the `electron` script already uses on
  Windows and macOS.
- The wait is bounded, so a drifted port (the 2026-07-16 blank-screen incident) fails
  loudly rather than silently.
- No real user data is touched while verifying.

## Out of scope

- Running `npm run dev` while the installed app holds :3210. The recorded mitigation is
  "don't run both at once"; this change does not detect it.
- `convex dev` choosing another port when :3210 is busy.
- Stale persisted UI ids blanking the app (#41).

## Success signals

- `npm run electron`'s command line waits for both `tcp:127.0.0.1:5173` and
  `tcp:127.0.0.1:3210`, with a timeout.
- With nothing on :3210, the script exits non-zero after the timeout with
  `Timed out waiting for: tcp:127.0.0.1:3210`; with a listener on :3210 and Vite up, it
  exits 0 (proven with `wait-on` 8.0.5 on the branch).
- A live `npm run dev` run, with a copy of the dev data, shows the app logging
  "Attached to an already-running Convex backend on :3210" and never "Starting backend".

## Open questions

None. Scope chosen by James on 2026-09-29: close the race only.
