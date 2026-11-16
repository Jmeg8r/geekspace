---
change: 2026-11-16-mcp-meetings-search
status: accepted
track: T1
risk: low
risk_reason: three read-only tools on the local stdio MCP server; no mutation path, no new transport, no schema change
author: claude
accepted_by: claude
linear: pending
---
# Intent: let MCP clients read meetings and search the workspace

## Problem

`geekspace-mcp` (`mcp/index.mjs`) exposes pages, database rows, tasks and the schedule, but
not the two things an agent most needs when drafting PRDs or evals from real work: the
AI meeting notes (`convex/meetings.ts`) and cross-workspace search (`convex/search.ts`).
The backend queries already exist; the MCP server just doesn't wrap them.

The motivating use: Claude Code with both `geekspace` and ChatPRD's hosted MCP connected,
pulling meeting decisions and action items out of Geekspace and writing specs into ChatPRD.

## What "done" looks like

- `list_meetings` — recent meetings, newest first, with title, type, status, start date,
  duration, notes page id. Optional limit.
- `get_meeting` — one meeting's summary, key points, decisions, action items and (by
  default) transcript. No audio URL or storage ids leave the server.
- `search_workspace` — one query across pages, database rows, docs, Day Recorder
  transcripts and screenshot OCR, returning what `search.searchAll` returns.
- All three are read-only: callable without `query_schema`, and they never mutate.
- Tests prove each tool's shape against a mock Convex backend.

## Out of scope

- A remote/HTTP transport for the server (ChatPRD reaching Geekspace directly).
- Email: the Outlook connector isn't built yet (`docs/changes/2026-11-12-outlook-connector/`).
- Any filtering of work vs personal meetings; the caller decides what leaves the machine.
