---
change: 2026-10-17-docs-search
status: accepted
track: T2
intent: ./intent.md
linear: pending
---
# Plan: hidden-aware search; a live doc viewer; uploads that fail loudly and clean up

## Files that change

- `convex/search.ts` `searchAll`:
  - takes a bounded candidate set (`SEARCH_CANDIDATES = 50`) from each search index;
  - filters pages with `isPageHidden`, rows by their database page's `isPageHidden`, and
    docs by `trashed`;
  - slices to the existing counts (10 pages, 10 rows, 6 docs);
  - the empty-query shape includes `docs: []`.
- `convex/docs.ts`: `get({ docId })` returns the doc with its URL, or null when it's
  missing or trashed.
- `convex/files.ts`: `discardUnattached({ storageId })` deletes the file only if no `docs`
  or `meetings` row references it, and says so when it refuses.
- `src/components/docs/DocsPage.tsx`:
  - `viewingId` replaces the `viewing` snapshot;
  - upload errors are collected per file and shown in a dismissible banner;
  - if `addDoc` fails after the upload, `discardUnattached` runs.
- `src/components/docs/DocViewer.tsx`:
  - takes `docId`, reads `docs.get`, and closes with "This file was deleted" on null;
  - `TextPreview` resets its state per URL, checks `r.ok`, and is keyed by doc id;
  - Open shows its error.
- Tests: `tests/searchHidden.test.ts`, `tests/docsData.test.ts` (convex-test).

## Order of work

1. Tests → fail for the stated reasons; commit test-only.
2. Search.
3. `docs.get` and `discardUnattached`.
4. DocsPage and DocViewer.
5. Live in the desktop app:
   - project change in the viewer;
   - two text files in a row;
   - a refused Open;
   - an upload forced to fail.
6. Verify and build.

## Risks

- **Fifty candidates may still miss a live match** when more than 50 hidden items rank
  above it. That's bounded on purpose, since search runs on every keystroke. Documented in
  the code; the realistic case (a handful of trashed pages) is covered.

## Deviations

- **Test-only commit `2cdcab6`:** all 9 tests failed for the stated reasons.
  - Search failed on behaviour: the live "Roadmap" and "invoice.pdf" were crowded out, a
    page under a trashed parent was listed, a row of a database under a trashed page was
    listed, and the empty query came back without `docs`.
  - `docs.get` and `files.discardUnattached` didn't exist yet.
- **Stale text preview, stated more precisely after testing.** The viewer closes between
  files, so the old code already re-created the preview per file. The stale case occurred
  only if a doc's URL changed while it was open. The reset on a new URL is defensive; the
  real fix there is the `r.ok` check (an error body was shown as file contents).
- **Removed a type assertion:** `setViewing(d as DocItem)` became `setViewingId(d._id)`.
- **Not live-tested:** a failed Open. The viewer can only open a valid storage URL, so the
  failure path couldn't be triggered from the UI. The code shows `result.error`, or the
  thrown error, in the viewer.
- **Suite 209/209; verify and typecheck pass.**
- **Live, browser preview on the worktree backend:**
  - two text files dropped onto the Docs page: the alpha preview read "ALPHA file
    contents"; opening bravo went from loading straight to "BRAVO file contents", with
    no alpha in any sample;
  - changing the project in the viewer stuck after re-render;
  - deleting the open doc through Convex switched the viewer to "This file was deleted";
  - an upload forced to 503 showed "1 file wasn't uploaded · probe8-fails.txt: upload
    failed (503)" on the page.

  Console errors from the same tab (WebSocket failures, "Could not find public function
  for 'settings:get'") date from when the worktree's `convex dev` watcher had exited and
  was restarted. After the restart, `settings.get` answers and the socket is connected.
