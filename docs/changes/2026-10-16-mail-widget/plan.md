---
change: 2026-10-16-mail-widget
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: read the Home Mail widget from Mail's Envelope Index

## Files that change

- **`electron/mailIndex.mjs`** (new) + **`electron/mailIndex.d.mts`**: pure, testable module.
  - `findEnvelopeIndex(mailRoot)`: the highest `V<n>` directory under `~/Library/Mail` that
    contains `MailData/Envelope Index`; a `MailIndexError("no-store")` if none.
  - `readNewestInbox(dbPath, limit)`: opens with `node:sqlite` `DatabaseSync(path,
    { readOnly: true })`, sets a 2 s busy timeout, checks the schema, runs the query,
    maps the rows, and closes in `finally`.
  - `MailIndexError` with a `kind`: `no-store | no-access | schema | no-inbox | query`, and
    a user-facing message for each kind.
- **`electron/integrations.mjs`**: `fetchInbox(limit)` calls the module (limit clamp 1–25
  kept). The JXA inbox script, including its silent `catch → "[]"`, is removed.
  `armAutomation("Mail")` is no longer called for the inbox; Mail stays in `ALLOWED_APPS`
  for `isAppRunning`/`openApp`.
- **`src/components/home/HomeView.tsx`**: drop the Mail-not-running gate (James decided, intent.md).
  Error rendering already exists (`state === "error"`).
- **`tests/mailIndex.test.ts`** (new): builds fixture databases with `node:sqlite` in a
  temp dir. Runs on Linux CI; no `/usr/bin/sqlite3` dependency.

## Query

```sql
WITH inbox(id) AS (SELECT ROWID FROM mailboxes WHERE <last URL path segment, lower> = 'inbox')
SELECT m.date_received, m.read, m.subject_prefix, sj.subject, ad.address, ad.comment,
       gd.message_id_header
FROM messages m
LEFT JOIN subjects sj ON sj.ROWID = m.subject
LEFT JOIN addresses ad ON ad.ROWID = m.sender
LEFT JOIN message_global_data gd ON gd.ROWID = m.global_message_id
WHERE m.deleted = 0
  AND (m.mailbox IN inbox OR m.ROWID IN (SELECT message_id FROM labels WHERE mailbox_id IN inbox))
ORDER BY m.date_received DESC
LIMIT ?
```

The URL's last segment is computed in JS from `SELECT ROWID, url FROM mailboxes` (327 rows)
and passed in as ids, so URLs are never sent anywhere. Mapping: `subject =
subject_prefix + subject` or "(no subject)"; `sender = comment ? "comment <address>" :
address`; `date = date_received * 1000`; `read = read !== 0`; `id = message_id_header`.
That's the same `MacMailMessage` shape as today, so `messageUrl` and "make task" work unchanged.

## Order of work

1. Commit intent.md + plan.md as drafts → James accepts → `docs(intent): accept mail-widget`.
2. **Failing-first tests**, committed alone (`test(mail): …`), each failing against `main`:
   - newest-first across direct-inbox and Gmail-label rows, excluding deleted rows and
     non-inbox mailboxes; limit respected;
   - field mapping: prefix + subject, display name + address, ms dates, read flag, id;
   - `findEnvelopeIndex` picks the highest `V<n>` and ignores a `V<n>` without the file;
   - each error kind: missing store; unreadable file (via an injectable `open` that throws
     SQLite's "authorization denied" / `EPERM` shapes, since chmod isn't portable);
     a missing column; zero inbox mailboxes (error, **not** `[]`);
   - inbox mailboxes present but empty → `[]` (genuine Inbox zero);
   - the DB is opened read-only (a write through the handle throws).
3. Implement `mailIndex.mjs`; wire `fetchInbox`; update HomeView.
4. VERIFY (below); update plan.md Deviations in the same commit as any departure.
5. Codex review posted verbatim to the forge PR with PASS/FAIL; James approves the merge.

## Risks

- **`node:sqlite` is flagged experimental** in Node 24 and prints an `ExperimentalWarning`.
  Confirm it loads in Electron 42's main process (dev and packaged) before relying on it.
  Fallback: `execFile("/usr/bin/sqlite3", ["-readonly", "-json", …])`, which is macOS-only
  but has no dependency.
- **Synchronous read on the main thread.** 55 ms warm. A cold 2.2 GB file could be slower.
  Measure cold in VERIFY; if it's over ~250 ms, move the read into a `worker_thread`.
- **Full Disk Access detection.** TCC denials surface as `SQLITE_CANTOPEN` /
  "authorization denied" / `EPERM` depending on layer. Classify all three as `no-access`
  and include the raw code in the message so a new shape is still debuggable.
- **Schema drift** (`V11`): handled by the schema check and the `schema` error, which names
  the missing table/column.
- **Merge with PR #58**, which edits the calendar function beside `fetchInbox`. Rebase
  after #58 merges.
- **Privacy.** Tests use synthetic fixtures only. No logging of rows; errors carry codes and
  table/column names, never content.

## Proof

- `npm run verify` (oxlint, `tsc -b --noEmit`, vitest) green; the new tests' first run
  against `main` is shown failing in the test-only commit.
- `snyk test` (no new dependencies expected).
- Live on James's Mac Studio, with approval at each step, printing counts, timings and
  booleans only:
  - `npm run dev` → Home widget shows 12 rows; cold and warm read times logged as numbers.
  - **Packaged build without Full Disk Access** → the `no-access` message appears (proves
    the dev/packaged trap is caught).
  - James grants FDA to the packaged app → 12 rows; clicking one opens Mail (James confirms).
  - Renamed copy of a fixture missing a column → `schema` message, via a test, not live.

## Options not taken

- **JXA/AppleScript variants**: all measured too slow or failing at 264K (intent.md).
- **Spotlight (`mdfind`)**: returns no Mail messages on macOS 27.
- **Gmail/Outlook APIs**: OAuth, token storage and per-provider code for a widget that the
  local index serves in 55 ms across all accounts. Kept for later features.
- **`better-sqlite3`**: a native module needing electron-rebuild on mac and win for a
  mac-only feature.
- **`immutable=1`**: skips the WAL, so new mail would be missing until Mail checkpoints.

## Deviations

- **Listing `~/Library/Mail` is itself privacy-protected.** Without Full Disk Access the
  first failure is the directory listing, not the SQLite open. `findEnvelopeIndex` classifies
  `EPERM`/`EACCES` there as `no-access` too, not `no-store`. Its test was added with the
  implementation, not in the test-only commit `132691f`.
- **The widget asks for 12 messages, not 10**, matching the goal of the newest ~12.
- **Test-only commit `132691f`** fails on the missing module: the reader is new, so there
  is no old behaviour to fail against. Instead, the error branches were mutation-checked:
  disabling access detection fails 4 tests, and removing the no-inbox guard fails 1.
- **Read-only proof:** the test checks `openIndexReadOnly` directly (a `DELETE` through it
  throws `readonly`), and checks that `readNewestInbox` closes the handle it opened.
- **Codex round 1 (`290de4e`): GATE PASS, one [P2], fixed. The read now runs in a worker
  thread.**
  - The issue: a 2 s busy wait, or a cold read of the 2.2 GB file, would freeze Electron's
    main process.
  - New `electron/mailIndexWorker.mjs` and `readNewestInboxInWorker`. Error kinds cross
    the thread boundary, and a 15 s timeout ends the worker with a visible `query` error.
  - Before relying on it, a throwaway `app.asar` proved that Electron 42 loads a
    `worker_threads` script from inside the asar and runs `node:sqlite` there.
  - Live in the Electron 42.11.8 runtime: 12 rows, 45–73 ms round trip.
  - Failing-first: commit `0fd9616`, 3 tests. Suite 192/192.

  The native `codex review` run returned untagged prose ("No actionable regressions"), so
  the gate failed closed on that run. The verdict above is from the tagged `codex exec`
  rerun.
- **Superseded by the worker change above: main-thread read kept.** Live via this module (counts, timings and booleans only):
  - Node 24.14: 12 rows, 22–26 ms;
  - Electron 42.11.8 runtime (`ELECTRON_RUN_AS_NODE`): 12 rows, 24 ms;
  - in both runs: newest first, every id/subject/sender present, 10 unread.

  That's well under the 250 ms threshold, so no `worker_thread`. A truly cold read of the
  2.2 GB file wasn't measured, because the OS page cache was warm from the probes.
- **`node:sqlite` loads in Electron 42 without an ExperimentalWarning** in the probe's
  output.
- **`snyk test`:** 3 issues (zod; hono and qs via `@modelcontextprotocol/sdk`), all
  pre-existing. This branch changes no dependencies.
- **Suite 189/189; `npm run verify` passes.** New `as` assertions: none.
- **Not yet live-tested (needs James):** the widget in `npm run dev`, and the packaged
  app without, then with, Full Disk Access. Claude didn't render the widget, because that
  would put real subjects and senders on screen.
