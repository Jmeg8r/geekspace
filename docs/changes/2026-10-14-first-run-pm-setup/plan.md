---
change: 2026-10-14-first-run-pm-setup
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: seed the full project-management setup on first run

## Files that change

- `convex/pm.ts` — move the body of `applyPmUpgrade` into an exported helper
  `applyPmUpgradeImpl(ctx, tzOffsetMin?)` that returns the same string. The mutation
  becomes a one-line wrapper with the same `args` and return value.
- `convex/seed.ts` — after the existing seed work, call `applyPmUpgradeImpl(ctx)` in the
  same mutation. It already reflows at its end, and finds the Tasks database by
  `isTaskSource`, which the seed sets.
- `tests/firstRun.test.ts` (new) — the failing-first test from the intent, using
  `convex-test`.
- `package.json`, `package-lock.json` — add `convex-test` as a devDependency at the exact
  version PR #28 pinned (`0.0.50`, peer `convex ^1.32.0`; the repo has `^1.41.0`).
- `vitest.config.ts` — only if `convex-test` needs the `edge-runtime` environment for the
  new file; PR #28 changed one line here for the same reason.
- `README.md` — the `npm run seed` comment names the PM setup.

## Order of work

1. Add `convex-test`; write `tests/firstRun.test.ts` → verify: it **fails** on the current
   seed (no Sprints database), for that reason and not a harness error.
2. Commit the failing test on its own (`test(seed): ...`).
3. Extract `applyPmUpgradeImpl`; call it from `seedWorkspace` → verify: the test passes,
   the existing 44 tests still pass, and `npx convex run pm:applyPmUpgrade` against a
   workspace seeded *before* this change still upgrades it (old-workspace path).
4. Live probe on a new anonymous backend in the worktree: `npm run seed` only → the
   Sprints page, Sprint Board, Backlog and User Guide appear in the UI; a second
   `npm run seed` returns `already-seeded`; `pm:applyPmUpgrade` returns
   `already-up-to-date`.
5. `npm run verify`, `npm run build`, `npm audit` (CI gates on a full-tree audit, per
   `docs/changes/2026-09-29-audit-gate`, so the new devDependency must not add advisories).
6. Commit, push to the forge, `forge-pr create` → CI green, ai-review gate reads it.
7. Codex review, posted verbatim with PASS/FAIL → merge on James's approval.

## Risks

- **One bigger transaction.** Seed plus upgrade plus reflow now run in one mutation. The
  seed data is about ten tasks and a few events, far below Convex's per-transaction
  limits; the live probe in step 4 exercises it on the real local backend.
- **`convex-test` drift.** It is an isolated test implementation, not the bundled
  backend, so step 4's live probe is the real proof; the unit test guards regressions.
- **PR #28 overlap.** #28 also adds `convex-test` and edits `vitest.config.ts`; landing it
  here first makes #28's split smaller, not harder.
- **The `convex/_generated/` drift** that `convex dev` produces in a worktree (seen on
  #39 and #40) is not committed.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| failing first | `npx vitest run tests/firstRun.test.ts` on the test-only commit | fails: no Sprints database |
| passes | same, after the fix | passes |
| suite | `npm run verify` | pass, 44 + new tests |
| live seed | fresh backend, `npm run seed`, UI | Sprints, Sprint Board, Backlog, User Guide present |
| idempotent | second `npm run seed`; `pm:applyPmUpgrade` | `already-seeded`; `already-up-to-date` |
| old path | seed with `main`'s code, then `pm:applyPmUpgrade` with the new code | upgrades as before |
| build/audit | `npm run build`; `npm audit` | pass; 0 vulnerabilities |
| CI | PR head statuses | green |

## Options not taken

- **Call `pm:applyPmUpgrade` from `prebake-seed.mjs` and the `seed` npm script.** Two
  call sites that can drift, which is how this bug happened.
- **Run the upgrade on app start when `pmUpgraded` is unset.** Would also touch existing
  workspaces that deliberately skipped it, and adds a startup write.
- **Fold the upgrade's steps into `seed.ts` directly.** Duplicates ~280 lines that must
  stay in sync with the upgrade path for older workspaces.

## Deviations

Results of the plan's proofs, run 2026-10-14 on a fresh anonymous backend in the
worktree, and the departures from the plan text.

- **Failing first:** on `b7e0cf1` (test only), 2 of 3 tests failed for the intended
  reasons: `expected +0 to be 1` for the Sprints database, and `applyPmUpgrade` returning
  `upgraded: dependencies, sub-tasks, sprints (8 tasks in Sprint 1), sprint-board-view,
  backlog-view, table-decluttered, user-guide, templates (4)` instead of
  `already-up-to-date`. The idempotency case passed, showing the harness works.
- **After the fix:** 3/3; `npm run verify` 65/65 (main now has 62, not the 44 the plan
  quoted from 2026-10-11); `npm run build` passes.
- **Old-workspace path:** seeded with `main`'s `pm.ts`/`seed.ts` (`convex data databases`
  showed Tasks, the positive control, and no Sprints), then redeployed the fix:
  `pm:applyPmUpgrade` returned the full `upgraded: ...` string, and `already-up-to-date`
  on a second run.
- **Fresh path:** empty database → `npm run seed` → `"seeded"`; again → `"already-seeded"`;
  `pm:applyPmUpgrade` → `"already-up-to-date"`. The UI showed Sprints and User Guide in
  the sidebar and the Sprint Board and Backlog tabs on Tasks, with no console errors.
- **`vitest.config.ts` unchanged:** `convex-test` ran under the existing `node`
  environment.
- **Audit expectation corrected:** the plan said "0 vulnerabilities". `npm audit` reports
  8 moderate advisories (`sprintf-js` via `electron-builder`), identical on `main`; the CI
  gate fails only on high/critical, and `convex-test` adds none.
- **`applyPmUpgradeImpl`'s body was re-indented** one level when it moved out of
  `handler`; `git diff -w` shows the substantive change.
- **`seed.ts` no longer imports `runReflow`:** the upgrade helper ends with the same
  reflow, so the seed's own call was removed rather than run twice.
