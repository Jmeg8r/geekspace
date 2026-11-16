---
change: 2026-11-16-mcp-meetings-search
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: meeting and search tools for geekspace-mcp

## Decision: wrap the existing queries, change no Convex code

`api.meetings.list`, `api.meetings.get` and `api.search.searchAll` already return what the
tools need. The MCP layer only shapes the output for agents (ISO dates, no storage ids or
signed audio URLs). Keeping Convex untouched means the app's own callers are unaffected.

## Files that change

- `mcp/index.mjs`
  - Add `list_meetings`, `get_meeting`, `search_workspace` to `READ_ONLY_TOOLS`.
  - `list_meetings({ limit? })` → `meetings.list`, slice to limit (default 20, max 200).
  - `get_meeting({ meetingId, includeTranscript? = true })` → `meetings.get`; throw
    "Meeting not found" on null; drop `audioUrl`, `audioStorageId`, `generatedContent`.
  - `search_workspace({ query })` → `search.searchAll({ q })`; zod `min(1)` on query.
  - Mention the new tools in the server `instructions` string.
- `tests/mcpReadTools.test.ts` (new): mock Convex backend that answers `/api/query` by
  function path; asserts shaping, the not-found error, the empty-query rejection, and
  that none of the three needs `query_schema` or causes a mutation.

## Verify

`[add tools] → verify: npm run verify green`
`[live probe] → verify: run the server against the local backend (127.0.0.1:3210) and call
all three tools from an MCP client; record output shape (not content) in the PR.`

## Impact found during EXECUTE

- ARCHITECT's Claude lane (`electron/architect.mjs`) uses an explicit `ARCHITECT_TOOLS`
  allowlist, so it does not gain the new tools.
- ARCHITECT's local Ollama lane (`electron/architectLocal.mjs` `loadTools`) offers the model
  every tool the server lists, so it gains these three read-only tools. Accepted: the data
  stays on the machine (local model), and the tools cannot mutate.

## Proof (2026-11-16)

- `npm run verify`: 70 files / 920 tests green before the lint fix; changed files lint clean after.
- The new suite fails 5/7 against the pre-change server (the 2 that pass are the
  no-mutation and empty-query guards, which are vacuous when the tool doesn't exist).
- Live probe against the local backend (127.0.0.1:3210): 17 tools registered including the
  three new ones; `list_meetings` and `get_meeting` return the documented keys only, no
  audio fields; `search_workspace` returns all five result groups; a malformed id is an error.
- `snyk test --severity-threshold=high`: no vulnerable paths.

## Deviations

_None._
