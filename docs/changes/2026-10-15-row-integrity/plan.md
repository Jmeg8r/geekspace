---
change: 2026-10-15-row-integrity
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: one validated, two-sided property writer for rows

## Files that change

- `convex/lib/rowProperties.ts` (new, adapted from #28):
  - `propertyValue` / `propertyBag` validators and the `PropertyValue` union;
  - `changeProperties(ctx, row, db, changes)`: validates every change first (type,
    option ids, finite dates, relation targets inside the related database), then patches
    the row, then updates each synced reverse side. A broken reverse definition is logged
    (`console.warn` with database, property and row ids) and skipped, not thrown;
  - `deleteRowAndReferences(ctx, rowId)`: clears the row's id from every relation
    property that references it and deletes its time blocks before the row.
  - returns whether any task-source database was touched, so callers reflow only then.
- `convex/rows.ts`: `create` inserts an empty row then applies `properties` through the
  writer; `updateProperty` uses it; new `updateProperties` (batch, one transaction);
  `remove` uses `deleteRowAndReferences`; `v.any()` replaced by the validators.
- `convex/databases.ts`: `addProperty` takes a literal union of types and requires a
  target for relations; `removeProperty` removes both halves (same or other database) and
  their stored values; `setTaskSource` accepts `blockedByPropId`, `parentPropId`,
  `sprintPropId`; `updateProperty`'s `v.any()` options/rollup get real validators.
- `mcp/index.mjs`: `update_row` sends one `rows.updateProperties` call.
- `tests/rowIntegrity.test.ts` (new): the cases in the intent, using `convex-test`.

## Order of work

1. Tests → verify they fail on `main` for the stated reasons; commit test-only.
2. `rowProperties.ts` + `rows.ts` → creation/deletion/validation/broken-pair tests pass.
3. `databases.ts` → self-relation and task-source tests pass.
4. `mcp/index.mjs` → a stdio smoke run of `update_row` against the worktree backend.
5. Grep every caller of `rows.create`/`updateProperty`/`databases.updateProperty` in
   `src/` and `mcp/` and confirm the values they send pass the new validators (the
   typecheck covers `src/`; `mcp/` is plain JS, so read it).
6. Live probes; `npm run verify`; `npm run build`.
7. Commit, push, `forge-pr create`; CI green; Codex review posted verbatim; merge on
   James's approval.

## Risks

- **Stricter validation can reject what callers send today.** Step 5 checks every caller;
  the UI is typed, MCP is read by hand. A rejected value now fails loudly instead of being
  stored broken.
- **`deleteRowAndReferences` scans every row of every database with a relation.** Fine for
  a personal workspace; noted for PR 4's efficiency work.
- **Logging instead of throwing on a broken pair** keeps edits working on legacy data but
  leaves the pair broken until repaired; the log line names it.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| failing first | `npx vitest run tests/rowIntegrity.test.ts` on the test-only commit | fails for the stated reasons |
| unit | same, after | pass |
| suite | `npm run verify` | pass |
| MCP create with project | MCP `create_row` on the worktree backend | task listed under the project; rollup counts it |
| delete | `rows.remove` on that task | project no longer lists it; its time blocks are gone |
| self-relation removal | remove "Blocked by" in the UI | "Blocking" disappears too |
| task-source toggle | toggle off/on in the UI | `taskConfig` keeps `blockedByPropId`/`parentPropId`/`sprintPropId` |
| build | `npm run build` | pass |
| CI | PR head statuses | green |

## Options not taken

- **Port #28 verbatim.** Its throw on a broken pair would lock legacy rows, and its
  unconditional reflow adds cost to every edit.
- **Repair half-pairs automatically on read.** Mutating data the user did not touch, from
  a query path; a separate opt-in repair is safer.

## Deviations

Results of the plan's proofs, run 2026-10-15 on the isolated worktree backend, and the
departures from the plan text.

- **Failing first (`40bb2a9`):** 6 of 8 tests failed for the stated reasons (reverse side
  not synced on create; a bad status option and an infinite date accepted; a deleted row
  left in its project's relation; the Blocking half left behind; `blockedByPropId`
  dropped by the toggle). Two passed on `main`, and why:
  - the broken-pair test is a guard against #28's throw; `main` does not throw either;
  - the batch-rollback test passed only because `rows.updateProperties` did not exist yet.
    After the change it passes on the real behaviour: the failing batch left the row's
    title unchanged.
- **Suite:** `npm run verify` 94/94; `npm run build` passes.
- **`rows.remove` already deleted time blocks on `main`;** the missing part was the inbound
  relation cleanup, which is what changed.
- **MCP probe (real stdio server, worktree backend):** `create_row` with a Project, then
  `update_row` of Status and Priority (one `updateProperties` call). The task appeared
  under "Home Lab Refresh" in the UI; `rows.remove` then left zero references to its id
  anywhere (positive control: the project row was still found).
- **Found while probing:** MCP relation values are row ids. A first probe passed the
  project's *name*; the new validation rejected it with `"Project" can only link to rows
  of its related database`. On `main` that name would have been stored as a bogus
  relation id.
- **Task-source toggle (UI):** off kept all seven `taskConfig` fields (on `main` it wiped
  them); on again kept them, and 12 time blocks were rescheduled.
- **Self-relation removal:** covered by the unit test only, to keep the demo workspace's
  dependencies intact for the video.
- **Typecheck-driven UI fixes:** `TableView`'s number-format `<select>` now matches its
  value against `NUMBER_FORMATS` (new export in `convex/lib/types.ts`) instead of passing
  a raw string, and the add-property menu's list excludes `title`.
- **Server code that inserts rows directly** (`seed.ts`, `templates.ts`, `pm.ts`) still
  bypasses the writer. Each writes both sides of the relations it sets; left as is.
- **Noticed, not fixed here:** the database settings popover (gear icon) opens at the
  window's top-left over the sidebar, partly off-screen. Logged for PR 3b.
- **Codex review round 1 (`27e3279`): GATE PASS, one [P2], fixed** — a regression this
  change introduced. The date picker moved a range by first sending a new start with the
  old end (`{start: Oct 10, end: Oct 3}`), which the new validation rejects; the second
  click then paired with the old start. New `src/lib/dateRange.ts` `pickDay`: a new start
  collapses the end onto it, and the picker keeps its own pending start for the second
  click. `emit` also clamps the end to the start, so a later start time on the same day
  cannot produce a reversed range either. Failing-first test (`Cannot find module`), then
  3/3; suite 97/97. Live: a range Oct 19–21 moved with two clicks to Oct 26–29, with no
  rejected mutation.
