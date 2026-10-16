---
change: 2026-10-15-scheduler-correctness
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: count locked work once, respect blockers and long events, skip trashed sources

## Files that change

- `convex/lib/validation.ts` (new, from #28): `validateSchedulerConfig`.
- `convex/lib/scheduler.ts`: validate the config on entry; a task with unplaced minutes is
  recorded as unfinished (`Infinity`) for its dependents; one warning per task, with its
  real reason.
- `convex/scheduling.ts`:
  - locked future blocks count toward logged minutes and reserve their time (#28);
  - dependents get `earliestMs` no earlier than any blocker's reserved or locked end (#28);
  - busy events come from a new `events.by_end` index (`end > now`, `start < horizon`);
  - task databases whose page is trashed, or under a trashed page, are skipped;
  - (option A) a task whose planned time has all passed and is not done gets a new
    `time_used_up` warning.
- `convex/lib/pageTree.ts` (new): the "page or an ancestor is trashed" check, shared by
  `pages.list` (PR 2) and the scheduler/calendar data.
- `convex/calendarData.ts`: skip databases whose page is hidden.
- `convex/settings.ts`: validate the merged settings before saving.
- `convex/schema.ts`: `events.index("by_end", ["end"])`.
- `src/components/calendar/CalendarView.tsx`: a label per warning reason, keyed by task and
  reason.
- `tests/schedulerCorrectness.test.ts` (new) + additions to `tests/scheduler.test.ts`.

## Order of work

1. Tests → fail on `main` for the stated reasons; commit test-only.
2. Engine changes (validation, unfinished blockers, warnings) → engine tests pass.
3. Reflow changes (locked blocks, earliest start, events index, trashed sources).
4. Settings validation; `pageTree` helper shared with `pages.list`; calendar data.
5. Warning labels in the UI.
6. Live probes; `npm run verify`; `npm run build`.
7. Commit, push, PR; CI; Codex; merge on James's approval.

## Risks

- **New index on a live table**: Convex backfills it on deploy; for a personal workspace
  this is instant. The query falls back to nothing until it exists only if deployed
  without the schema, which Convex prevents.
- **Validation can reject an existing bad settings document** on the next reflow. The
  error names the setting; the Settings UI already keeps values in range.
- **`Infinity` as "unfinished"** must not leak into stored blocks; it is only used for
  ordering dependents.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| failing first | `npx vitest run tests/schedulerCorrectness.test.ts` | fails for the stated reasons |
| suite | `npm run verify` | pass |
| drag then reflow | worktree UI + `convex data timeBlocks` | planned minutes for the task = estimate |
| long event | event from 30 days ago to next week | no blocks inside it |
| trashed source | trash a task database's page | its blocks disappear from the calendar |
| cycle | A blocked by B, B blocked by A | one "Dependency cycle" warning |
| build | `npm run build` | pass |

## Options not taken

- **#28's event query (`start < horizon`)**: correct, but reads every past event on each
  reflow; an end-time index reads only what overlaps.
- **Throwing on invalid settings inside the engine only**: the bad value would already be
  saved; validate at `settings.update` as well.

## Deviations

Results of the plan's proofs, run 2026-10-15 on the isolated worktree backend, and the
departures from the plan text.

- **Failing first (`6e5da9f`):** all 8 new tests failed on `main` for the stated reasons;
  the headline one booked **120 minutes for a 60-minute task** after a drag. The
  partial-blocker test first passed on `main` because its blocker filled the whole
  horizon (no room for the dependent either way); it was sharpened to a no-split blocker
  that cannot fit at all, which leaves room, and then failed on `main` as it should.
- **After:** 8/8; suite 110/110; build passes.
- **Settings validation:** the settings test passed before the explicit check was added,
  because the reflow it triggers ran the new engine check, threw, and rolled the whole
  mutation back. The check before saving is still added, so the error comes from the
  boundary with a clear message instead of from the engine.
- **`pageTree` helper not shared with `pages.list`:** the list hides subtrees from one
  in-memory pass over all pages; the scheduler and calendar data check one database page
  at a time by walking its parents. Same rule, two shapes; merging them would make the list
  do per-page reads.
- **Live, worktree backend (clock: Thursday evening):**
  - Dragged Friday's 2-hour "Record demo video": one locked block, 120 minutes, equal to
    the estimate (no second copy).
  - Option A on real data: the three tasks whose Thursday blocks had all passed showed
    "Planned time used up, not done"; "Write first draft", with a Friday block left, did
    not. The warnings popover opened under its button.
  - A ⇄ B cycle: one `dependency_cycle` warning, labelled "Dependency cycle".
  - An event from 30 days ago to next week: every unlocked block moved after it; the one
    overlapping block was the locked one, kept by design. Probe data removed.
  - Trashed task source: unit-tested only, to keep the demo workspace intact.
- **The `events.by_end` index** deployed with `convex dev` (`[+] events.by_end`).
