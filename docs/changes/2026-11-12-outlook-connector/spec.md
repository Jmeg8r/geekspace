---
change: 2026-11-12-outlook-connector
status: draft
track: T3
intent: ./intent.md
accepted_by:
linear: ASTGL-80
skills_in_force: [design:ux-copy, design:accessibility-review]
claude_config_sha: 58442fe
---
# Spec: the Windows build reads Outlook.com calendar and mail over Microsoft Graph

Inputs: intent.md (accepted at 6456832). Code read for this spec, all on main at 850cf6d:
`electron/integrations.mjs`, `electron/main.mjs` (the IPC guard `handle()` and the darwin-only
integration block), `electron/preload.cjs`, `electron/assistantKey.mjs`, `src/lib/integrations.ts`,
`src/lib/macSync.ts`, `src/App.tsx` (the sync loop), `src/components/home/HomeView.tsx` (the
inbox widget), `convex/events.ts`, `convex/schema.ts`, `convex/settings.ts`.

## Flagged concerns

**C1. Narrower read scopes than the intent names.** Source: security-review least privilege,
intent Constraints ("only read scopes").
Graph has `Mail.ReadBasic` (no body, preview or attachments) and `Calendars.ReadBasic` (no body
or attendees). The widget needs only headers, and the mirror needs only title and times, so
`Mail.Read` and `Calendars.Read` grant more than the feature uses. If one of these tokens leaks,
the basic scopes expose message headers instead of every message body. It is **not verified**
that personal Microsoft accounts accept the `*.ReadBasic` scopes.
Recommended: request `Mail.ReadBasic` and `Calendars.ReadBasic`. The plan's first Graph step
proves that a personal account consents to them; if it doesn't, fall back to `Mail.Read` /
`Calendars.Read` and record that under Deviations.
James's resolution: James, 2026-11-12: request the basic scopes; fall back to the full read scopes only if a personal account refuses them, and record it under Deviations.

**C2. Success signal 2 may not be checkable as written.** Source: intent Success signals.
The intent asks to decode the access token's `scp` claim. Access tokens issued for personal
Microsoft accounts may be opaque (not a decodable JWT); this is **unverified**. The token
response's `scope` field lists the granted scopes either way.
Recommended: prove read-only from the token response's granted scopes (checked in a unit test
against the consent result and in the Windows probe), and decode `scp` only if the token turns
out to be a JWT.
James's resolution: James, 2026-11-12: prove read-only from the token response's granted scopes; decode `scp` only if the token is a JWT.

**C3. A new dependency for the sign-in.** Source: the reuse ladder (no new dependency for
what a few lines cover) against security-review (don't hand-roll auth).
The sign-in needs the authorization-code flow with PKCE, a loopback redirect, refresh, and a
token cache. `@azure/msal-node` is Microsoft's maintained library for exactly this and handles
refresh-token rotation and the consumer authority. A hand-rolled version is about 150 lines
of security code that this repo would own.
Recommended: use `@azure/msal-node`, pinned, in the main process only. It runs only on win32
(R2), and Snyk and `npm audit` already gate dependencies in CI.
James's resolution: James, 2026-11-12: use `@azure/msal-node`, pinned, main process, win32 only.

**C4. Reuse the Mac sync settings on Windows instead of adding Outlook ones.** Source: the
reuse ladder, and intent Constraints ("The Mac's behavior and tests stay unchanged").
`macCalendarSync`, `macCalendarNames` and `mailWidget` live in each machine's own local
Convex backend, so on Windows they can mean "Outlook" without touching the Mac. New
`outlook*` fields would duplicate them and add a settings migration.
Recommended: reuse the three fields. Settings labels change by platform ("Sync Outlook
calendar" on Windows), and a comment on the fields says the source depends on the platform.
James's resolution: James, 2026-11-12: reuse the three settings fields and relabel them by platform; no schema change.

**C5. Security policies not applied at the spec stage.** Source: spec skill step 2.
`security-review` and `gstack-cso` review code and diffs; there is no code yet. Their concerns
(token handling, IPC exposure, logging) are written into Security and data below by hand,
which is not the same as running them.
Recommended: run both as the F5 gates on the implementation PRs, as the Day Recorder did
(plan.md, 2026-11-03).
James's resolution: James, 2026-11-12: accepted on this basis; `security-review` and `gstack-cso` are required F5 gates on the implementation PRs.

## Requirements

Each traces to intent.md (section in brackets).

- **R1 Sign-in.** On Windows, Settings offers "Sign in to Outlook.com". It opens the system
  browser at Microsoft's consumer sign-in; after consent, Settings shows the signed-in address.
  [Proposed outcome]
- **R2 Windows only.** The connector's module, its IPC channels and its preload API exist only
  when `process.platform === "win32"`. On macOS none is registered and no Microsoft host is
  contacted. [Constraints: Windows only; Mac unchanged]
- **R3 Read-only scopes.** The only Graph scopes requested are mail read and calendar read
  (basic variants per C1) plus what a refresh token needs. No `ReadWrite` or `Send` scope
  appears in code or in the granted scopes. [Constraints: read-only]
- **R4 Personal accounts only.** The authority is `https://login.microsoftonline.com/consumers`;
  work and school accounts are refused at sign-in. [Constraints; Out of scope]
- **R5 Calendar mirror.** Outlook events in the existing sync window (7 days back, 35 ahead) are
  mirrored into `events` with `source: "outlook"`, on the existing cadence (launch, window
  focus, every 5 minutes, and Settings' Sync now), and the auto-scheduler reflows around them.
  [Proposed outcome]
- **R6 Calendar choice.** Calendars are chosen by name with the existing calendar-names setting
  (empty means all), as on the Mac. [Open question: which calendars]
- **R7 Partial reads never delete.** A calendar counts as complete only if every page of its
  read succeeded. Only complete calendars lose missing mirrors; a failed calendar keeps its
  events. [Constraints]
- **R8 Inbox widget.** The Home inbox widget shows the newest 12 inbox messages: subject,
  sender, received time, read/unread. Opening a message opens it in Outlook on the web. "Make
  task" links the task to the same web address. [Proposed outcome]
- **R9 Failures are loud.** Signed out, consent revoked, token expired, offline and throttled
  each produce a specific message in the widget and in Settings' sync status. None produces an
  empty inbox or an empty calendar. [Proposed outcome; Constraints]
- **R10 Sign-out.** Sign-out deletes the token cache, and no Graph call follows. [Proposed
  outcome]
- **R11 Tokens stay in the main process, encrypted at rest.** [Constraints]
- **R12 Narrow IPC.** The renderer gets named calls returning data or status, never a token or
  a Graph client. [Constraints]
- **R13 Convex validates the new source at the boundary.** [Constraints]

## Design

### Components

| Piece | Where | What |
|---|---|---|
| `outlookAuth.mjs` | `electron/` (new) | MSAL `PublicClientApplication`, consumer authority, interactive sign-in through the system browser with a loopback redirect and PKCE, silent token refresh, sign-out. The token cache is persisted through a cache plugin that encrypts with `safeStorage` (DPAPI on Windows) into `userData/outlook-token-cache.bin`. |
| `outlookGraph.mjs` | `electron/` (new) | Graph reads: list calendars, calendar view per calendar, newest inbox messages. Paging, `Retry-After` on 429, and error mapping. Pure functions take an injected `fetch` and token getter, so tests need no network. |
| win32 IPC block | `electron/main.mjs` | Beside the existing darwin block (its comment already names this as the seam). Registers `gs:outlook:status`, `gs:outlook:signIn`, `gs:outlook:signOut`, and the same `gs:listCalendars`, `gs:fetchCalendarEvents`, `gs:fetchInbox`, `gs:openMessage` channels as the Mac, backed by Graph. |
| preload | `electron/preload.cjs` | A win32 branch exposes `integrations` with the same `Bridge` shape plus `outlook: { status, signIn, signOut }`. `isRunning` and `openApp` resolve to `true`/no-op there, since there is no app to run. |
| renderer | `src/lib/integrations.ts`, `macSync.ts`, `App.tsx`, `HomeView.tsx`, `SettingsModal.tsx` | The sync pass passes a `source` (`"macos"` or `"outlook"`, from the platform). Settings show the Outlook account state on Windows. The widget gains a signed-out state and per-message links from main. |
| Convex | `convex/events.ts`, `convex/schema.ts` | `syncExternal` takes `source: v.union(v.literal("macos"), v.literal("outlook"))` and only touches mirrors of that source. `update` and `remove` name the right app in their read-only errors. Schema comments list both sources; no field changes. |

### Data flow

1. **Sign-in.** Renderer calls `outlook.signIn()`. Main runs MSAL's interactive flow: system
   browser, consent, redirect to `http://localhost:<ephemeral>`, code exchanged with the PKCE
   verifier. The cache is written encrypted. Main returns `{ signedIn: true, username }` only.
2. **Calendar sync.** The existing loop calls `fetchCalendarEvents(start, end, names)`. Main:
   `GET /me/calendars` (this is `present`), then for each wanted calendar
   `GET /me/calendars/{id}/calendarView?startDateTime&endDateTime&$select=id,subject,start,end,isAllDay`,
   following `@odata.nextLink`. A calendar joins `complete` only if every page succeeded.
3. **Window rule.** `calendarView` returns events that **overlap** the window; the Mac fetch and
   `syncExternal`'s delete rule assume events that **start** inside it. Main drops events
   starting outside the window before returning, so the existing rule holds (the bug fixed in
   `2026-10-16-electron-sync` item 8 would otherwise return).
4. **Event mapping.** `externalId` = the Graph occurrence id (unique per occurrence, so no
   `uid:start` composite is needed). Times are requested with `Prefer: outlook.timezone="UTC"`
   and converted to epoch ms. **All-day events** take their date part and become local
   midnight, so they don't shift a day for users west of UTC.
5. **Inbox.** `GET /me/mailFolders/inbox/messages?$top=12&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,webLink`.
   Main returns `{ id, subject, sender, date, read, link }`. `link` is used only if its host is
   `outlook.live.com`; otherwise it's dropped and the message can't be opened.
6. **Open message.** `gs:openMessage` on Windows takes the message id, looks up the `link` from
   the last fetch in main, and opens it with `shell.openExternal`. The renderer never supplies
   a URL.

### UI states (copy per design:ux-copy: what happened, why, what to do)

| State | Inbox widget | Settings |
|---|---|---|
| Signed out | "Sign in to Outlook.com to see your inbox." + **Sign in** | "Not signed in." + **Sign in to Outlook.com** |
| Signing in | "Waiting for you to finish signing in in your browser…" | same + **Cancel** |
| Signed in | messages; "Inbox zero. Legend." only after a successful read of zero | "Signed in as <address>." + **Sign out** |
| Consent revoked / expired | "Outlook needs you to sign in again. Your calendar keeps its last synced events." + **Sign in** | same |
| Offline | "Can't reach Outlook. Check your connection; Geekspace will try again in 5 minutes." | last sync time + same |
| Throttled (429) | "Outlook asked Geekspace to slow down. Trying again in <n> min." | same |
| No safe storage | "Windows can't protect the sign-in on this account, so Geekspace won't store it." | same |

### Accessibility (design:accessibility-review, WCAG 2.1 AA)

- Sign in, Sign out and Cancel are real `<button>` elements, reachable by keyboard, with a
  visible focus ring (2.1.1, 2.4.7).
- Widget state changes (loading, error, signed out) go in a `role="status"` polite region,
  as the Day Recorder's indicator does (4.1.2).
- Error text uses the existing red token; checked against 4.5:1 in both themes (1.4.3).
- The sign-in wait has no time limit inside Geekspace; Cancel ends it (2.2.1).

## Security and data

- **Threats.** (1) Token theft from disk: the cache is DPAPI-encrypted per Windows user;
  without `safeStorage` the app refuses to store tokens (R9 "No safe storage"). (2) Token
  theft from the renderer: tokens never cross IPC (R12); channels go through `handle()`'s
  existing `fromApp` check. (3) Redirect interception: the loopback redirect plus PKCE means a
  stolen code is useless without the verifier. (4) Over-broad access: C1's basic scopes.
  (5) Malicious link from mail data: `webLink` must be an `https://outlook.live.com/` URL and
  is opened by main from its own lookup, never from a renderer string.
- **Client ID** is public and committed (a public client has no secret). No client secret
  exists anywhere.
- **Logging.** Graph failures log the HTTP status, the Graph error `code`, the endpoint path
  without query, and the calendar id. Never the Authorization header, a token, a message
  subject, a sender or an event title. A test asserts this on every error path.
- **Convex boundary.** `syncExternal` validates `source` as a literal union and leaves its
  existing argument validation as is. Event titles from Graph are stored like Mac titles.
- **PII at rest.** Mirrors hold titles and times, as on the Mac. Mail is never stored: the
  widget reads live and keeps nothing beyond main's in-memory link map.
- **Public repo.** Nothing user-specific is committed: no address, tenant or token in fixtures.

## Acceptance checks

| # | Check | Proves |
|---|---|---|
| A1 | Windows: screenshot of the consent screen listing only read permissions, then Settings showing the address. | R1, R3 |
| A2 | Unit test: the requested scopes contain no `ReadWrite`/`Send`; Windows probe: the token response's granted scopes match (C2). | R3 |
| A3 | Unit test: sign-in with a work-account authority response is refused. | R4 |
| A4 | Windows: an event created in Outlook on the web appears in Geekspace's calendar within one sync cycle, and a task scheduled that day doesn't overlap it. Screenshot plus the task's time. | R5 |
| A5 | Unit tests: an event starting before the window is dropped; an all-day event lands on the right local date in UTC-5 and UTC+9. | R5 |
| A6 | Unit test: a second page that fails leaves that calendar out of `complete`, and `syncExternal` keeps its mirrors. | R7 |
| A7 | Convex test: `syncExternal` with `source: "outlook"` never deletes a `macos` mirror, and the reverse. | R5, R13 |
| A8 | Windows: the widget matches the top 12 of Outlook on the web. Side-by-side screenshot. | R8 |
| A9 | Windows: after revoking access at account.microsoft.com, the widget and Settings show the sign-in-again message, and the Convex count of `outlook` events is the same before and after. | R7, R9 |
| A10 | Unit tests: each of the R9 failure kinds maps to its message; none returns an empty list. | R9 |
| A11 | Windows: after sign-out, the cache file is gone and the next sync logs "not signed in" with no Graph request. | R10 |
| A12 | Windows: searching the data folder, logs and the Convex data for the refresh token's first 16 characters finds nothing. | R11 |
| A13 | Unit test: every error log line from `outlookGraph.mjs` contains no token, subject, sender or title (fixture strings). | Logging |
| A14 | Test: on darwin, the preload exposes no `outlook` API and main registers no `gs:outlook:*` channel; `npm run verify` passes on the Mac. | R2 |
| A15 | Test: `gs:openMessage` on win32 refuses an id with no stored link, and a stored link off `outlook.live.com`. | Security (5) |

## Open questions

- **Does the packaged Windows build install and run on the Alienware?** (from the intent).
  Answered by the plan's first step, with James at the machine. If it fails, the work moves to
  the Windows intent and this one waits.
- **App registration.** James registers the public-client app (personal accounts only,
  redirect `http://localhost`) under his Microsoft account, since only he can sign in to the
  portal. Unverified: whether a personal account can still register apps without a
  Microsoft Entra directory. James finds out when registering.
- **Basic scopes for personal accounts** (C1). Answered by the plan's first Graph step.
- **Opaque or JWT access tokens** (C2). Answered by the same step.
- ~~Which calendars sync~~: answered by R6 (the existing setting, from `macSync.ts`).
- ~~How often Windows syncs~~: answered by R5 (the existing loop in `App.tsx`: launch, focus,
  every 5 minutes; window from `macSync.ts`).
