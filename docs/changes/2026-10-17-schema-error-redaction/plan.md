# Plan: schema-error-redaction

Intent: [intent.md](intent.md). Track T1.

## Design

In `pushFunctions`, replace `${status.error}` with `schemaFailureDetail(status.error)`:
take the text up to the first line break, trim it, cap at `MAX_DETAIL_CHARS`. A missing
or non-string error becomes `"no detail from the backend"`.

Why the first line rather than cutting at `Object:`: the backend has more than one
failure shape (a type mismatch reports `Path:` / `Value:` lines, and `Value:` is document
content too). Keeping only the first line is an allowlist; cutting at known markers is a
denylist that the next shape slips through.

## Steps

1. Failing-first test in `tests/functionSync.test.ts`: `pushFunctions` against a fake
   fetch whose `wait_for_schema` returns `failed` with a realistic multi-line error
   (shape copied from the live capture, fake values; a long `content` field). Assert the
   message contains the table, document ID and field name; does not contain `Object:`,
   `Validator:` or the fake content; and its detail is at most `MAX_DETAIL_CHARS`. A second
   case: a single very long first line is capped. → verify: red for the right reason.
2. Implement the helper. → verify: those tests green.
3. `npm run verify`; `snyk test`. → verify: exit 0 / no new issues.
4. Rerun the probe: `npm run probe:schema-failure -- --config <main checkout>/.convex/local/default/config.json`.
   → verify: passes, and its printed error line has no `Object:`.
5. Forge PR; Codex review posted verbatim as a PR comment.

## Risks

- **PR #66's probe does not run against current main.** Since PR #67 (no-downgrade),
  `writeBundle` requires an `ordinal` and `readMarker` returns `{ hash, ordinal }`; the
  probe passes neither shape and fails at bundle A. The 2026-10-17 capture above came from
  a scratch copy patched for both (not committed). Step 4 runs that same patched copy
  unless #66 is rebased first; that fix belongs to #66.
- A future backend could put content on the first line. The `MAX_DETAIL_CHARS` cap bounds
  the damage; the live capture shows it does not today.

## Deviations

- **Typecheck caught the test commit.** `npm run verify` failed on `tests/functionSync.test.ts`
  (the `.d.mts` lacked `MAX_DETAIL_CHARS`; `result.error` is typed `Error`). Fixed in a
  follow-up commit rather than rewriting the failing-first commit.
- **Detail is the first non-empty line**, not literally line 1, so a message that starts
  with a newline still reports something.

## Proof results (2026-10-17, Mac Studio)

- Red (test commit): 3 new tests failed for the intended reasons: message contained
  `Object:`; detail was 8019 chars (cap 500); a missing error printed `undefined`.
- Green: `tests/functionSync.test.ts` 44/44.
- `npm run verify`: typecheck and lint clean; vitest 270/274, the 4 failures all in
  `tests/mcpSchemaFirst.test.ts` (timeouts). That file does not touch `functionSync`, and
  `keeps discovery scoped to each stdio session` also times out on a clean `origin/main`
  checkout (`4f39fe7`) at load average ~7: pre-existing, not this change.
- `snyk test`: 4 issues (zod x2, qs, hono), all pre-existing; no dependency changes.
- Probe (scratch copy of PR #66's script patched for #67, see Risks; config from the main
  checkout): exit 0, endpoints `start_push, wait_for_schema` only, marker unchanged,
  pages 6 → 6. Logged line: `Schema validation failed (table "pages"): Document with ID
  "jh72…" in table "pages" does not match the schema: Object is missing the required field
  `probeRequired`. …` and nothing after it. `Object:`/`Validator:`/seeded title: 0 hits in
  the run output (positive control: 2 hits in the pre-fix run's output). Admin key and
  instance secret by value: 0 hits.
