---
change: 2026-10-17-schema-error-redaction
status: proposed
track: T1
author: claude
accepted_by: pending
linear: pending
source: finding from forge PR #66 (schema-failure probe), Deviations section
---
# Intent: a failed function update never writes the user's documents into the log

## Problem

When a packaged launch's function sync fails schema validation, `pushFunctions` in
`electron/functionSync.mjs` throws `Schema validation failed (table "…"): ${status.error}`
with `status.error` untruncated, and `syncFunctions` logs it to `logs/convex.log`.
`MAX_DETAIL_CHARS` caps only HTTP errors in `post()`.

The pinned backend's `wait_for_schema` `failed` error is multi-line, and everything after
the first line is the offending document and the whole table validator. Captured live on
2026-10-17 (probe from PR #66, seeded data):

```
Document with ID "jh70…" in table "pages" does not match the schema: Object is missing the required field `probeRequired`. Consider wrapping the field validator in `v.optional(...)` if this is expected.

Object: {databaseId: "kd72…", favorite: true, icon: "…", kind: "database", order: …, title: "Projects", trashed: false, updatedAt: …}
Validator: v.object({content: v.optional(v.string()), … })
```

For a real user that `Object:` line is one of their pages, `title` and `content`
included, written in plain text to a log file they may attach to a bug report. It is also
unbounded in size (a long page's `content`).

## What "done" looks like

- The logged and thrown message keeps the first line: document ID, table, and the
  missing or mismatched field.
- Nothing from the `Object:` / `Validator:` dump (or any later line) reaches the message.
- The kept detail is capped at `MAX_DETAIL_CHARS`, like HTTP errors.
- `error.tableName` and the `(table "pages")` prefix are unchanged, so the probe's
  assertion that the message names the table still holds.

## Constraints

- No Electron import in `functionSync.mjs`; mac + Windows both (pure string handling).
- No new place to stash the full detail (no `error.detail`): the point is that it is not
  kept anywhere a log can reach.

## Out of scope

- HTTP error bodies from `post()` (already capped; they are server messages, not
  documents, as far as observed).
- Rebasing PR #66's probe onto main (see plan.md, Risks).
