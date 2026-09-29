---
change: 2026-09-29-pages-get-foreign-id
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: a persisted page id that is not a `pages` id must not blank the app

## Files that change

- `convex/lib/pageLookup.ts` (new): `getPageByAnyId(db, pageId: string)`.
  It calls `db.normalizeId("pages", pageId)` and returns `null` when that is `null`,
  otherwise `db.get(id)`. It takes `Pick<DatabaseReader, "normalizeId" | "get">`, so a
  unit test can pass a fake `db`. `normalizeId(tableName, id: string): GenericId | null`
  was checked in Convex 1.46.0's `database.d.ts`.
- `convex/pages.ts`, the `get` query only: `args: { pageId: v.string() }` and
  `handler: async (ctx, args) => getPageByAnyId(ctx.db, args.pageId)`, plus one import.
- `tests/pageLookup.test.ts` (new): the unit test.
- `docs/changes/2026-09-29-pages-get-foreign-id/`: this folder.

Not changed: `src/` (no client change), `PageView.tsx`, `mcp/index.mjs` (its
`if (!page) throw new Error("Page not found")` already handles `null`), and the UI copy.

## Order of work

1. **Test first.** Write `tests/pageLookup.test.ts` with a fake `db`, and a stub
   `convex/lib/pageLookup.ts` that does the *old* thing, `db.get(pageId)` with no
   normalisation → verify: the foreign-id and malformed-id cases FAIL, the valid-id and
   deleted-page cases pass. Commit the failing test before the fix.
2. Write the real helper and switch `pages.get` to it → verify: the unit test passes; then
   the mutant (the helper with `normalizeId` removed) fails the foreign-id case again.
3. `npm run verify` and `npm run build` → verify: pass, with the new tests counted.
4. **Live before/after** on a copy of the dev data and a temporary Electron profile.
   This runs `convex dev`, Vite and `electron . --user-data-dir=<tmp>` separately rather
   than through `npm run dev`, because that command cannot take a profile flag, and
   `npm run dev`'s default profile is James's own dev state. It also keeps the fixed and
   un-fixed runs on the same backend:
   1. start the three processes on the copy, with the source still at the un-fixed
      `pages.get`; plant `geekspace-ui` with `nav = { kind: "page", pageId: <the
      events id from #41> }`, reload → expect an empty `#root` and
      `ArgumentValidationError` in the `convex dev` log (the pre-fix repro);
   2. put the fix in place; `convex dev` pushes it → reload → expect the sidebar plus
      "This page is gone — check the trash." and no error in either log;
   3. repeat with a malformed string (`"not-an-id"`) and with a real page id (expect the
      page to render).
5. **Server contract**, with the convex CLI against the same copy: `npx convex run
   pages:get` with the `events` id, a malformed string and a real page id from
   `pages:list` → verify: `null`, `null`, the document. The old validator's behaviour is
   captured in step 4.1.
6. Clean up: stop the three processes by PID, delete the data copy and the temporary
   profile, restore `convex/_generated/` if `convex dev` regenerated it → verify: `git
   status` shows only the four files above.
7. Commit, push, open the PR → verify: CI green (Typecheck & tests, Dependency Audit,
   secret-scan); the ai-review gate reads it.
8. Codex review, posted verbatim → merge on James's approval → comment on #28, close #41.

## Risks

- **`api.pages.get`'s argument type widens** from `Id<"pages">` to `string`. `PageView`
  passes an `Id<"pages">` and the MCP tool a string, so both still type-check. `tsc -b`
  in `npm run verify` confirms it.
- **The "gone" message is inaccurate** for a foreign id ("check the trash"). Accepted:
  copy changes are out of scope, and the sidebar is visible, so recovery is one click.
- **#28 conflict:** #28 adds imports at the top of `convex/pages.ts`, next to the one this
  change adds. Expect a trivial conflict at most, resolved on whichever lands second.
- **The live proof plants an id that decoded as `events` in this copy** (#41). If the copy
  decodes it differently, step 4.1 will not reproduce the blank window. In that case use
  an id read from another table with `pages:list`-style CLI queries instead, and record it.

## Proof

| Signal | Command or place | Expected |
|---|---|---|
| test first | `npx vitest run tests/pageLookup.test.ts` on the stub | foreign and malformed cases fail |
| fix | the same on the real helper | all pass |
| mutant | helper without `normalizeId` | the foreign-id case fails |
| pre-fix repro | planted `events` id, un-fixed `pages.get` | empty `#root`; `ArgumentValidationError` |
| post-fix | the same input after the fix | sidebar + "This page is gone", no error |
| contract | `npx convex run pages:get` | `null`, `null`, the document |
| verify | `npm run verify`, `npm run build` | pass |
| CI | PR head statuses | green |

## Options not taken

- **A root error boundary** (with or without the server fix): a broader UX change with its
  own design (what to show, what to reset). Better as a separate PR.
- **Resetting `nav` when `pages.get` returns `null`:** would break the deliberate
  "This page is gone — check the trash" behaviour for trashed pages.
- **An inline `ctx.db.normalizeId` in the handler:** not unit-testable without
  `convex-test`, which is not installed on `main`.

## Deviations

None yet.
