---
change: 2026-10-17-bundle-split
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: lazy views and a lazy editor, with an idle prefetch

## Files that change

- `src/App.tsx`:
  - `React.lazy` for CalendarView, MeetingsView, KnowledgePage, ReaderPage, DocsPage,
    PageView, AgentPanel, CommandPalette, SettingsModal and TemplatesModal;
  - one `<Suspense>` around the main view with a quiet loading state, and a null
    fallback for overlays;
  - an idle prefetch of the editor after the first render.
- `src/components/page/PageView.tsx` and `src/components/database/RowPeek.tsx`: import
  `Editor` lazily (`src/lib/lazyEditor.ts`, which exports the lazy component and its
  `preloadEditor()`).
- `tests/bundleBoundaries.test.ts`: reads `App.tsx`, `PageView.tsx` and `RowPeek.tsx` and
  fails if any lazy-only module is imported statically.

## Order of work

1. The boundary test → fails on `main`; commit test-only.
2. `lazyEditor` + PageView/RowPeek.
3. Lazy views in App, Suspense, prefetch.
4. Build and compare chunk tables.
5. Live: run the built `dist/` in Electron (no dev server), open every view, a page and
   a row, and check the console.
6. Verify.

## Risks

- **A view that renders immediately on launch** (say, a remembered page) waits for its
  chunk. That's a local-disk read, but the idle prefetch only covers the editor. Checked
  live by relaunching on a page.

## Deviations

- **Test-only commit `91a2b11`:** both boundary checks failed on `main` (App imported all
  10 views statically; PageView and RowPeek imported `Editor`). The scanner control
  passed.
- **The AgentPanel is mounted only while open.** It used to be always mounted and hide
  itself, which with `lazy` would still have loaded it at startup.
- **Results:**

  | Chunk | Before | After |
  |---|---|---|
  | Entry (`index`) | 1,556.68 kB (470.64 kB gzip) | **481.42 kB (152.88 kB gzip)** |
  | Editor (BlockNote stack) | in the entry | 931.91 kB (279.61 kB gzip), loaded on first page/row open, prefetched when idle |
  | PageView / Calendar / Meetings / Docs / Reader / Agent / Settings / Palette / Knowledge / Templates | in the entry | 55.4 / 24.0 / 13.4 / 13.0 / 11.4 / 7.0 / 9.5 / 4.3 / 4.1 / 3.3 kB |
  | emoji-mart data (`native`, `module`) | 432.75 + 77.27 kB, lazy | unchanged |

- **Not met as written:**
  - Vite still prints its 500 kB warning, now for the *editor* chunk. The entry chunk
    meets the target. I didn't raise `chunkSizeWarningLimit` to hide it.
  - Total JS grew about 0.7% (≈14 kB) from per-chunk overhead, against "total bytes
    don't grow".
- **Live, built `dist/` in Electron from `file://` (no dev server), worktree backend:**
  - Home, Calendar, Meetings, Docs, Reader and Knowledge each rendered without the
    loading state;
  - a doc page showed an editable BlockNote editor;
  - the Tasks database table rendered;
  - a row opened in the side panel with its BlockNote editor;
  - no console errors or exceptions during the run.

  Chromium doesn't record resource timing for `file://` loads, so this run can't show
  *when* each chunk loaded. That the editor isn't in the entry chunk is proven by the
  build output. The same row-panel flow was also checked in the dev browser preview.
- **Suite 212/212; verify and build pass.**
