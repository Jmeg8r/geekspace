---
change: 2026-10-15-editor-saves
status: accepted
track: T2
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: page edits are never lost, overwritten or silently dropped

## Problem

From the 2026-10-11 reassessment (code audit, each item re-read against `main`):

1. **Failed saves vanish.** `PageView.tsx` and `RowPeek.tsx` call
   `void setContent(...)`, so a rejected save (backend restarting, transaction error) is
   swallowed: no message, no retry, and the edit is gone once the page is left.
2. **Saves can land out of order.** Each debounced save is an independent mutation; a
   slow older save can finish after a newer one.
3. **External edits are invisible, then overwritten.** `Editor.tsx` parses
   `initialJson` once. When ARCHITECT, the MCP server or a meeting re-run writes the open
   page, the editor never shows it, and its next autosave overwrites that write.
4. **Unreadable stored content becomes a blank page that autosaves over itself.** A
   `JSON.parse` failure falls back to an empty document; the first keystroke saves over
   the original.
5. **Trashed pages leak.** `pages:trash` marks only the root. Its subpages stay in
   `pages.list`, so a favourited child stays in Favorites, children appear in Home's
   "Recently edited", and MCP's `query_schema` page tree lists them.
6. **Every keystroke re-sends every page body.** `pages.list` returns each page's full
   `content`; each 600 ms autosave invalidates it, so the sidebar, Home and MCP re-receive
   the whole workspace's text. None of them reads `content`.

Open PR #28 fixes 1, 2 and 4 (`saveQueue`, `editorDraft`, a document error boundary).
It does not fix 3, 5 or 6.

## Proposed outcome

- A save that fails shows a visible "not saved" state with Retry; newer edits are kept and
  sent in order once the backend answers.
- Unsaved edits survive a reload or crash: reopening the page offers to restore them, in
  the editor itself rather than as raw JSON.
- A change made elsewhere to the open page appears in the editor when there are no local
  unsaved edits; when there are, the user chooses "Load latest" or "Keep mine".
- A page whose stored content cannot be read opens read-only with the original preserved,
  never as a blank page that saves over it.
- Subpages of a trashed page disappear from Favorites, Recently edited, the sidebar and
  MCP's page tree, and return when the page is restored.
- `pages.list` stops carrying page bodies.

## Affected users and systems

- Everyone who writes in Geekspace (pages and row pages).
- ARCHITECT and any MCP client: their page writes become visible instead of overwritten.
- `pages.list` callers: Sidebar, Home, `mcp/index.mjs` `query_schema`,
  `scripts/prebake-seed.mjs` (counts pages only).
- geekspace is public on GitHub, so every commit here is published when it syncs.
- Open PR #28: this ports its `saveQueue`, `editorDraft` and their tests; #28's copies of
  those files can then be dropped from it.

## Constraints

- No schema change, no data migration.
- Recovery drafts stay on this machine (browser storage), never in the backend.
- Proofs run on the isolated worktree backend; no real workspace data.

## Out of scope

- Real-time collaborative merging (one user, one window).
- Search results for trashed pages (PR 8).
- Row-page title editing beyond flushing it per document.

## Success signals

- Unit tests, failing first: save ordering and retry; draft acknowledgement; the
  incoming-change decision (apply / ask / ignore own echo); `pages.list` hiding subpages of
  trashed pages and omitting `content`.
- Live, on the worktree backend:
  - stop the backend mid-edit → "not saved" with Retry; restart → Retry saves the latest text;
  - reload with unsaved edits → restore offer → restored text saves;
  - `npx convex run pages:setContent` on the open page → editor shows it (clean) or offers
    Load latest / Keep mine (dirty);
  - plant unreadable content → read-only view with the original, no autosave;
  - trash a page with a favourited child → child leaves Favorites and Recently edited;
    restore → it returns.
- `npm run verify`, `npm run build` pass.

## Open questions

None.
