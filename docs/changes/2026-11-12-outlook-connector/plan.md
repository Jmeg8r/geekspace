---
change: 2026-11-12-outlook-connector
status: accepted
track: T3
intent: ./intent.md
spec: ./spec.md
linear: ASTGL-80
---
# Plan: Outlook connector for the Windows build

## Context

The Windows build has no calendar and no mail, because Geekspace reads both from Apple's apps.
The accepted intent (6456832) and spec (d8c9418) add a Windows-only, read-only Outlook.com
connector over Microsoft Graph. Outlook events feed the existing calendar mirror and the
auto-scheduler, and the newest inbox messages feed the Home widget.

Spec R1–R13 and A1–A15 are the contract, with James's resolutions to C1–C5. The plan leads
with the things most likely to change the design, all unverified today:
- whether the packaged Windows build runs on the Alienware;
- whether a personal Microsoft account can still register an app;
- whether personal accounts accept `Mail.ReadBasic` and `Calendars.ReadBasic` (C1);
- whether their access tokens are opaque (C2).

No connector code is written until those are answered.

## Order of work

Every PR follows the same loop:
- branch from `origin/main`
- write the failing test first
- `npm run verify`
- open a forge PR
- post a Codex comment (verbatim, with PASS/FAIL), one run at a time in the foreground
- James merges

### Step 0 — Gates with James, no code

1. **Windows build runs.** On the Alienware, build or copy the NSIS installer
   (`npm run package:win`), install it, and launch it.
   → verify: Geekspace opens and shows the workspace, and a page created, closed and
   reopened is still there (the local backend stores and serves data). Screenshot.
   **If it fails:** stop. That work belongs to the Windows intent, and this plan waits.
   Where the installer is built (on the Alienware, or cross-built on the Mac) is recorded
   in Deviations.
2. **App registration.** James registers a public-client app: personal Microsoft accounts
   only, mobile and desktop platform, redirect `http://localhost`, no client secret.
   → verify: the portal shows the client ID and the supported account type
   "Personal Microsoft accounts only". The client ID goes into PR 1.
   **If registration needs a Microsoft Entra directory** that James doesn't have: stop and
   decide with James (create a free directory, or another route) before PR 1.

### PR 1 — Probe: answer C1 and C2 on a real account (`feat/outlook-probe`)

**Build:**
- Add `@azure/msal-node` (pinned exact) to `dependencies` (C3).
- `scripts/probe-outlook.mjs`, run by hand on the Alienware. It signs in through the system
  browser, then prints shapes and counts only, never content.

**What the probe answers**, written to
`docs/changes/2026-11-12-outlook-connector/probe-findings.md`:
1. Do personal accounts consent to `Mail.ReadBasic` and `Calendars.ReadBasic`? Evidence:
   the token response's `scope` field.
2. Is the access token a JWT or opaque? Evidence: whether it splits into three base64url
   parts; if it's a JWT, the decoded `scp`.
3. Does `calendarView` with `Prefer: outlook.timezone="UTC"` give all-day events as UTC
   midnights? Evidence: one all-day test event's `start` and `end` strings.
4. Does `Mail.ReadBasic` return `webLink`, and is its host `outlook.live.com`? Evidence:
   the field's presence and host only.
5. Paging: does a calendar with more than the page size return `@odata.nextLink`?

→ verify: `probe-findings.md` answers all five with evidence; `snyk test` and `npm audit`
show no new high or critical finding from `@azure/msal-node`.

**Gate:** if the basic scopes are refused, switch R3 to `Mail.Read` / `Calendars.Read` and
record it under Deviations (C1). If `webLink` is missing under `Mail.ReadBasic`, record it
and decide with James before PR 4.

### PR 2 — Convex: a source on the calendar mirror (`feat/outlook-mirror-source`)

**Files:** `convex/events.ts`, `convex/schema.ts` (comments only), `src/lib/macSync.ts`.
- `syncExternal` takes `source: v.union(v.literal("macos"), v.literal("outlook"))` and
  reads, inserts and deletes only mirrors of that source (R13).
- `update` and `remove` name the right app in their read-only errors ("edit it in Outlook"
  for an `outlook` mirror).
- The Mac caller passes `"macos"`. Mac behavior is otherwise unchanged.

**Tests:** A7 (a sync of one source never deletes the other's mirrors), the read-only errors
by source, and the existing `syncExternal` tests unchanged.
→ verify: `npm run verify`; the Mac dev app's Sync now reports the same event count as
before the change.

### PR 3 — Sign-in and the token cache, Windows only (`feat/outlook-auth`)

**Files:**
- `electron/outlookAuth.mjs` (new): an MSAL `PublicClientApplication` with the
  `consumers` authority. It runs interactive sign-in through the system browser with a
  loopback redirect and PKCE, silent refresh, and sign-out. Its cache plugin encrypts with
  `safeStorage` into `userData/outlook-token-cache.bin` and refuses to store anything when
  `safeStorage.isEncryptionAvailable()` is false.
- `electron/main.mjs`: a `win32` block next to the darwin one, with
  `gs:outlook:status|signIn|signOut` through `handle()`.
- `electron/preload.cjs`: a `win32` branch exposing `outlook: { status, signIn, signOut }`
  only.

**Tests:**
- A2: the requested scopes contain no `ReadWrite` or `Send`.
- A3: a work-account result is refused.
- A14: darwin registers no `gs:outlook:*` channel and exposes no `outlook` API.
- The cache plugin never writes plaintext, and refuses without safe storage.
- Sign-out deletes the cache file.

→ verify: `npm run verify`; on the Alienware dev build, sign in, see the address, sign out,
and the cache file is gone. Screenshots.

### PR 4 — Graph reads (`feat/outlook-graph`)

**Files:**
- `electron/outlookGraph.mjs` (new): pure functions with an injected `fetch` and token
  getter.
  - List calendars (this is `present`).
  - `calendarView` per wanted calendar, following `@odata.nextLink`. A calendar is complete
    only if every page succeeded.
  - Drop events that start outside the window (spec Design, flow 3).
  - All-day events become local midnight from their date part.
  - The inbox: top 12 by received time, keeping `webLink` only on `outlook.live.com`.
  - Honor `Retry-After` on 429; map each failure to its R9 kind.
- `electron/main.mjs`: the `win32` block also registers `gs:listCalendars`,
  `gs:fetchCalendarEvents`, `gs:fetchInbox` and `gs:openMessage`, backed by Graph.
  `openMessage` opens only a link stored from main's last fetch.
- `electron/preload.cjs`: the `win32` branch exposes the same `Bridge` methods as the Mac;
  `isRunning` resolves to `true` and `openApp` does nothing.

**Tests:**
- A5: the window rule, plus all-day dates in UTC-5 and UTC+9.
- A6: a failed second page leaves that calendar out of `complete`.
- A10: each failure kind maps to its message, and none returns an empty list.
- A13: error logs contain no token, subject, sender or title (fixture strings).
- A15: `openMessage` refuses an unknown id and a link off `outlook.live.com`.

→ verify: `npm run verify`; on the Alienware dev build, Sync now mirrors the Outlook
calendars and the inbox call returns 12 messages (counts in the log, no content).

### PR 5 — Renderer: Settings, sync and the inbox widget (`feat/outlook-ui`)

**Files:** `src/lib/integrations.ts`, `src/lib/macSync.ts`, `src/App.tsx`,
`src/components/settings/SettingsModal.tsx`, `src/components/home/HomeView.tsx`.
- The sync pass passes `source` by platform. The loop and window are unchanged (R5).
- Settings on Windows: the account state, Sign in, Cancel and Sign out, with labels
  relabelled per C4. A comment on the reused setting fields says the source depends on the
  platform.
- The widget: the spec's UI states table, verbatim copy. "Inbox zero. Legend." appears only
  after a successful read of zero. "Make task" uses the message's web link on Windows.
- Accessibility: real buttons, visible focus, and a `role="status"` polite region for state
  changes.

**Tests:** each widget state renders its copy; signed out never renders "Inbox zero"; the
status region announces state changes; Mac Settings and the Mac widget render as before.
→ verify: `npm run verify`; screenshots of every UI state on the Alienware, in light and
dark themes.

### PR 6 — Windows proof and security gates (`docs/outlook-proof`)

On a packaged build on the Alienware, run A1, A4, A8, A9, A11 and A12, and record the
evidence in `docs/changes/2026-11-12-outlook-connector/proof.md` (synthetic test events
and messages only, no real mail in the repo).

The F5 gates (C5): `security-review` and `gstack-cso` on the merged range of PRs 2–5.
Findings are fixed in follow-up PRs or recorded with James's decision.

→ verify: `proof.md` has evidence for every Windows check, and both gate results are
recorded with their run ids.

## Files that change (summary)

- **New:** `electron/outlookAuth.mjs`, `electron/outlookGraph.mjs` (plus `.d.mts`),
  `scripts/probe-outlook.mjs`, tests for each, `probe-findings.md`, `proof.md`.
- **Modified:** `convex/events.ts`, `convex/schema.ts` (comments), `electron/main.mjs`,
  `electron/preload.cjs`, `src/lib/integrations.ts`, `src/lib/macSync.ts`, `src/App.tsx`,
  `src/components/settings/SettingsModal.tsx`, `src/components/home/HomeView.tsx`,
  `package.json`, `package-lock.json`.

## Risks

- **The Windows build doesn't run.** Step 0 stops the plan before any code.
- **App registration needs an Entra directory.** Step 0 stops and asks James.
- **Basic scopes refused, or `webLink` missing under them.** PR 1 finds out; the fallback is
  recorded (C1).
- **CI is Ubuntu.** It runs the Graph and auth logic only through injected fakes. Every
  Windows behavior is proven by hand on the Alienware, with screenshots in the PR.
- **Cross-platform code paths** (CLAUDE.md review standard): every win32 block has a darwin
  test that it is absent (A14), so the Mac can't regress silently.
- **A real mailbox in a public repo.** The probe and proof print shapes and counts only;
  fixtures are synthetic; the pre-commit secret scan runs on every commit.
- **Scope.** Six PRs. If any fix-review loop passes 3–4 rounds, stop and reassess (lesson
  L42).

## Proof (becomes VERIFY)

- Per PR: `npm run verify`, `npm run build`, and `snyk test` when dependencies change (PR 1).
- Unit and Convex tests: A2, A3, A5, A6, A7, A10, A13, A14, A15.
- On the Alienware: A1, A4, A8, A9, A11, A12, in `proof.md` (PR 6).
- Mac regression: `npm run verify` on the Mac and the Mac dev app's Sync now unchanged
  (PR 2, PR 5).
- F5: `security-review` and `gstack-cso` results recorded (PR 6).

## Options not taken

- **An embedded Electron sign-in window:** the renderer process would host Microsoft's
  credential page. The system browser keeps credentials out of the app (RFC 8252).
- **Device-code flow:** no redirect needed, but a worse sign-in for a desktop app with a
  browser.
- **Hand-rolled OAuth:** declined in C3.
- **Graph on the Mac too:** every Outlook event would arrive twice (intent).
- **New `outlook*` settings fields:** declined in C4.
- **One large PR:** too big for the review gate and Codex to examine meaningfully.

## Deviations
<!-- appended during implementation -->
