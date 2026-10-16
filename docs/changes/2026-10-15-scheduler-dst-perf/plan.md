---
change: 2026-10-15-scheduler-dst-perf
status: accepted
track: T2
intent: ./intent.md
linear: pending
---
# Plan: calendar arithmetic in the week grid; reflow only what changed

## Files that change

- `src/lib/dates.ts`: `weekDays(weekStartMs)` (local midnights via `addDays`),
  `atMinuteOfDay(dayMs, minute)` (local wall-clock time on that date) and `nextDay(dayMs)`.
- `src/components/calendar/WeekGrid.tsx`: columns, `weekEnd`, `dayMinToMs` and day ends use
  those helpers.
- `src/components/home/HomeView.tsx`: the day start refreshes at midnight and on
  visibility/focus.
- `convex/lib/rowProperties.ts`: `changeProperties` reports whether a schedule-relevant
  property changed (the task source's status, date, estimate, priority and blocked-by
  ids, or a relation into a task source's blocked-by); `rows.ts` reflows only then.
- `convex/scheduling.ts`:
  - future blocks via `timeBlocks.by_start` (`start > now`), past minutes via `by_task`
    for each open task, instead of reading the whole table;
  - in-place update: keep unlocked future blocks identical to a newly computed one,
    delete the rest, insert what is new;
  - `getWarnings` resolves each warning's title from the current row.
- `convex/timeBlocks.ts`: `listRange` bounded on both ends, task/database lookups cached
  per call, blocks of hidden databases skipped (`isPageHidden`).
- `convex/events.ts`: `listRange` via `by_end` (`end > start`, filtered by `start < end`).
- Tests (new): `tests/weekDays.test.ts` (TZ pinned to `America/New_York`),
  `tests/reflowCost.test.ts` (convex-test).

## Order of work

1. Tests → fail for the stated reasons; commit test-only.
2. Date helpers + WeekGrid → DST tests pass.
3. Schedule-relevance check + reflow gating → title/status tests pass.
4. Bounded block reads + in-place update → same block set, stable ids.
5. `listRange` queries, warning titles, Home rollover.
6. Live probes (Nov 1 week screenshot, block ids across a title edit); verify; build.
7. Commit, push, PR; CI; Codex; merge on James's approval.

## Risks

- **Skipping a reflow that was needed.** The relevance list is explicit and tested; a
  property type added later that affects scheduling must be added there (noted in code).
- **In-place update must match a full rewrite.** Proven by computing both on the same
  inputs in a test.
- **Timezone-pinned tests** depend on Node honouring `process.env.TZ` set at the top of
  the test file; a control case asserts the offset changes across Nov 1, so a TZ that did
  not take effect fails loudly instead of passing.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| failing first | `npx vitest run tests/weekDays.test.ts tests/reflowCost.test.ts` | fails for the stated reasons |
| suite | `npm run verify` | pass |
| DST week | worktree UI on the week of Nov 1 | events at their real times (screenshot) |
| title edit | type in a task title; `convex data timeBlocks` ids | unchanged |
| status edit | mark a task done | its blocks go, others re-plan |
| long event | event from 40 days ago | shown on this week's grid |
| build | `npm run build` | pass |

## Options not taken

- **Debouncing reflows on the server** (scheduled function): adds latency and a second
  source of truth for "is the plan current"; skipping irrelevant edits removes most of the
  cost without either.
- **Storing logged minutes on each row**: a schema change and a second copy of truth;
  per-task `by_task` reads are enough at personal scale.
