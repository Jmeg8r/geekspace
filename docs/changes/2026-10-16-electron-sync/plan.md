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
