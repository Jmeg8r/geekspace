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
