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

Results of the plan's proofs, run 2026-09-29, and the departures from the plan text.

- **Test first (step 1).** Against the stub, 4 of 6 tests fail and 2 pass. The
  foreign-id failure is more than an error: the stub hands back the `events` document
  (`{ _id: 'events:1', ... }`) as a page. That is why the fix uses `normalizeId`;
  relaxing the validator to `v.string()` alone would leak other tables' documents
  through `pages.get`.
- **The test file was reworked after `npm run verify` flagged it.** The first version
  had two lint errors under this repo's `anti-slop` rules (an open `Record<string,
  unknown>` and a chained `as unknown as`) plus assertion warnings. The rewrite uses a
  `Map` and one commented assertion, and the test-first commit was amended while it was
  still unpublished, so that commit is lint-clean and still shows the same 4 failures on
  the stub.
- **Mutants (step 2), on the final test.** Real helper: 6/6 pass. Old behaviour (no
  `normalizeId`): 4 fail. Wrong table (`"events"`): 3 fail. Null not guarded: 3 fail.
  My first mutant run was invalid: I stored the command in a shell variable, and zsh does
  not word-split it, so every run exited 127 and executed nothing. It was redone with a
  shell function, and those results are the ones above.
- **`npm run verify` and build (step 3):** 4 test files, 50 tests (the earlier 44 plus 6),
  0 lint errors, and 219 lint warnings, the same count as `main`. The build passes.
- **Live before/after (step 4), on a copy of the dev data and a temporary Electron
  profile.** A control with nothing planted was healthy (5 sidebar rows, 721 characters of
  text, 0 errors). With the `events` id from #41 planted in the stored nav and the
  un-fixed `pages.get`: `#root` had 0 children, 0 characters and 0 sidebar rows, with one
  console error and `ArgumentValidationError: Found ID ... from table events` in the
  server log. After the fix was pushed by `convex dev`: the sidebar (5 rows) and "This
  page is gone" render, with 0 errors, on two repeat probes; the malformed id `not-an-id`
  behaves the same; and a real doc page still renders (795 characters, 0 errors). This
  also resolved the plan's risk that the copy might not decode the id as `events`: it does.
- **One console error in the first post-fix probe.** It matches a validator error the
  server logged at 16:05:13, two seconds *before* `convex dev` reported the fix live at
  16:05:15, so it was the old renderer's live subscription re-running against the old
  code during the push. The server log has no validator error after 16:05:15, and the two
  repeat probes are clean. This is an inference from timing, not something I could
  observe directly.
- **Server contract (step 5).** `npx convex run pages:get` exits 0 with empty output for
  the `events` id and for `not-an-id`. Empty output is a `null` result: the CLI skips
  printing a null (`node_modules/convex/dist/cjs/cli/lib/run.js:122`, `if (result !==
  null)`), an empty array prints `[]`, and the UI showed the "gone" message that
  `PageView` renders only for `null`. A real page id returns its document. A non-string
  argument (`{"pageId": 123}`) still fails with exit 1, which is fine: stored ids are
  always strings.
- **The installed app's data dir was checked and left untouched:** 391 files with the same
  mtimes and sizes before and after, the same sqlite SHA-256 prefix (`84eeb4477b876ca9`),
  and no journal files.
- **`convex dev` regenerated three files under `convex/_generated/`** (the same drift seen
  in #39 and #40). Reverted, so the change is the helper, the query, the test and the
  change folder.
- **Cleanup slip.** My first attempt to stop the probe processes killed nothing: I looped
  over an unquoted variable, and zsh does not split it (the trap the sovereign-forge
  CLAUDE.md lists). Ports 3210, 5173 and 9333 were still held, so I noticed at once and
  redid it with a
  `while read` loop. Everything stopped was a process of this worktree or a wrapper shell
  of my own background jobs.
