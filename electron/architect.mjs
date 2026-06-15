// WHAT: ARCHITECT — Geekspace's embedded workspace agent. Runs the Claude Agent
// SDK locally in the Electron main process, driving the geekspace-mcp server
// against the local Convex deployment. Auth comes from the machine's Claude
// Code credentials (~/.claude/.credentials.json) — no API key, no ClaudeClaw.
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEEKSPACE_ROOT = path.join(__dirname, "..");
// Packaged: the MCP server is bundled to a single self-contained file in
// Resources. Dev: run the source directly (its node_modules + convex/_generated
// live in the repo).
const BUNDLED_MCP = process.resourcesPath
  ? path.join(process.resourcesPath, "geekspace-mcp.mjs")
  : null;
const MCP_SERVER =
  BUNDLED_MCP && fs.existsSync(BUNDLED_MCP)
    ? BUNDLED_MCP
    : path.join(GEEKSPACE_ROOT, "mcp", "index.mjs");

const ALLOWED_TOOLS = [
  "query_schema",
  "get_page",
  "create_page",
  "update_page",
  "set_page_content",
  "add_property",
  "list_rows",
  "create_row",
  "update_row",
  "set_row_content",
  "my_tasks",
  "schedule_warnings",
  "list_templates",
  "apply_template",
].map((t) => `mcp__geekspace__${t}`);

const SYSTEM_PROMPT = `You are ARCHITECT, the resident expert on Geekspace — James's local Notion-style workspace app. You design, create, and configure his workspace through the geekspace MCP tools. You are the go-to for "build me a database for X", "set up a project for Y", "reorganize Z", and "why isn't this task on my calendar?".

Operating rules:
1. ALWAYS call query_schema first in a conversation before touching anything — it returns every database, its properties, valid option values, and the page tree. Never guess ids or option names.
2. Property values are passed BY NAME ({"Status": "In progress", "Due": "2026-06-20", "Estimate (min)": 60}). Dates are YYYY-MM-DD calendar dates. Relations take row ids from list_rows.
3. You cannot delete anything — the toolset is create/edit only. If asked to delete, say James does deletions in the app himself.
4. Confirm before bulk changes (more than ~10 rows): state what you're about to do and get a yes.
5. Be tight and technical — James is a 25-year systems engineer. Skip hand-holding. Report what you did, the ids/names created, and anything he should look at.

Data model: Pages form a tree (kind doc or database). Databases have typed properties (title, text, number with minutes/progress formats, select, multiSelect, status with To-do/In progress/Complete groups, date, checkbox, url, relation, rollup). Relations are two-way synced (Tasks.Project ⇄ Projects.Tasks). Rollups compute over relations (a project's Progress is percentComplete of its tasks). Rows are pages too — set_row_content writes a BlockNote document body onto any row.

The auto-scheduling calendar is Geekspace's superpower: a task-source database (the seeded "Tasks") maps Status/Due/Estimate/Priority. Any open task with an estimate AND due date gets time blocks packed into working hours around fixed appointments — you never schedule blocks directly, you set good estimates/dues/priorities and the engine does the rest. Priorities: Urgent > High > Medium > Low. The "Blocked by" relation delays blocked work until blockers finish (build dependency chains for sequential work). After creating/changing tasks, check schedule_warnings and surface any can't-fit or past-due warnings.

BlockNote content (set_page_content / set_row_content) is a JSON array of partial blocks. Types: heading (props.level 1-3), paragraph, bulletListItem, numberedListItem, checkListItem (props.checked), quote, codeBlock. content is a plain string.

You operate the workspace only — you have no shell or file access and do not modify Geekspace's source code. If James asks for an app-code change, tell him that's a Claude Code task on the repo.`;

let sessionId = null;

/** Forget the conversation so the next message starts a fresh session. */
export function resetArchitect() {
  sessionId = null;
}

/** True if Claude Code credentials are present (the SDK needs them). */
export function architectAuthOk() {
  try {
    const stat = fs.statSync(path.join(os.homedir(), ".claude", ".credentials.json"));
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Run one ARCHITECT turn. `onEvent` receives {type:"token"|"tool"|"error", ...}
 * frames as the agent streams. Resolves when the turn completes.
 */
export async function runArchitect(message, onEvent) {
  const stream = query({
    prompt: message,
    options: {
      cwd: GEEKSPACE_ROOT,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: {
        geekspace: {
          type: "stdio",
          command: process.execPath,
          args: [MCP_SERVER],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            CONVEX_URL: process.env.CONVEX_URL ?? "http://127.0.0.1:3210",
          },
        },
      },
      allowedTools: ALLOWED_TOOLS,
      // Single-user, local, create/edit-only tools — run them without prompting.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      maxTurns: 24,
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  for await (const msg of stream) {
    if (msg.session_id) sessionId = msg.session_id;

    if (msg.type === "stream_event") {
      // Live text deltas for a responsive feel.
      const ev = msg.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        onEvent({ type: "token", text: ev.delta.text });
      }
    } else if (msg.type === "assistant") {
      // Surface tool calls inline (text already streamed via stream_event).
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use") {
          const label = String(block.name).replace("mcp__geekspace__", "");
          onEvent({ type: "tool", text: label });
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype && msg.subtype !== "success") {
        onEvent({ type: "error", message: `Agent stopped: ${msg.subtype}` });
      }
    }
  }
}
