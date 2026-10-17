---
change: 2026-10-17-docs-search
status: accepted
track: T2
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: search finds what's really there; the docs viewer shows the file you're looking at

## Problem

From the 2026-10-11 reassessment, re-read against `main` at `23970b3`.

**Search (`convex/search.ts`)**

1. **Trashed results crowd out real ones.** Each search takes the top 10 page hits (and the
   top 6 doc hits) and only *then* drops trashed ones. Trashed matches can push live
   matches out of the result set, down to zero results.
2. **Pages under a trashed parent still appear.** Only a page's own `trashed` flag is
   checked, not its ancestors'. The same applies to rows whose database lives under a
   trashed page. PR 4a fixed this class in the scheduler with `isPageHidden`.

**Docs (`DocsPage.tsx`, `DocViewer.tsx`, `convex/docs.ts`)**

3. **The viewer shows a stale snapshot.** `DocsPage` stores the clicked doc object, not its
   id:
   - changing the doc's project in the viewer seems to snap back, because the dropdown
     reads the old copy;
   - a rename or delete made elsewhere isn't reflected.
4. **The text preview shows the previous file.** Opening another text file keeps showing
   the old text until the new fetch lands, and an earlier error state sticks. A failed
   fetch (such as a 404) is rendered as the file's contents.
5. **Upload failures are silent.** A failed upload is only `console.error`ed; the user sees
   the spinner stop and nothing else.
6. **A failed save strands the upload.** If storing the doc record fails after the file
   was uploaded, the file stays in storage with nothing pointing at it.
7. **"Open" failures are silent.** Quick Look's result is ignored, so a refused or failed
   open does nothing visible. PR 7 made Quick Look refuse more.

## Proposed outcome

- **Search** checks enough candidates to fill each section after removing hidden items
  (trashed, or under a trashed page), up to a bounded number, and still returns up to the
  same counts as today.
- **The viewer** tracks the doc by id and reads it live (`docs.get`). It shows edits
  immediately, and closes with a note if the doc is deleted.
- **The text preview** resets on each new file, checks the response status, and shows a
  clear error for a failed load.
- **Uploads** report which files failed and why, in the Docs page itself.
- **A doc record that can't be saved** has its uploaded file deleted again, via a
  mutation that refuses to delete storage any doc or meeting still references.
- **Open** failures are shown in the viewer.

## Already done, or out of scope

- **Midnight rollover on Home** shipped in PR #55 (`useDayStart`).
- **The Home Mail widget** fails on very large inboxes. It has its own task (AppleScript
  can't read a 264k-message inbox).
- **Images removed from pages, or pages deleted forever,** leave their uploads in storage.
  Cleaning those up needs a garbage-collection design: which pages reference which files,
  across undo and trash. That's a follow-up, not a patch.

## Affected users and systems

- Command palette search, the Docs page and its viewer.
- No schema change, but a new query (`docs.get`) and mutation (`files.discardUnattached`).
- geekspace is public on GitHub, so every commit here is published when it syncs.

## Success signals

- Failing-first tests (convex-test):
  - with 12 trashed and 1 live page matching, search returns the live one;
  - a page under a trashed parent doesn't appear, and neither does a row in a database
    under a trashed page;
  - the same holds for docs;
  - `docs.get` returns the live doc and null once deleted;
  - `files.discardUnattached` deletes an unreferenced upload and refuses one a doc or
    meeting references.
- Live, in the desktop app on the worktree backend:
  - changing a doc's project in the viewer sticks;
  - switching between two text files never shows the wrong text;
  - a failed Open shows its error;
  - a forced upload failure is reported on the page.
- `npm run verify` and `npm run build` pass.

## Open questions

None.
