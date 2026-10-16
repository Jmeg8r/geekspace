---
change: 2026-10-16-electron-sync
status: accepted
track: T2
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a desktop shell that only trusts itself, and a calendar mirror that never loses events

## Problem

From the 2026-10-11 reassessment, re-read against `main` at `ace48af`.

**Electron boundaries (`electron/main.mjs`)**

1. **The navigation guard uses a prefix match.** `will-navigate` treats any URL starting
   with the dev server URL as internal: `http://localhost:5190.evil.com` passes. So does
   any `file://` URL, not just the app's own `index.html`. A page loaded either way runs
   with the preload bridge (meetings, agent, calendar, mail).
2. **`window.open` hands any URL to `shell.openExternal`, whatever its scheme.** Schemes
   such as `file:` or custom app schemes can launch local programs.
3. **Quick Look trusts a prefix too.** It accepts any string starting with
   `http://127.0.0.1`, so `http://127.0.0.1@evil.com/x.command` passes but downloads from
   `evil.com`. The file is then opened with its default app, and for a `.command` file
   that means running it.
4. **IPC handlers never check who is calling.** Every `gs:*` handler answers any frame.
   With items 1–3 fixed this is defence in depth, not an open hole.
5. **The renderer is not sandboxed.** `contextIsolation` is on, but `sandbox` is not set.

**First launch**

6. **Seeding can leave a broken workspace.** The packaged app's first launch copies the
   bundled seed straight into the live data directory. The "already seeded" test is only
   "config.json exists". A quit or crash mid-copy leaves a partial database that every
   later launch accepts as real.

**Calendar mirror (`electron/integrations.mjs`, `convex/events.ts` `syncExternal`)**

7. **A partial read deletes events.** A calendar that fails to read, or a single event
   that throws, is skipped silently, and the sync then deletes every mirror it didn't
   see. One flaky read can empty a calendar in Geekspace and re-plan the week around
   the gap.
8. **Long events flap.** The fetch asks for events that *start* inside the window, but
   the sync deletes mirrors that *overlap* it. An event that began before the window is
   deleted on every sync and never comes back.
9. **Old long events are duplicated.** Existing mirrors are looked up only 35 days before
   the window, so a still-running event that started earlier isn't found and is inserted
   again on every sync. (Deferred to this PR from 4b.)

**Mail**

10. **The inbox widget reads the whole inbox.** To show the newest 12 messages it pulls
    the subject, sender, id and read flag of every message in the inbox.

## Proposed outcome

- **Navigation:**
  - internal pages are matched by exact origin;
  - `file:` is allowed only for the app's own `dist/index.html`;
  - external opens (window.open, links, `gs:openExternal`) are limited to `http:`,
    `https:` and `mailto:`.
- **Quick Look** parses the URL and accepts only `http://127.0.0.1:3210/api/storage/…`.
- **Every `gs:*` IPC handler** checks that the calling frame is the app's own page.
- **The renderer runs sandboxed** (`sandbox: true`). The preload already uses only
  `contextBridge` and `ipcRenderer`.
- **First launch** copies the seed into a temporary directory next to the data directory,
  validates it, then renames it into place. An interrupted copy leaves no data directory,
  and the next launch retries.
- **Calendar sync:**
  - the fetch reports which calendars it read completely;
  - mirrors are deleted only for those calendars, and only for events that start inside
    the window (the same rule the fetch uses);
  - existing mirrors are found by end time, so long-running events are never duplicated.
- **Mail** fetches all dates in one call, then reads the other fields only for the
  newest N messages.

## Affected users and systems

- Desktop app on mac (the Calendar and Mail integration is mac-only). The boundary
  changes apply on Windows too.
- No schema change.
- geekspace is public on GitHub, so every commit here is published when it syncs.

## Constraints

- No real calendar or mail content in tests or probes. The sync is proven with
  convex-test fixtures, and the JXA changes by reading and by an optional count-only
  timing probe (see the open questions).
- Boundary rules are pure functions with tests, so they're proven without a browser
  exploit.

## Out of scope

- Windows Calendar and Outlook: Phase B.
- Recurring events: James confirmed (2026-10-16) that recurring meetings do appear every week, so
  no change is needed; my suspicion that AppleScript skips them was wrong.

## Success signals

- Failing-first tests:
  - the `localhost:5190.evil.com`, arbitrary-`file:`, `127.0.0.1@evil.com` and
    `smb:`/`file:` external cases are refused;
  - the real app URLs are accepted;
  - an IPC call from another origin is refused;
  - an interrupted seed leaves no data directory;
  - a sync that misses one calendar keeps that calendar's mirrors;
  - a long event that started before the window survives sync and isn't duplicated.
- Live: the app starts sandboxed with every view working (Home, Calendar, Meetings
  bridge, Agent panel); an internal link navigates; an external link opens in the
  browser.
- `npm run verify` and `npm run build` pass. Packaging is untouched apart from seeding.

## Open questions

1. Recurring meetings: answered, they appear (see Out of scope).
2. Mail timing probe: approved by James (2026-10-16). It compares only counts and timings;
   no message content is printed.
