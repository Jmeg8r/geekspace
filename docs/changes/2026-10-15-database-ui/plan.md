---
change: 2026-10-15-database-ui
status: accepted
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

## Deviations

Results of the plan's proofs, run 2026-10-15 on the isolated worktree backend, and the
departures from the plan text.

- **Failing first (`085c039`):** `rows.list` returned `content`; `rows.listTitles` did not
  exist. The rollup case passed (it guards the change). After: 3/3; suite 102/102; build
  passes.
- **Callers:** the relation picker, relation filter and Docs project list moved to
  `listTitles`; `DocViewer`'s project list is typed as the new `RowTitle`. The typecheck
  confirmed nothing in `src/` read `content` from `rows.list`.
- **Payload proof changed:** Convex sends queries over a WebSocket, so the plan's
  "network log" check is not available. The unit test proves `content` is absent; the
  typecheck proves no caller needed it.
- **Option name (live):** typed "Lowest priority (someday)" in one burst; the input held
  all 25 characters and the saved option name matched exactly. Restored afterwards.
- **Timeline (live):** a sticky title column; titles beside bars too short to hold them;
  ‹ Today › week navigation; a task moved to March 2027 left the grid and showed as
  "1 later →", which jumped the window there ("← 9 earlier" back). Dragging a bar two days
  moved its date Oct 16 → Oct 18 (drag maths unchanged). ESLint's `react-hooks` "value
  cannot be modified" error in the drag handler is on `main` too and was left as is.
- **Calendar — claim corrected.** The intent said a far-future end date "freezes" the
  view. Measured for a range ending in 2204: the old loop walked 64,818 days and took
  ~7 ms per render per such row (plus a map of that size); the clipped loop walks the 17
  visible days. Real waste, not a freeze.
- **Settings popover — root cause, wider than described.** The `.fade-in` keyframes
  animated `transform`, which Floating UI also uses to position every popover, so for the
  animation's length each popover sat at the window's top-left (at `currentTime = 0`:
  (1, 3) instead of under the gear). Where animations are slowed it stays there visibly,
  which is what the walkthrough saw. A first fix animated `translate` instead, which broke
  the modal (Tailwind v4 centres it with the `translate` property; first frame 380 px off
  centre). Final: opacity and `scale` only. Verified with the animation frozen at its
  first frame: popover (495, 270) vs final (502, 273); modal centred at 512 px in both.
  This fixes every popover and keeps the modal, agent panel, doc viewer, context menu and
  recorder unaffected.
- **Codex review round 1 (`7ea678d`): GATE PASS, four [P2], all fixed and checked live.**
  - Rename then colour: every options save now carries names still being typed, and a
    pending name is dropped only once the server copy shows it. My first version dropped it
    on send, and the live probe (rename, blur, colour click at once) lost the rename;
    after the fix the server held `Low (later)` in the new colour.
  - Outside change while focused: `DraftInput` keeps the newest outside value and shows it
    on blur when nothing was typed. Live: focused, renamed from the CLI, blurred → the
    input showed the new name.
  - Resize handle on a clipped bar: shown only when the real end is on screen. Live: the
    clipped bar had 0 handles, a bar with a visible end had 1.
  - Today and the jump chips scroll back to the start. Live: 900 px → 0 on Today.
  - Suite 102/102.
- **Codex review round 2 (`91ea073`): GATE PASS, three [P2], fixed by restating the rules
  rather than patching each case.**
  - Filters had the option editor's lost-update race (type a value, click "Add filter" at
    once). The filter menu now builds every change from the last config it sent, until the
    server copy matches it, plus values still being typed. Live: the server kept
    `value: "draft"` and the new rule.
  - `DraftInput` rewritten around two rules: an outside value is adopted on blur only if
    nothing was typed during that focus (so blurring while a save is in flight keeps the
    typed text), and a save is skipped only when it equals the current server value (so
    an edit back to the old text after an outside change is still saved). Live: focused
    "Low", renamed elsewhere to "Low (renamed elsewhere)", typed "Lowx" then "Low", blurred
    → the server held "Low".
  - Suite 102/102.
- **Codex review round 3 (`fab3f41`): GATE PASS, three [P2]; two were caused by round 2's
  remembered "last sent" filter config** (Convex returns object keys in a different order,
  so the "caught up" check never matched; and the remembered config was not scoped to a
  view). Per CLAUDE.md L42 the response was to remove machinery, not add it:
  - the remembered config is gone. The filter menu keeps only values still being typed,
    dropped once the server copy shows them (the option-editor pattern), and is keyed by
    view so nothing carries across views;
  - `DraftInput` no longer skips a save that equals the server value; whatever was typed
    is saved after a pause (a repeat is harmless; a skip could leave an earlier in-flight
    save as the last word).
  - Two structural clicks inside one round trip still race, exactly as on `main`; not a
    regression from this PR.
  - Live: the filter value survived an immediate "Add filter". Suite 102/102.
- **Review loop stopped here** (L42): three rounds, all GATE PASS, no P0/P1. The round-3
  fix was not sent back to Codex; it is covered by the suite, the live check and the
  forge ai-review gate on the PR head.
