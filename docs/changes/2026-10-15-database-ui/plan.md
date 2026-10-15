---
change: 2026-10-15-database-ui
status: draft
track: T2
intent: ./intent.md
linear: pending
---
# Plan: lighter row queries, local-first inputs, readable Timeline

## Files that change

- `convex/rows.ts`: `list` strips `content` from each row; new `listTitles({ databaseId })`
  returning `{ _id, title }[]`; `enrichRows` fetches related rows with `Promise.all`.
- `src/components/database/cells.tsx` (relation picker),
  `src/components/database/DatabaseContainer.tsx` (relation filter),
  `src/components/docs/DocsPage.tsx` (project filter): switch to `listTitles`.
- `src/components/database/TableView.tsx` (options editor) and
  `DatabaseContainer.tsx` (text filter value): local draft state, saved on blur and on a
  short debounce; the draft resets when the underlying property or rule changes.
- `src/components/database/TimelineView.tsx`: a left label column with each row's title;
  bars too narrow for their title get it beside the bar; a "N outside this range" chip per
  side that moves the window to them; the window can be moved by week.
- `src/components/database/DbCalendarView.tsx`: clip each row's span to the displayed
  month grid before looping.
- Settings popover: diagnose live first (Floating UI reference or size), fix at the cause.
- Tests (new): `tests/rowsList.test.ts` (convex-test).

## Order of work

1. `rowsList.test.ts` → fails on the branch base (`content` present; `listTitles` missing).
2. `rows.ts` changes → tests pass; grep confirms no consumer reads `content` from `list`.
3. Picker/filter/Docs callers → `listTitles`; typecheck.
4. Local-draft inputs; live check by typing quickly with the backend artificially slowed is
   not possible, so check by typing and confirming one mutation per pause, not per key
   (network log).
5. Timeline: before screenshot, change, after screenshot; out-of-range chip with a row
   dated next year.
6. Calendar clip: plant a row dated 2206 and time the view.
7. Popover: reproduce, find cause, fix, screenshot.
8. `npm run verify`, `npm run build`; commit, push, PR; CI; Codex; merge on approval.

## Risks

- **`listTitles` duplicates part of `list`'s work**; it is a plain indexed read, cheaper
  than `list`'s enrichment.
- **Debounced inputs can lose the last edit if unmounted mid-debounce**; flush on blur and
  on unmount, as the editor does.
- **Timeline layout changes** touch drag/resize maths; keep `DAY_W` and the drag code paths
  unchanged and re-test drag and resize live.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| failing first | `npx vitest run tests/rowsList.test.ts` | fails for the stated reasons |
| unit / suite | `npm run verify` | pass |
| payload | network log while typing in a row page | no `rows:list` re-run for pickers |
| option name | type a name quickly | every character kept; one save per pause |
| Timeline | screenshots before/after | titles and labels readable; out-of-range chip works |
| calendar | row dated 2206 | view renders without a stall |
| popover | gear menu | opens under the gear |
| build | `npm run build` | pass |

## Options not taken

- **Virtualising the table now.** Real cost, no need at current sizes.
- **Removing `content` from rows entirely** (separate table). A schema migration for a
  payload problem a projection solves.
