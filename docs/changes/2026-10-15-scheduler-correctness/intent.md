---
change: 2026-10-15-scheduler-correctness
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the auto-scheduler books each task once, around everything it should

## Problem

From the 2026-10-11 reassessment (code audit, re-read against `main` at `e845355`):

1. **Dragging a block double-books the task.** A locked future block is treated as busy
   time but not subtracted from the task's remaining estimate (`convex/scheduling.ts`), so
   the next reflow schedules the whole estimate again around it. Dragging is how a block
   gets locked, so this happens on ordinary use.
2. **A blocker that only partly fits counts as finished.** The engine records a task as
   finished at its last placed block even when some of it could not be placed
   (`convex/lib/scheduler.ts`), so dependents can start before their blocker is done.
   A locked blocker's end is also ignored when placing its dependents.
3. **Long appointments are missed.** Busy time only includes events that started in the
   last 14 days, so a multi-week event (a trip, a conference) stops blocking time.
4. **Trashed task databases are still scheduled.** Rows of a task-source database whose
   page is in the trash keep getting time blocks and calendar entries.
5. **Scheduler settings are not validated on the server.** The Settings UI clamps values,
   but `settings.update` (also reachable from MCP) accepts anything; a zero chunk size
   would loop the engine.
6. **Warnings are mislabelled.** A dependency cycle is shown as "Scheduled past its due
   date", and one task can produce two warnings with the same React key.

PR #28 fixes 1, 2 (partially), 3 and 5. It does not fix 4 or 6.

## Proposed outcome

- A locked block counts once: it reserves its time and is subtracted from the estimate,
  and a dependent never starts before a locked or partly placed blocker ends.
- Every event that overlaps the planning window is busy time, however long ago it began
  (via an index on event end time, rather than #28's scan of all past events).
- Task databases in the trash, or under a trashed page, are not scheduled or shown.
- Scheduler settings are validated in `settings.update` and before every reflow.
- Each warning shows its real reason, once per task.

## Affected users and systems

- Anyone using the self-scheduling calendar; MCP clients that change settings.
- Schema: adds one index (`events.by_end`); Convex builds it automatically, no migration.
- geekspace is public on GitHub, so every commit here is published when it syncs.
- Open PR #28: its scheduler and validation changes become redundant once this lands.

## Constraints

- Past blocks stay as they are (frozen history) unless James decides otherwise below.
- Proofs on the isolated worktree backend.

## Out of scope

- Reflow cost, DST handling in the week grid, Home's stale "today" (PR 4b).

## Success signals

- Failing-first tests: a locked block plus the remaining estimate equals the estimate (no
  double booking); a dependent of a partly placed blocker is not placed before it ends;
  an event that began 30 days ago and runs through next week blocks time; rows of a
  trashed task database get no blocks; invalid settings are rejected without being
  saved; a cycle produces one `dependency_cycle` warning.
- Live: drag a block, reflow, and the task's total planned time equals its estimate; a
  cycle shows "Dependency cycle", not "past due".
- `npm run verify` and `npm run build` pass.

## Open questions

None. **Missed blocks: James chose option A on 2026-10-15** ("accept 4a, option A").

**Missed blocks (decided).** Today any block whose start time has passed counts
as work done, whether or not it was worked, so a skipped two-hour block silently uses up
two hours of the estimate and the task may never be planned again. The README documents
this as intended ("frozen history"). Options:

- **A — keep it, but say so (recommended).** Past blocks still count as worked. When a
  task's planned time has all passed and it is not marked done, it appears under "needs
  attention" as "Planned time used up, not done", so it is never dropped silently. Small,
  matches the documented model, no guessing about what was worked.
- **B — re-plan missed time.** Past blocks of tasks that are not done stop counting, so
  their time is planned again. Never loses work, but over-books tasks that were worked
  and just not ticked off, and makes the plan churn.
- **C — leave as is.**
