---
change: 2026-11-12-outlook-connector
status: accepted
track: T3
risk: high
risk_reason: adds an OAuth sign-in and stores Microsoft Graph refresh tokens on the user's machine; a leak exposes the user's whole Outlook.com mail and calendar
author: james
accepted_by: james
linear: pending
source: conversation
---
# Intent: the Windows build reads Outlook.com calendar and mail over Microsoft Graph

## Problem

James, 2026-11-12: "On the Mac it shows up through Apple's apps already; Graph is how the
Windows build will get calendar and mail."

Geekspace's calendar mirror (which the auto-scheduler plans around) and the Home inbox
widget read Apple Calendar and Mail.app over JXA (`electron/integrations.mjs`). On the Mac,
James's Outlook.com account already reaches Geekspace that way. On Windows there is no
Apple app to read, so the Windows build has no calendar and no mail: the scheduler can
place tasks over Outlook commitments, and the inbox widget has nothing to show.

This is the first half of Phase B (Phase C, the Day Recorder, shipped first). Windows parity
beyond calendar and mail is a separate intent.

## Proposed outcome

On Windows, James signs in to his personal Outlook.com account once from Geekspace's
settings. After that:

- Outlook calendar events appear in Geekspace's calendar mirror, and the auto-scheduler
  plans around them, the same way Apple Calendar events do on the Mac.
- The Home inbox widget shows the newest Outlook inbox messages (subject, sender, received
  time, read/unread, a link that opens the message), like the Mac widget's 12.
- When Graph can't be read (signed out, token expired or revoked, offline, throttled), the
  widget and the calendar settings say so and say what to do. Nothing silently shows an
  empty inbox or an empty week.
- James can sign out, which removes the stored tokens.

On the Mac nothing changes: Apple Calendar and Mail stay the source.

## Affected users and systems

- James, on the Windows 11 machine (Alienware). The Mac Studio and the M2 MacBook Pro are
  unaffected.
- `electron/` (a new Graph client and sign-in flow, the main-process wiring, the preload
  bridge), `src/` (settings and the inbox widget), and the Convex calendar mirror
  (`convex/events.ts` `syncExternal`) as a new source.
- Microsoft identity platform and Graph (`login.microsoftonline.com`, `graph.microsoft.com`).

## Constraints

- **Read-only.** Only read scopes are requested (calendar read, mail read, plus whatever
  offline access needs for a refresh token). No write scope, ever, in this change.
- **Personal Outlook.com, new Outlook,** per James's 2026-10-14 decision. Work and school
  accounts are not supported.
- **Windows only.** The connector does not run on macOS, so no Outlook event can arrive
  twice and be double-booked by the scheduler.
- **Tokens never leave the machine in clear text.** They are encrypted at rest with the
  OS's protection, never written to Convex, the repo, logs, crash reports or the renderer.
- **No client secret.** Geekspace is a public desktop app and the repo is public on GitHub,
  so the sign-in uses a public-client flow with nothing secret embedded.
- **The renderer gets narrow, named IPC calls,** not a Graph client or a token (CLAUDE.md
  review standards). `contextIsolation` stays on, `nodeIntegration` off.
- **A partial read never deletes events.** The calendar mirror's existing rule (from
  `2026-10-16-electron-sync`) applies to the new source: only calendars read completely
  have their missing mirrors removed.
- **Failures are loud.** Every Graph failure surfaces in the UI or the log with enough
  context to act on; none becomes an empty result.
- Convex mutations validate the new source's input at the handler boundary.
- The Mac's behavior and tests stay unchanged.

## Out of scope

- Writing to Outlook (sending mail, creating or changing events).
- Running the Graph connector on macOS, or de-duplicating Graph and Apple sources.
- Work or school (Entra ID) accounts, and more than one Outlook account.
- The Day Recorder on Windows, the Windows Calendar and Mail apps, and other Windows
  parity work (the separate Windows intent).
- Phase D (routing jobs across machines).

## Success signals

All on the Alienware with the packaged Windows build, unless stated.

1. **Sign-in:** from settings, the Microsoft consent screen lists only read permissions;
   after consent, settings show the signed-in Outlook.com address. Screenshot of both.
2. **Read-only proof:** the access token's `scp` claim contains no `*.ReadWrite` or
   `*.Send` scope (decoded in a test or probe, not by reading a screen).
3. **Calendar:** an event created in Outlook on the web appears in Geekspace's calendar
   within one sync cycle, and a task the scheduler places that day does not overlap it.
   Screenshot of the calendar plus the task's scheduled time.
4. **Mail:** the inbox widget's newest messages match the top of the Outlook on the web
   inbox (same subjects, same order). Side-by-side screenshot.
5. **Failure is visible:** after revoking Geekspace's access at account.microsoft.com, the
   next sync shows a "sign in again" message in the widget and settings, and the calendar
   mirror keeps its existing Outlook events. Screenshot plus a Convex event count before
   and after.
6. **No secrets at rest in clear text:** a search of Geekspace's data folder, its logs and
   the Convex data for the refresh token's first 16 characters finds nothing.
7. **Sign-out:** after sign-out the stored token file is gone and the next sync makes no
   Graph call (log line).
8. **Mac unchanged:** `npm run verify` passes on the Mac, and the Mac build makes no call to
   a Microsoft host (network log or a test that asserts the connector is not started on
   darwin).

## Open questions

- **Does the packaged Windows build install and run on the Alienware today?** James hasn't
  tried. The plan's first step proves it before any connector work; if it doesn't run,
  that work moves to the Windows intent and this one waits.
- Who registers the Microsoft app (client ID), under which Microsoft account, and where the
  public client ID lives in the build.
- Which Outlook calendars sync: all of them, or a chosen list like the Mac's calendar names
  setting.
- How often Windows syncs, and whether it uses the Mac mirror's window setting as-is.
- Whether the Linear project for geekspace should carry this change (`linear: pending`).
