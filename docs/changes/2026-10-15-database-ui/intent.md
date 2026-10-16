---
change: 2026-10-15-database-ui
status: accepted
track: T2
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: database views that stay fast, readable and usable

## Problem

From the 2026-10-11 reassessment (live walkthrough and code audit, re-read against the
3a branch):

1. **Every keystroke in a row page re-sends the whole table.** `rows.list`
   (`convex/rows.ts`) returns each row's full `content` (its page body). The same query
   backs every relation picker (`cells.tsx:470`), the relation filter
   (`DatabaseContainer.tsx:457`) and the Docs project filter (`DocsPage.tsx:83`), none of
   which read `content`. A row-page autosave invalidates all of them.
2. **Relation lookups are sequential.** `enrichRows` awaits `ctx.db.get` once per related
   row, in series, on every `rows.list` run.
3. **Some inputs write on every keystroke.** Option names (`TableView` options editor) and
   text filters (`DatabaseContainer` filter rules) are controlled by server state and call
   a mutation per keystroke: characters drop and the caret jumps when the round trip lags,
   and each keystroke rewrites the whole property list or view.
4. **The Timeline is hard to read.** One-day tasks render as ~38 px bars, truncated to one
   letter, with no row labels (seen live). Rows dated outside the fixed 8-week window
   appear nowhere, not even in "No date".
5. **A far-future end date freezes the calendar view.** `DbCalendarView` loops day by day
   from start to end; a typo like 2206 instead of 2026 runs ~66,000 iterations per row on
   every render.
6. **The database settings popover opens in the wrong place.** Seen live: the gear menu
   ("Show on calendar", "Use as task source") renders at the window's top-left over the
   sidebar, partly off-screen, instead of under the gear.

None of these is fixed by PR #28.

## Proposed outcome

- `rows.list` no longer carries row bodies; relation pickers and filters use a light
  titles-only query; relation lookups run concurrently.
- Option names and text filters edit locally and save on a short debounce or on blur.
- Timeline bars show their title (beside the bar when it does not fit), rows have readable
  labels, and rows outside the window are counted with a way to bring them into view.
- The calendar view only walks the days it displays.
- The settings popover opens under its gear.

## Affected users and systems

- Everyone using databases; MCP `list_rows` (reads `rows.list`, not `content`).
- geekspace is public on GitHub, so every commit here is published when it syncs.

## Constraints

- No schema change. Proofs on the isolated worktree backend, with before/after
  screenshots for the visual items.

## Out of scope

- List virtualisation for very large databases (not needed at personal scale; revisit if
  a table passes ~500 rows).
- Scheduler and calendar-page performance (PR 4).

## Success signals

- Tests, failing first: `rows.list` omits `content`; the titles-only query returns id and
  title only; relation titles and rollups are unchanged.
- Live: typing in a row page no longer re-runs relation pickers (checked by query payload
  in the network log); typing an option name quickly keeps every character; Timeline
  screenshots before/after; a row dated in 2206 does not freeze the calendar view; the
  settings popover appears under the gear.
- `npm run verify` and `npm run build` pass.

## Open questions

None.
