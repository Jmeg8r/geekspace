---
change: 2026-10-16-mail-widget
status: draft
track: T1
author: claude
accepted_by: pending
linear: pending
source: conversation
---
# Intent: the Home Mail widget shows the newest inbox messages on a huge inbox, or says why it can't

## Problem

The Home "Inbox" widget reads Mail.app over JXA (`fetchInbox` in `electron/integrations.mjs`).
On James's Mac Studio the unified inbox holds **263,971 messages**, and the widget can't work:

1. **The current script fails every time.** Bulk-reading five properties of every inbox
   message dies with `execution error … (-1741)` after ~10 s (PR #58, Deviations).
2. **No AppleScript shape is fast enough.** Measured at that size, counts and timings only:

   | Path | Result |
   |---|---|
   | bulk `dateReceived()` alone | works, 8.7 s, and still needs the other four properties |
   | per-index `msgs[i].subject()` | timed out (`-1712`) |
   | `whose({dateReceived > now-2d})`, also 7 d | timed out at 120 s |
   | per-account INBOX counts | timed out |
   | AppleScript range `messages 1 thru 12 of inbox` (2026-10-16) | works, but **68.8 s and 68.3 s**: no warm-cache gain |

   The cost is Mail assembling the unified inbox, not the scripting bridge.
3. **Spotlight doesn't help.** `mdfind` for Mail messages (three query shapes, scoped and
   global) returns 0 on macOS 27. The control (`public.plain-text`) returns 76,075, so
   Spotlight works but Mail no longer publishes messages to it.
4. **One failure is silent.** If reading `Mail.inbox.messages` throws, the script returns
   `"[]"` and the widget shows "Inbox zero. Legend." That's a false empty inbox.

## What James wants

- The widget shows the newest ~12 inbox messages (subject, sender, received time,
  read/unread, deep link) reliably on very large inboxes.
- When it can't, the widget shows a visible message saying why and what to do. It never
  shows a fake empty inbox.

## Chosen source: Mail's Envelope Index, read-only

James chose to probe the no-permission paths first (both failed, above), then approved a
timing probe of Mail's local SQLite index from a shell that already has Full Disk Access.
Measured 2026-10-16, counts and timings only, no content printed:

- Store `~/Library/Mail/V10/MailData/Envelope Index`, about 2.2 GB, opened `?mode=ro`
  (reads the WAL; the newest row was 10 minutes old).
- Inbox = the 6 mailboxes whose URL ends in `/INBOX`. Their `total_count` sums to
  **264,091**, which matches Mail's 263,971 within 0.05%.
- Gmail inbox messages live in All Mail and reach INBOX through the `labels` table.
  Direct rows (129,005) plus label rows (135,086) = 264,091 exactly, so both paths are needed.
- "Newest 12, not deleted": **55 ms** on all three runs, using index
  `messages_deleted_date_received_index`. All 12 rows had a subject, a sender and a
  `message_id_header`.

### The cost James is accepting

- **Full Disk Access for Geekspace.** macOS has no narrower grant for `~/Library/Mail`,
  and no entitlement grants it either: it's a user toggle in System Settings. It lets
  Geekspace read anything the user can. This is James's install-time decision; the code
  only detects a missing grant and says so.
- **Dev works, packaged doesn't, until granted.** `npm run dev` inherits the terminal's
  access; the packaged app does not. The missing-grant message must be specific enough to
  act on.
- **Undocumented schema.** Apple can change it with any macOS release (`V10` today). The
  widget checks for the tables and columns it uses and fails loudly if any are missing.

## Success looks like

- On James's Mac Studio, the packaged app with Full Disk Access shows the 12 newest inbox
  messages in well under a second, unread dots correct, and clicking one opens it in Mail.
- Without Full Disk Access, the widget shows how to grant it.
- No Mail store, an unknown schema, no inbox mailboxes found, or a query error each
  produce their own visible message. "Inbox zero" appears only when the inbox mailboxes
  exist and none of their messages qualify.
- No code path, test or log prints message content outside the widget itself.

## Out of scope

- Provider APIs (Gmail, and Outlook in Phase B). This change makes them unnecessary for
  the widget; they stay available for later features.
- Opening or searching mail bodies; other mailboxes; unread counts elsewhere in the app.
- Windows. The Mail widget is macOS-only, as today.

## Open question for James

- **Mail-not-running gate.** The widget currently refuses to load when Mail isn't
  running. The index is readable without Mail, just possibly stale. Proposed: drop the
  gate and always read the index. Alternative: keep the "Open Mail" prompt.
