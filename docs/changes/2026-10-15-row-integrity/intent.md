---
change: 2026-10-15-row-integrity
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: relations stay two-sided, and row edits keep the PM wiring intact

## Problem

From the 2026-10-11 reassessment (code audit, re-read against `main` at `29e109d`):

1. **New rows get one-sided relations.** `rows.create` (`convex/rows.ts:152`) stores the
   properties it is given without the reverse-relation sync that `rows.updateProperty`
   does. A task created by ARCHITECT or MCP `create_row` with a Project, or a Board card
   created in a related column, never appears on the other side, so Project progress
   rollups and "save as template" miss it.
2. **Deleting a row leaves dangling ids** in every row that pointed at it, and its time
   blocks behind (`rows.remove`, `convex/rows.ts:247`). The README lists this as a known
   limit.
3. **Removing a self-relation leaves its other half.** `removeProperty` skips the reverse
   property when both halves live in the same database (Parent task ⇄ Sub-tasks,
   Blocked by ⇄ Blocking), so deleting one leaves an orphan column whose values nothing
   maintains.
4. **Turning "Use as task source" off and on silently drops the PM wiring.**
   `setTaskSource` validates only four `taskConfig` fields, so `blockedByPropId`,
   `parentPropId` and `sprintPropId` are lost, and dependencies stop shaping the schedule
   with no message.
5. **Values are not validated at the boundary.** `rows.create`/`updateProperty` accept
   `v.any()`, so a malformed value (a string in a date, an option id that does not exist)
   is stored and breaks views later. The repo's review standards put validation at the
   `convex/*.ts` handlers.
6. **MCP `update_row` is not atomic.** It sends one mutation per property, so a failure
   half-way leaves the row half-edited, and each mutation reflows separately.

Open PR #28 fixes all six (`convex/lib/rowProperties.ts`, `databaseIntegrity` tests).
This change ports that work, with two departures (below).

## Proposed outcome

- One transactional property writer used by create, single edits and MCP batches: values
  are validated per property type, relation targets must exist in the related database,
  and both sides of a synced relation are updated together.
- Deleting a row clears inbound relation ids and its time blocks.
- Removing either half of any synced relation removes both halves and their values.
- `setTaskSource` keeps the dependency, parent and sprint mappings.
- MCP `update_row` sends one batch mutation.

## Departures from PR #28

- **A broken reverse pair is logged, not thrown.** `main` has been leaving self-relation
  half-pairs behind (item 3), so real workspaces may already hold them. #28 throws
  `Broken synced relation`, which would block every edit to those rows. Here the forward
  side is written and the broken pair is logged with enough context to repair it.
- **No unconditional reflow.** #28 reflows on every property edit. Here a reflow runs when
  the edited row's database, or the database on the other side of a changed relation, is
  a task source. (PR 4 narrows it further to schedule-relevant fields.)

## Affected users and systems

- Everyone editing databases; ARCHITECT and MCP clients (`create_row`, `update_row`).
- geekspace is public on GitHub, so every commit here is published when it syncs.
- Open PR #28: after this lands, its `rowProperties.ts`, the row/database handler changes
  and the matching tests are redundant.

## Constraints

- No schema change and no data migration; existing malformed data is not rewritten.
- Proofs run on the isolated worktree backend.

## Out of scope

- Scheduler correctness and reflow cost (PR 4).
- The database UI and `rows.list` payload (PR 3b).
- Repairing existing half-pairs in real workspaces (a separate, opt-in tool if wanted).

## Success signals

- Tests, failing first (ported from #28 where they exist): relations given at creation are
  synced; deleting a row cleans inbound ids and time blocks; removing a self-relation
  removes both halves and values; malformed values and out-of-database relation targets
  are rejected and roll back the whole edit; toggling task source keeps the PM mapping; a
  broken reverse pair writes the forward side without throwing.
- Live: create a task with a Project through the MCP server → it appears under the
  project and the progress rollup counts it; delete it → the project no longer lists it.
- `npm run verify` and `npm run build` pass.

## Open questions

None.
