---
change: 2026-10-16-agent-mcp
status: accepted
track: T2
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: ARCHITECT can touch the workspace and nothing else, and says when it fails

## Problem

From the 2026-10-11 reassessment, re-read against `main` at `9ca2f06`.

1. **The Claude lane is not locked down.** `electron/architect.mjs` runs the Agent SDK with
   `permissionMode: "bypassPermissions"` and an `allowedTools` list. In SDK 0.3.172
   `allowedTools` only *auto-approves* the tools it lists; it does not restrict anything
   (the type docs say so, and point to `tools` for that). With `settingSources` omitted,
   the SDK also loads all of James's filesystem settings: user plugins, hooks and MCP
   servers. Measured from the SDK's `init` message, aborted before any model call:
   - **32 built-in tools**, including Bash, Edit and Write, with the repo as the working
     directory;
   - **about 30 MCP servers**: Gmail, Slack, Google Drive, Google Calendar, Supabase,
     Vercel, Linear, gbrain, personal-context and more;
   - 8 plugins and 235 slash commands;
   - all of it with permission checks bypassed.

   The system prompt says "you have no shell or file access". Nothing enforces it. Text
   inside a page, row or imported document could steer the agent into running commands
   or sending mail.
2. **Failures are invisible.** Both lanes send `error` frames: the Claude lane's
   "Agent stopped: …" and the local lane's "Stopped after 12 tool rounds…". The agent
   panel ignores every frame except `token` and `tool`, so a failed turn just ends.
   The two lanes also disagree on the frame shape: `message` versus `text`.
3. **The local lane forgets its rules in long chats.** Its history is never trimmed. Past
   `num_ctx` (32k tokens), Ollama silently drops the oldest messages, starting with the
   system prompt, so the model loses "query_schema first" and "never claim success
   without a tool result".
4. **Malformed tool arguments are silently replaced.** When a local model returns
   arguments that aren't JSON, the lane calls the tool with `{}` instead of telling the
   model.
5. **Secrets reach the MCP subprocess.** Both lanes start `geekspace-mcp` with all of
   `process.env`, which includes the keys the main process loads from `.env.local`. The
   server needs only `CONVEX_URL`.
6. **Two turns can run at once.** The IPC handler doesn't refuse a second message while a
   turn is running, so both lanes could share or interleave one conversation. Only the
   renderer's button state prevents this today.

## Proposed outcome

- **Claude lane:**
  - `tools: []` (no built-in tools);
  - `settingSources: []` (none of James's settings, plugins, hooks or CLAUDE.md);
  - `strictMcpConfig: true` (only the `geekspace` server);
  - `permissionMode: "dontAsk"` (anything not pre-approved is denied);
  - `allowedTools` lists the 14 workspace tools.

  The SDK's `init` message must then report 0 built-in tools and only `geekspace`.
- **One frame shape:** `{ type: "error", text }`. The panel shows error frames as a
  visible ⚠️ line in the conversation.
- **Local lane history:**
  - The system prompt is always kept.
  - Older turns are dropped whole, at user-message boundaries, so a tool result is never
    separated from its call.
  - The kept history stays under a character budget tied to `num_ctx`.
- **Malformed tool arguments** become a tool error the model can see and correct.
- **The MCP subprocess** gets `CONVEX_URL` plus the minimal process variables (PATH,
  HOME, ELECTRON_RUN_AS_NODE), nothing else.
- **A second message** sent while a turn is running is refused with a clear error.

## Already done, out of scope

- **Atomic `update_row`:** already one `rows.updateProperties` mutation (PR #52).
- **Agent edits overwritten by an open editor:** the editor's incoming-content conflict
  handling (PR #51) covers agent writes.
- **The MCP server's own guard:** writes already require a successful `query_schema`
  first.

## Affected users and systems

- ARCHITECT in the desktop app, both lanes. No schema change.
- The `geekspace-mcp` server is unchanged, so other clients (Claude Code, Claude Desktop)
  are unaffected.
- geekspace is public on GitHub, so every commit here is published when it syncs.

## Constraints

- Probes must not spend the Agent SDK credit pool unless James agrees. Lockdown is proven
  from the `init` message, which arrives before any model call; the probe aborts there.
  One real Claude-lane turn is optional and needs James's OK.
- Local-lane proofs use the worktree backend and a local Ollama model.

## Success signals

- Failing-first tests:
  - the Claude lane's options have `tools: []`, `settingSources: []`,
    `strictMcpConfig: true`, `permissionMode: "dontAsk"`, no `bypassPermissions`, and an
    MCP env with no extra variables;
  - history trimming keeps the system prompt, never splits a tool call from its result,
    and stays under budget;
  - malformed arguments produce a tool error, not a call with `{}`;
  - the lanes produce the same error frame shape;
  - a concurrent turn is refused.
- Live:
  - `init` with the new options shows 0 built-ins and only `geekspace` (before: 32 and
    about 30);
  - a local-lane turn creates a row through the tools;
  - forcing the round limit shows the ⚠️ error in the panel.
- `npm run verify` and `npm run build` pass.

## Open questions

1. Live Claude-lane turn: approved by James (2026-10-16), one short turn.
