---
change: 2026-10-17-bundle-split
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: start the app without loading the editor and every view

## Problem

From the 2026-10-11 reassessment, measured on `main` at `d5a9d03`:

- `npm run build` emits one **1,557 kB** entry chunk (**471 kB gzipped**), loaded at every
  launch before Home can render, plus Vite's "chunk larger than 500 kB" warning.
- Measured from the sourcemap as minified bytes per package, about **860 kB of it is the
  block editor**: `@blocknote/*`, Tiptap, ProseMirror, Yjs and Mantine. Only
  `src/components/page/Editor.tsx` imports BlockNote, but `RowPeek` (which hosts the editor
  for a row) is mounted on every launch, and `App.tsx` imports every view eagerly:
  Calendar, Meetings, Docs, Reader, Knowledge, Agent, Settings, Templates and the command
  palette.
- The 433 kB `native` chunk is emoji-mart's emoji data and already loads on demand. It
  isn't part of the problem.

## Proposed outcome

- The editor loads when it's first needed: opening a page or a row. After the first
  render it's prefetched while the app is idle, so the first open doesn't wait.
- Every view except Home and the sidebar loads on first use, as do the agent panel, the
  modals and the command palette.
- A small, consistent loading state is shown while a view's code arrives (local disk, so
  normally under a frame or two).
- **Target:** the entry chunk is under 500 kB minified, with no Vite size warning for it.
  Total bytes don't grow.

## Affected users and systems

- Startup of the desktop app (dev and packaged, which loads from `file://`) and the
  browser build.
- No behaviour change beyond when code loads.
- geekspace is public on GitHub, so every commit here is published when it syncs.

## Constraints

- Lazy chunks must load under Electron's `file://` packaged load, not just the Vite dev
  server. This is proven by running the built app in Electron.
- No new dependencies.

## Success signals

- `npm run build`: the entry chunk is under 500 kB minified. The before and after chunk
  tables go in the PR.
- A test asserts that `App.tsx` imports no view module except Home and the sidebar
  statically, so the split can't quietly regress.
- Live, built app in Electron from `dist/`: every view opens, a page and a row open in the
  editor, and the console shows no chunk-load errors.
- `npm run verify` passes.

## Open questions

None.
