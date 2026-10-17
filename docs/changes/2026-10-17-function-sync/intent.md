---
change: 2026-10-17-function-sync
status: draft
track: T1
author: claude
linear: pending
source: conversation (side session from PR #59 live test)
---
# Intent: an app update brings its Convex functions with it, and one bad query can't blank the window

## Problem

Found on 2026-10-17 while live-testing forge PR #59 (Home Mail widget) on the Mac Studio,
after PR #63 (backend pin) and PR #64 (codegen) merged.

1. **Updates leave old server code in place.** `electron/convexBackend.mjs` copies the
   bundled seed (`build/convex-seed`) into the per-user data dir **only on first run**
   (`seedDataDirectory` returns early once `config.json` exists). After that, every
   packaged update runs a new renderer against the functions deployed when the data dir
   was first seeded. The only fix today is a manual `npm run deploy:local` from a repo
   checkout while the app is open. End users have no checkout.
2. **One failing query blanks the whole app.** The stale `pages:get` still had
   `args: { pageId: v.id("pages") }` (current code takes `v.string()` and resolves it via
   `getPageByAnyId`). The persisted UI state (`geekspace-ui` in localStorage, `nav`) held
   a `pageId` from another deployment, so the query threw an argument-validation error.
   The renderer has no app-level error boundary (the only one is `LoadGuard` inside the
   editor), so React unmounted the entire tree and the window went blank.

The manual fix that day was `npm run deploy:local` against the running packaged app.

## What "done" looks like

- Launching a packaged build whose bundled functions differ from what the data dir runs
  deploys the bundled functions **before the window opens**, with no repo, CLI or esbuild
  at runtime. A launch with matching functions does nothing extra.
- If that deploy fails (most likely: the user's data no longer matches the new schema),
  the old functions stay live, nothing is half-applied, and the user is **told** (dialog
  with the log path). It never fails silently and never loops.
- A render-time error anywhere in the tree shows a recoverable error screen instead of a
  blank window.
- A persisted `nav` pointing at a page that can't be loaded (throws, or no longer exists)
  lands on Home instead.

## Constraints

- `scripts/prebake-seed.mjs` header: esbuild's native subprocess can't read inside the
  asar, so the packaged app must not bundle code at runtime. Anything bundled happens at
  build time.
- The admin key lives only in the per-user `config.json`; it must never be baked into a
  shipped file.
- Electron security rules (CLAUDE.md): no new renderer access to Node/OS; this is
  main-process work.
- mac + Windows both.
- Dev mode (`npm run dev`, where `convex dev` owns :3210 and we only attach) is unchanged.

## Out of scope

- Data migrations. If a schema change rejects existing data, this change reports it and
  keeps the old functions; writing a migration is per-change work.
- Downgrades (an older app opening a data dir a newer one deployed to) beyond what the
  hash comparison naturally does (it redeploys the older bundle, same failure handling).
