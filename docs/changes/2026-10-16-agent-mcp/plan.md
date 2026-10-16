---
change: 2026-10-16-agent-mcp
status: accepted
track: T2
intent: ./intent.md
linear: pending
---
# Plan: lock the Claude lane to the workspace tools; make every agent failure visible

## Files that change

- `electron/architect.mjs`:
  - `architectOptions({ resumeId })` is exported and pure: it builds the SDK options with
    `tools: []`, `settingSources: []`, `strictMcpConfig: true`,
    `permissionMode: "dontAsk"`, the 14 `allowedTools`, and the MCP server env from
    `mcpEnv()`.
  - `bypassPermissions` and `allowDangerouslySkipPermissions` are removed.
  - The result-error frame becomes `{ type: "error", text }`.
- `electron/agentShared.mjs` (new, with `.d.mts`), helpers for both lanes:
  - `mcpEnv(env)`: CONVEX_URL (default `http://127.0.0.1:3210`), PATH, HOME,
    ELECTRON_RUN_AS_NODE=1, and on Windows the system variables Node needs to start
    (SystemRoot, TEMP/TMP, USERPROFILE).
  - `trimHistory(history, maxChars)`: keeps the system message, drops the oldest turns
    whole (a turn starts at a user message), and returns history under the budget. A
    single turn larger than the budget is kept rather than split.
  - `parseToolArgs(raw)`: returns `{ ok: true, args }` or `{ ok: false, error }`.
  - `errorFrame(text)`: builds the shared error frame.
- `electron/architectLocal.mjs`:
  - uses `mcpEnv`;
  - calls `trimHistory` before each round, with a budget from `NUM_CTX`;
  - sends the model a tool error on malformed arguments, without calling the tool;
  - sends errors as `{ type: "error", text }`.
- `electron/main.mjs`: `gs:agent:chat` refuses a turn while one is running.
- `src/lib/agentBridge.ts`: `AgentEvent` narrowed to the frame types actually sent
  (`token`, `tool`, `error`), all carrying `text`.
- `src/components/agent/AgentPanel.tsx`: error frames are shown as `⚠️ <text>`.
- Tests:
  - `tests/agentShared.test.ts`: env allowlist, trimming, argument parsing, frame shape.
  - `tests/architectOptions.test.ts`: the lockdown options, and that the built env
    carries no extra keys.

## Order of work

1. Tests → fail for the stated reasons; commit test-only.
2. `agentShared` helpers → helper tests pass.
3. Claude-lane options → lockdown tests pass.
4. Local lane: trimming, argument errors, frames, env.
5. One turn at a time in main; the panel renders errors.
6. Live:
   - `init` probe with the new options (free);
   - a local-lane turn on the worktree backend that creates a row;
   - the round limit forced via a tiny `MAX_TOOL_ROUNDS` override env, to see the
     ⚠️ line in the panel;
   - the optional Claude-lane turn, if James agrees.
7. Verify and build.

## Risks

- **`dontAsk` might also deny the MCP tools** if `allowedTools` names don't match
  exactly. The `init` probe lists the tools, and the optional real turn proves calls go
  through. Without that turn this stays unproven, and the PR will say so.
- **Trimming loses older context in very long chats.** That's intended: the alternative
  is Ollama dropping the system prompt silently.

## Deviations

- **Test-only commit `49d5013`:** both new test files failed for the stated reasons (the
  `agentShared` module was missing; `architectOptions` didn't exist).
- **Added:** `architect.d.mts`, so the lockdown test typechecks against the SDK's own
  `Options` type. The local lane's round limit reads `GEEKSPACE_LOCAL_MAX_TOOL_ROUNDS`
  (default 12), alongside the existing `GEEKSPACE_LOCAL_NUM_CTX` setting, so the error
  path could be forced live.
- **Turn gate:** `oneTurnAtATime` lives in `agentShared` so it can be unit-tested; main
  wraps both lanes with it.
- **Suite 175/175; verify and typecheck pass.**
- **Live, worktree backend:**
  - SDK `init` with the new options, aborted before any model call: 0 built-in tools,
    14 `mcp__geekspace__*` tools, only `geekspace` connected, permission mode `dontAsk`,
    0 plugins. Before the change: 32 built-ins, about 30 MCP servers, 8 plugins,
    `bypassPermissions`.
  - One real Claude-lane turn (approved by James), 4.9 s: it called `query_schema`,
    listed Projects, Tasks and Sprints, and when asked to run `echo hello` said it has no
    shell. No shell tool exists for it now.
  - Local lane (`qwen3-coder-next:q8_0`), 55 s: the first `create_row` returned an error
    and the model retried. The backend holds exactly one new row, "Probe 6: local lane
    row".
  - Panel with the round limit forced to 1: "⚠️ Stopped after 1 tool rounds without a
    final answer." appeared in the conversation. Before, error frames were dropped.
