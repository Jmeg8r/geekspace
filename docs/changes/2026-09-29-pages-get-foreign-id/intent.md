---
change: 2026-09-29-pages-get-foreign-id
status: accepted
track: T1
author: james
accepted_by: james
linear: pending
source: conversation
---
# Intent: a persisted page id that is not a `pages` id must not blank the app

## Problem

Issue #41, as corrected in its comment thread (2026-09-29).

`pages.get` declares `args: { pageId: v.id("pages") }`. When the argument is an id from a
different table, or a malformed string, Convex rejects it *before* the handler runs, with
`ArgumentValidationError: Found ID ... from table events, which does not match the table
name in validator v.id("pages")`. The client-side `useQuery` throws that error during
render. There is no error boundary anywhere in `src/`, so React unmounts the whole tree:
on 2026-09-29 the root element was empty and the window blank, with no way to recover
inside the app. A fresh profile rendered normally.

The only persisted id that reaches a query is `nav.pageId` (`src/state/ui.ts`, persisted
under `geekspace-ui`), through `App.tsx:138` into `PageView`. `pages.get` has exactly two
callers: `PageView` and the MCP tool `get_page`, which throws the same raw validator error.

A page that was deleted or trashed is already handled: `ctx.db.get` returns `null` and
`PageView` renders "This page is gone — check the trash." How a foreign-table id got into
the stored state is not known (see the correction on #41); the fix does not depend on it.

## Proposed outcome

- `pages.get` never throws for a bad id: an id that is not a `pages` id returns `null`.
- The app then shows the shell (sidebar) and the existing "This page is gone" message,
  and one click on any page recovers.
- The MCP `get_page` tool reports "Page not found" for such an id.

## Affected users and systems

- geekspace users and developers whose persisted UI state outlives a Convex deployment.
  geekspace is public on GitHub, so every commit here is published when it syncs.
- The MCP `get_page` tool (`mcp/index.mjs`), which shares the query.
- Open PR #28 edits `convex/pages.ts` (imports at the top and unrelated handlers) and
  `PageView.tsx`. This change does not touch `PageView.tsx`, and edits `pages.ts` at the
  `get` block and its imports.

## Constraints

- Server-side change only: no client change and no UI copy change (James, 2026-09-29).
- Deleted and trashed pages keep their current behaviour.
- No real user data is touched while verifying: the proof runs on a copy of the dev
  Convex state and a temporary Electron profile.

## Out of scope

- An error boundary for other render errors (a separate design and PR).
- Changing the "This page is gone — check the trash." copy for the foreign-id case.
- Discovering how the foreign id got into the stored state.
- Stale ids in `viewByDb` and `expanded`, which are only compared client-side and are
  harmless.

## Success signals

- A unit test on the lookup helper: a foreign or malformed id returns `null` and never
  calls `db.get`; a valid id returns the page; a valid id of a deleted page returns `null`.
  Written first, and shown failing against a mutant.
- On a copy of the dev data, before the fix, a planted `events` id in the stored nav
  blanks the window and logs `ArgumentValidationError`; after the fix, the same input shows
  the sidebar and "This page is gone" with no server or console error.
- `npx convex run pages:get` returns `null` for an `events` id and for a malformed string,
  and returns the document for a real page id.
- `npm run verify` and `npm run build` pass.

## Open questions

None. Scope chosen by James on 2026-09-29: server fix only.
