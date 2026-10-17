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
