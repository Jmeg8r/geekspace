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
