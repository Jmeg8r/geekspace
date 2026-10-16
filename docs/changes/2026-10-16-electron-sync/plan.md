---
change: 2026-10-16-electron-sync
status: accepted
track: T2
intent: ./intent.md
linear: pending
---
# Plan: exact-origin boundaries, sandboxed renderer, staged seeding, a mirror that deletes only what it read

## Files that change

- `electron/desktopSafety.mjs` (new, with `.d.mts`), pure rules:
  - `isAppUrl(url, { devServerUrl, indexFile })` checks the exact dev origin, or the
    `file:` URL of the app's own index;
  - `isSafeExternalUrl(url)`: `http:`, `https:` or `mailto:` only;
  - `isLocalStorageUrl(url, port)`: host `127.0.0.1`, the Convex port, path under
    `/api/storage/`, and no credentials;
  - `isTrustedSender(frameUrl, …)` applies the same rule as `isAppUrl`.
- `electron/main.mjs`:
  - `will-navigate`, `setWindowOpenHandler`, `gs:openExternal` and `gs:docs:quickLook`
    use those rules;
  - `handle()` and the raw `ipcMain.handle` sites check `event.senderFrame.url`;
  - `webPreferences.sandbox: true`.
- `electron/dataDirectory.mjs` (new, with `.d.mts`): `seedDataDirectory(seed,
  destination)` stages a copy next to the destination, checks `config.json` and the
  SQLite file, then renames into place. The staging directory is always removed.
  `convexBackend.mjs` `ensureDataDir` uses it.
- `electron/integrations.mjs`:
  - `fetchCalendarEvents` returns `{ events, complete: [calendar names read without
    error] }`. A calendar with any failed event is left out of `complete`.
  - `fetchInbox` reads `dateReceived` in bulk, then subject, sender, id and read flag for
    the newest N only.
- `src/lib/integrations.ts` / `src/lib/macSync.ts`: pass `completeCalendars` to the
  mutation, and report incomplete calendars in the sync message.
- `convex/events.ts` `syncExternal`:
  - takes `completeCalendars`;
  - looks up existing mirrors via `by_end` (`end > windowStart`) filtered to
    `start < windowEnd`;
  - deletes only mirrors whose calendar is in `completeCalendars` and whose start falls
    inside the window;
  - inserts only items not already mirrored.
- Tests:
  - `tests/desktopSafety.test.ts`;
  - `tests/dataDirectory.test.ts` (temporary dirs, an interrupted copy simulated by a
    failing validator);
  - `tests/calendarSync.test.ts` (convex-test: partial calendars, a long event, no
    duplicates, removal still works for complete calendars).

## Order of work

1. Tests → fail for the stated reasons; commit test-only.
2. Boundary rules + main wiring + sandbox.
3. Staged seeding.
4. Calendar fetch completeness + `syncExternal`.
5. Mail newest-N.
6. Live:
   - launch sandboxed and click through every view;
   - an internal and an external link;
   - quick-look a stored doc;
   - the Mail timing probe, if approved.
7. Verify and build.

## Risks

- **`sandbox: true` can break a preload** that uses Node APIs. Ours uses only
  `contextBridge`, `ipcRenderer` and `process.platform`, which sandboxed preloads keep.
  Proven by the live click-through; if anything breaks, sandboxing is split out rather
  than worked around.
- **The sender check could refuse legitimate calls** if Vite serves the app from a
  different origin than expected (for example `127.0.0.1` versus `localhost`). The rule
  takes its dev origin from `VITE_DEV_SERVER_URL`, and the live click-through exercises
  every bridge.

## Deviations

- **Mail is dropped from this PR.**
  - The approved timing probe found James's unified inbox holds **263,971 messages**,
    and the current widget's script fails on it twice in a row (`-1741` after ~10 s).
    The Home Mail widget can't work today.
  - The planned fix doesn't work either at that size:
    - reading all dates in bulk works (8.7 s);
    - fetching messages by index timed out (`-1712`);
    - a date-filtered `whose` timed out at 120 s for both 2 and 7 days;
    - per-account inbox counts timed out.
  - AppleScript can't serve this inbox. A fix needs another data source, such as Mail's
    Envelope Index, which needs Full Disk Access, or a provider API. That's its own change,
    proposed as a follow-up. Nothing gets worse here.
  - Only counts, timings and booleans were printed; no message content.
- **Recurring events:** no change. James confirmed they appear every week.
- **Test-only commit `c177439`:**
  - The calendar tests first failed on the new argument's validator. A temporary copy
    without that argument then failed on the old behaviour itself: an unread calendar
    lost an event, the long event was deleted, and the 60-day event was duplicated. The
    "still removes vanished events" control passed.
  - The boundary and seeding modules didn't exist yet, so those tests failed on the
    missing modules. They can't run against the old inline prefix checks.
- **Seeding:**
  - An interrupted copy is simulated with an unreadable seed file, so the copy fails
    partway.
  - Added: a half-seeded directory left by the old code (no `config.json`) is moved aside
    as `convex.incomplete-<time>`, never deleted, and seeded fresh.
- **`gs:openExternal`** now reports a refusal as an error. Live, a `file:` link first
  came back `ok: true` despite being refused.
- **Calendar sync** reports calendars it couldn't fully read in its status message
  ("kept its events") rather than passing silently. It isn't run live: that would mirror
  James's real calendar into the test backend. It's covered by the convex-test cases.
- **Not live-tested:** an IPC call from a foreign frame. The rule is the tested
  `isAppUrl`, and all 5 `ipcMain.handle` entry points are wired to it.
- **Suite 193/193; verify and typecheck pass.**
- **Live, sandboxed (`sandbox: true`) on the worktree backend:**
  - no Node in the renderer;
  - the meetings, agent, recorder and calendar bridges all answer;
  - Calendar, Meetings, Docs, Reader and Home all render;
  - Quick Look refuses `http://127.0.0.1@evil.com/x.command`;
  - navigating to `file:///etc/hosts` is blocked;
  - `openExternal("file:///Applications/Calculator.app")` is refused with "Only web and
    mail links can be opened".
- **Codex review round 1 (`46a20a5`): GATE PASS, two [P2], fixed.**
  - Deselected calendars kept their mirrors forever. They never counted as "complete",
    and before this PR the next sync removed them. The sync now also gets its scope:
    `selectedCalendars` (Settings) and `presentCalendars` (every calendar Calendar.app
    listed, null if any name failed to read). A mirror outside that scope is removed,
    meaning deselected or its calendar deleted. A selected, existing calendar that failed
    to read keeps its mirrors. 3 tests added.
  - The interrupted-copy test used `chmod 000`, which doesn't make a file unreadable on
    Windows or for root. `seedDataDirectory` now takes an injectable `copy`, and the test
    uses a copy that writes one file and then throws. Portable.
  - Suite 196/196.
- **Codex review round 2 (`3b2b0aa`): GATE PASS, one [P2], fixed.** In "all calendars" mode
  the status note compared completeness against an empty selection, so a failed read
  showed "Up to date". `incompleteReadNote` (new `src/lib/calendarSyncStatus.ts`, pure)
  scopes the check to the selection, or to every listed calendar, and treats a partial
  calendar list as incomplete. 4 tests. Suite 200/200.
