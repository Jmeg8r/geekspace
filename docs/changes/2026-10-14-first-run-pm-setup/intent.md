---
change: 2026-10-14-first-run-pm-setup
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a fresh workspace gets the whole project-management setup

## Problem

Found during the 2026-10-11 reassessment, on a fresh anonymous backend seeded with
`npm run seed` from `main` at `3cbb8b1`.

`seed:seedWorkspace` (`convex/seed.ts`) creates Projects, Tasks, a Welcome page and a
sample week. Everything else the README and User Guide describe as shipped comes only from
`pm:applyPmUpgrade` (`convex/pm.ts:60`): the Sprints database, Blocked by ⇄ Blocking,
Parent task ⇄ Sub-tasks, the Sprint Board and Backlog views, the User Guide page and the
three starter templates.

Nothing calls `applyPmUpgrade`. A search of `src/`, `mcp/`, `electron/` and `scripts/` for
`api.pm.` finds only `completeSprint`, and `scripts/prebake-seed.mjs` posts only
`seed:seedWorkspace`. So a new developer who follows the README, and every new install of
the packaged app (whose starter workspace is the prebaked seed), gets half the PM feature
set. Workspaces that were upgraded by hand, including James's, are unaffected.

Observed: after `npm run seed`, the Tasks page had Table, Board, Calendar and My Tasks
views and no Sprints page. Running `npx convex run pm:applyPmUpgrade` afterwards returned
`upgraded: dependencies, sub-tasks, sprints (8 tasks in Sprint 1), sprint-board-view,
backlog-view, table-decluttered, user-guide, templates (4)`, and the missing pages and
views appeared live.

## Proposed outcome

- Seeding a fresh workspace produces the complete PM setup in the same transaction: one
  entry point, so dev seeding and the packaged prebake cannot drift apart again.
- `applyPmUpgrade` keeps working unchanged for older workspaces and stays idempotent.
- Seeding an already-seeded workspace still does nothing.

## Affected users and systems

- New developers (`npm run seed`) and new installs of the packaged app (macOS and
  Windows: both run `scripts/prebake-seed.mjs`, which calls the same mutation).
- Existing workspaces: none. `seedWorkspace` returns `already-seeded` before doing any work.
- geekspace is public on GitHub, so every commit here is published when it syncs.
- Open PR #28 touches `convex/pm.ts` in unrelated handlers; this change edits the
  `applyPmUpgrade` declaration only to move its body into a helper.

## Constraints

- No change to what `applyPmUpgrade` creates, or to its return strings.
- No UI change.
- No real user data touched: proofs run on a fresh anonymous backend in the worktree.

## Out of scope

- Any other first-run behaviour (sample data content, the Welcome page text).
- Splitting PR #28 (separate changes).

## Success signals

- A test, written first and shown failing on `main`: seeding an empty database yields a
  Sprints database with `sprintConfig`, Blocked by and Parent task properties on Tasks,
  Sprint Board and Backlog views, a User Guide page and at least three templates; seeding
  a second time changes nothing.
- On a fresh backend, `npm run seed` alone shows the Sprints page, Sprint Board, Backlog
  and User Guide in the running UI, and `npx convex run pm:applyPmUpgrade` afterwards
  reports `already-up-to-date`.
- `npm run verify` and `npm run build` pass.

## Open questions

None.
