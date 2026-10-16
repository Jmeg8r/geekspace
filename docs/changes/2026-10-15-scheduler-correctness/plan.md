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
