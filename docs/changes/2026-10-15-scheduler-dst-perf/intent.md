---
change: 2026-10-15-scheduler-dst-perf
status: accepted
track: T2
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a correct week across DST, and a scheduler that does only the work it needs

## Problem

From the 2026-10-11 reassessment (code audit, re-read against the 4a branch). The next
DST change is **Sunday 2026-11-01** (US fall-back), sixteen days away.

1. **The week grid is wrong in a DST week.** `WeekGrid.tsx` builds its columns as
   `weekStart + i × 24 h` and places drags and new events the same way, and a day's end is
   `day + 24 h`. On the fall-back week every column after Sunday starts an hour early, so
   events and blocks render in the wrong slot and a drag-created event lands an hour off;
   the 25-hour day also loses its last hour.
2. **Home's "today" never rolls over.** Home memoises the start of the day once; left
   open past midnight it keeps showing yesterday.
3. **Every edit to a task re-plans everything.** Any property change in a task database,
   including each debounced title keystroke, runs a full reflow. The reflow reads every
   time block ever created (the table only grows), every task row, then deletes and
   re-inserts every future block, churning block ids.
4. **Calendar reads are heavier than they look.** `timeBlocks.listRange` has no upper
   bound (it reads every future block) and does two reads per block; `events.listRange`
   only looks back 35 days, so a long event that began earlier vanishes from the week grid
   (the same class 4a fixed in the reflow).
5. **A trashed task's blocks still render.** 4a stops scheduling trashed task databases,
   but blocks that remain (past or locked) are still listed for the grid.

## Proposed outcome

- Week columns, day ends and drag/create positions use calendar arithmetic, correct on
  23- and 25-hour days.
- Home's day rolls over at midnight (and on wake/focus).
- A property change reflows only when it can change the plan (status, due date,
  estimate, priority, dependencies); warnings show current task titles, so a rename no
  longer needs a reflow.
- The reflow reads only future blocks plus the past blocks of open tasks, and updates
  blocks in place (keep identical ones, delete the rest, insert the new) instead of
  delete-and-reinsert.
- `listRange` queries are bounded and batch their lookups; events use the end-time index;
  blocks of hidden databases are not listed.

## Affected users and systems

- Everyone using the calendar and Home. No schema change (4a added `events.by_end`).
- geekspace is public on GitHub, so every commit here is published when it syncs.

## Constraints

- Plans must come out the same: the in-place update writes exactly the blocks a full
  rewrite would. Proven by comparing block sets before/after on the same inputs.
- Proofs on the isolated worktree backend; the DST cases run under a pinned US timezone.

## Out of scope

- The scheduler engine's fixed-offset timezone model (documented trade-off; far-future
  blocks across a DST change still shift until the next reflow).
- Bundle splitting (PR 9).

## Success signals

- Failing-first tests: week columns for the week of 2026-11-01 in `America/New_York` are
  the local midnights of each day; 9:00 on Nov 1 and Nov 2 maps to 9:00 local; a title
  change in a task database does not reflow; a status change does; the in-place update
  leaves identical blocks' ids unchanged and yields the same block set as a full rewrite;
  `events.listRange` returns an event that began 40 days ago; hidden databases' blocks are
  not listed.
- Live: the Nov 1 week renders events in the right slots (screenshot), Home shows the new
  day after a simulated midnight, and typing a task title produces no reflow (block ids
  stable).
- `npm run verify` and `npm run build` pass.

## Open questions

None.
