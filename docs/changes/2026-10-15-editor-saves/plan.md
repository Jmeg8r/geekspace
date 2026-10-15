---
change: 2026-10-15-editor-saves
status: accepted
track: T2
intent: ./intent.md
linear: pending
---
# Plan: reliable page saves, visible external edits, no leaked subpages

## Files that change

- `src/lib/saveQueue.ts` (new, ported from #28): serialises saves, keeps the newest
  unsaved value after a failure, exposes `flush` and `hasUnsaved`.
- `src/lib/editorDraft.ts` (new, ported from #28): per-document recovery draft in
  `localStorage`; a save acknowledges only its own value, so a newer draft survives.
- `src/lib/incomingContent.ts` (new): pure
  `decideIncoming({ incoming, lastSynced, dirty })` → `"ignore" | "apply" | "ask"`.
  `lastSynced` is the last value the editor loaded or saved, so the echo of its own save is
  ignored.
- `src/components/page/Editor.tsx`:
  - takes `documentId`, live `content` and an async `onSave`;
  - save queue + draft retention + a "Not saved · Retry" status line;
  - on a changed `content`: apply it with `editor.replaceBlocks` when clean, or show a
    "Changed elsewhere — Load latest / Keep mine" bar when dirty;
  - on mount, a stored draft that differs from the server opens *in the editor* with a
    "Restored unsaved edits — Keep / Discard" bar (#28 showed raw JSON in a textarea);
  - unreadable stored JSON → a read-only panel holding the original text; the editable
    editor never mounts, so nothing autosaves over it;
  - `beforeunload` flushes, and warns while a save is outstanding.
- `src/components/page/PageView.tsx`, `src/components/database/RowPeek.tsx`: pass
  `documentId`, live content and an awaited `onSave`; key the title editors by document
  so a pending title debounce flushes to the right page (#28).
- `convex/pages.ts`:
  - `list` returns only reachable pages (no trashed page, no page under a trashed
    ancestor) and drops `content` from each;
  - `move` reads siblings with the `by_parent` index instead of collecting the table.
- Tests (new): `tests/saveQueue.test.ts` (ported from #28, plus ordering),
  `tests/incomingContent.test.ts`, `tests/pagesList.test.ts` (convex-test).

## Order of work

1. Tests for `saveQueue`, `editorDraft`, `decideIncoming` and `pages.list` → verify:
   they fail (missing modules; `list` returns content and a trashed parent's child).
   Commit test-only.
2. `pages.ts` changes → `pagesList.test.ts` passes; grep confirms no caller reads
   `content` from `list`.
3. `saveQueue` + `editorDraft` + `incomingContent` → unit tests pass.
4. `Editor.tsx` / `PageView.tsx` / `RowPeek.tsx` → `npm run verify` passes.
5. Live probes (intent's list) on the worktree backend, with screenshots of each state.
6. `npm run build`; compare the main chunk size with `main` (no regression expected).
7. Commit, push, `forge-pr create`; CI green; Codex review posted verbatim; merge on
   James's approval.

## Risks

- **`replaceBlocks` while focused** moves the cursor. It is only applied when the editor
  is clean (no unsaved edits), and the caret goes to the end; the dirty case asks first.
- **Echo detection.** Convex returns exactly the saved string, so string equality with
  `lastSynced` identifies our own save. A server-side normaliser would break that; there
  is none today (`pages.setContent` stores the string as given).
- **`localStorage` quota.** Drafts are one page each and removed on acknowledgement; a
  write failure surfaces in the status line instead of failing silently.
- **Hiding subpages of trashed pages** also hides them from MCP's page tree, which is
  correct (they are unreachable in the UI), and they return on restore because they were
  never marked trashed themselves.
- **Diff size** must stay under the review gate's caps (60 KB per file, 100 KB total);
  `Editor.tsx` is the largest file.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| failing first | `npx vitest run` on the test-only commit | new tests fail for the stated reasons |
| unit | same, after the change | pass |
| suite | `npm run verify` | pass |
| save failure | stop backend while typing | "Not saved · Retry"; restart + Retry saves the latest text |
| draft recovery | edit with backend down, reload | "Restored unsaved edits"; Keep saves it |
| external edit, clean | `npx convex run pages:setContent` on the open page | editor shows the new content |
| external edit, dirty | same, while unsaved edits exist | "Changed elsewhere" bar; both choices work |
| unreadable content | plant non-JSON content | read-only panel with the original; no save request |
| trash leak | trash a page with a favourited child; restore | child leaves Favorites/Recent; returns on restore |
| build | `npm run build` | passes; main chunk not larger than `main`'s 1,539 kB |
| CI | PR head statuses | green |

## Options not taken

- **Port #28's editor wholesale.** Its recovery screen shows raw JSON, and it does not
  handle external writes; porting the two library modules and their tests keeps the good
  part.
- **Re-key the editor on every server change.** Simple, but it remounts BlockNote, drops
  undo history and loses the caret even for our own saves' echoes.
- **Store recovery drafts in Convex.** A backend that rejects saves would reject the draft
  too; local storage is the only place guaranteed to be writable then.
- **Un-favourite descendants inside `trash`.** Mutates data the user did not touch, and
  does not fix Recently edited or MCP; filtering reachability in `list` fixes all three.

## Deviations

Results of the plan's proofs, run 2026-10-15 on the isolated worktree backend, and the
departures from the plan text.

- **Failing first (`c1323b0`):** `saveQueue` and `incomingContent` tests failed with
  "Cannot find module"; `pages.list` failed `not to have property "content"` and returned
  `['Child', 'Grandchild', 'Other']` instead of `['Other']` after trashing Root.
- **Added after the test-only commit:** two `pages.move` tests (top level through the
  `by_parent` index with `parentId` undefined, and reparenting). They pass on `main`'s
  `move` too, as intended: they guard the index change, they do not demonstrate a bug.
- **Suite:** `npm run verify` 77/77.
- **External edit, clean (probe 1):** first run failed. The page showed the new text, but
  the stored content became BlockNote's normalised form: `replaceBlocks` fires `onChange`
  synchronously, before the guard value was set, so the editor saved the applied text back.
  Fixed with an `applying` flag held across `replaceBlocks`. Re-run: the editor showed the
  write and the stored string was byte-identical to what was sent.
- **External edit, dirty (probe 2):** typed via `insertText` and wrote through the backend's
  HTTP mutation API within the 600 ms debounce. The conflict bar appeared and the server
  kept the external text while the choice was open. "Load latest" showed it; "Keep mine"
  wrote the local version (`… MINE WINS` on the server).
- **Save while the backend is down (probe 3):** the Convex client queues the mutation
  rather than rejecting it, so the visible state is "Not saved yet. Waiting for the backend
  to answer…" (shown after 3 s), not an error. The draft held the text; a reload with the
  backend still down, then a restart, showed "Restored edits that were not saved last time";
  "Keep them" saved it (positive control: the server held the previous text before, the
  typed text after) and cleared the draft.
- **Rejected-save path ("Not saved: … Retry"):** exercised by the unit tests only; I found
  no way to make a live `setContent` reject without also removing the page it targets.
- **Unreadable content (probe 4):** planted non-JSON content → read-only panel with the
  original; `updatedAt` unchanged after opening it.
- **Trash leak (probe 5):** favourited "Content Ideas", trashed its parent "Welcome": the
  child left Favorites and Recently edited. Restoring "Welcome" returned it, still
  favourited.
- **Row pages:** typed into a task's page body; the row's stored content held the text.
- **Bundle:** the main chunk grew 5 kB (1,538.80 → 1,543.95 kB; gzip 464.69 → 466.48 kB)
  from the new editor code. The plan expected "not larger"; that was wrong, and bundle
  splitting is PR 9.
- **No close prompt on `beforeunload`:** #28 called `preventDefault` while saves were
  outstanding. In Electron that cancels closing the window with no dialog, so the editor
  only flushes; recovery drafts cover anything that does not reach the server.
- **Save queue created lazily** (`queueRef ??=`) and latest-prop refs updated in a layout
  effect, so the editor passes ESLint's `react-hooks/refs` rule. `main`'s editor fails that
  rule today; CI runs oxlint, not ESLint.
- **Title editors keyed by document** (`PageHeader`, `RowPeekInner`) so a pending title
  debounce flushes on switch instead of being replaced by the next page's call.
- **Codex review round 1 (`4ec9ef8`): GATE FAIL, one [P1] and one [P2], both fixed.**
  - [P1] A value already in the save queue behind an active save, or a Retry, could still
    be sent while the conflict bar was open. The queue gained `hold`/`release`/
    `discardPending`; a conflict holds it (flush included), "Keep mine" releases and sends
    the local version, "Load latest" drops the held value and rewrites the loaded version
    after any save still in flight. Two failing-first unit tests (`queue.hold is not a
    function`), then 6/6. Exercised by unit test only: the slow-save timing is not
    reproducible by hand.
  - [P2] Valid JSON holding a block BlockNote cannot build (`[{"type":"unknown-block"}]`)
    threw inside `replaceBlocks` with no error boundary. `applyServer` now catches it and
    keeps the current document (live: the conflict bar offered only "Keep mine" and the
    console logged `Could not load the latest copy of …`); a `LoadGuard` boundary covers
    the same input at mount, which crashes the whole app on `main` (live: the page opened
    read-only showing the stored JSON).
  - ESLint `react-hooks/set-state-in-effect` is disabled for the one effect that reacts to
    the server copy changing, with the reason in the code.
  - Suite after the fixes: 79/79.
- **Codex review round 2 (`c19c203`): GATE FAIL, two [P1], both fixed.**
  - [P1] Each editor mount made its own save queue, and an unmounted editor's queue kept
    draining: leave mid-save, reopen, type, and an older pending value could land after the
    newer one. New `src/lib/documentSaves.ts` keeps one queue per document for the life of
    the window, shared by every mount, reporting to whichever editor is mounted now. The
    queue exposes `inFlight()`, which replaces the per-mount ref, so a reopened editor also
    recognises the echo of a save its predecessor sent. Leaving with a conflict open sends
    nothing (the edit stays in the draft and is offered on reopen).
  - [P1] "Load latest" re-saved only while a save was outstanding. If a local save had
    already overwritten the external copy and finished, the button changed the screen only.
    `mustResave` now re-saves whenever the server copy differs from the chosen one, or a
    save is in flight.
  - Failing-first: `tests/documentSaves.test.ts` failed with "Cannot find module"; after
    the change 85/85.
  - Live re-runs: a clean external write applied; a conflict resolved with "Load latest"
    left the server holding the chosen copy; an edit typed just before navigating away
    reached the server.
- **Codex review round 3 (`3f612af`): GATE FAIL, one [P1] and two [P2], fixed by two
  structural changes rather than three patches (CLAUDE.md L42 caps fix-review loops):**
  - One `adopt(value)` path for every "use the server copy" choice. [P1] "Discard" on
    restored edits now drops the shared queue's pending value (possibly from an earlier
    mount) and re-saves the server copy when a local save landed meanwhile, exactly as
    "Load latest" does.
  - The queue attachment and its debounced saver are created by an effect keyed on
    `documentId` and cleared on cleanup. [P2] StrictMode's dev remount (on in
    `src/main.tsx`) now re-attaches instead of reusing a detached handle.
  - [P2] The save queue records its last error; attaching replays it, so a page reopened
    after a failed save shows Retry, and "Keep them" also retries a stopped queue.
    Failing-first test: `expected [] to equal ["Error: backend said no"]`.
  - Suite 86/86; ESLint clean on the editor. Live, in the StrictMode dev build: a typed
    edit saved and its draft cleared; a clean external write applied; no console errors.
- **Codex review round 4 (`386b4ba`): GATE PASS (no P0/P1), two [P2], both fixed.**
  - [P2] A save finishing after its editor left the page never cleared its recovery draft,
    because draft acknowledgement lived in the mounted editor's `saved` callback. Live
    failing first: type, leave immediately, 1 draft left. Acknowledgement moved into the
    `save` hook, which keeps running after detach. Re-run: saved, 0 drafts.
  - [P2] When "Load latest" has to re-save the chosen copy, that copy is now the recovery
    draft (and the editor is dirty) until the repair write lands, so a reload in between
    still offers it. Exercised by reasoning and the suite only; the gated double-save
    timing is not reproducible by hand.
  - Suite 86/86.
