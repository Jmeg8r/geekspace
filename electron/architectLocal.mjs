// WHAT: ARCHITECT's local lane — the same workspace agent driven by a local
// Ollama model instead of the Claude Agent SDK.
// WHY: From 2026-06-15 Agent SDK calls bill against a separate API-rate credit
// pool (see astgl.com/p/anthropic-agent-sdk-billing-playbook). Routine
// workspace operations don't need frontier judgment, so the default lane runs
// free on local hardware; the Claude lane stays for complex design work.
// The MCP server is the contract — both lanes drive the identical 14 tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Packaged: bundled MCP server in Resources; dev: the source in the repo.
const BUNDLED_MCP = process.resourcesPath
  ? path.join(process.resourcesPath, "geekspace-mcp.mjs")
  : null;
const MCP_SERVER =
  BUNDLED_MCP && fs.existsSync(BUNDLED_MCP)
    ? BUNDLED_MCP
    : path.join(__dirname, "..", "mcp", "index.mjs");

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

// Tool-calling reliability varies wildly across local models (gemma narrates
// and fences JSON). Preference order favors agentic/coder models; overridable
// via GEEKSPACE_LOCAL_MODEL in .env.local.
const MODEL_PREFERENCE = ["qwen3-coder", "gpt-oss", "qwen3", "llama3.3", "mistral"];
const EXCLUDE = /embed|whisper|astgl-voice/i;

const MAX_TOOL_ROUNDS = 12;
// query_schema alone is ~14k chars; truncating below that made the model
// miscount databases (it faithfully counted what it could see). Modern local
// models have the context for this — just make sure num_ctx matches.
const MAX_TOOL_RESULT_CHARS = 24000;
const NUM_CTX = Number(process.env.GEEKSPACE_LOCAL_NUM_CTX ?? 32768);

// Same operating rules as the Claude lane, tightened for smaller models:
// explicit tool-first behavior and short answers.
const SYSTEM_PROMPT = `You are ARCHITECT, the expert agent for Geekspace — James's local Notion-style workspace app. You operate the workspace ONLY through the provided tools.

Rules:
1. ALWAYS call query_schema first in a conversation before anything else — it returns databases, properties, valid option values, and the page tree. Never guess ids or option names.
2. Property values are passed BY NAME, e.g. {"Status": "In progress", "Due": "2026-06-20", "Estimate (min)": 60}. Dates are YYYY-MM-DD. Relations take row ids from list_rows.
3. No delete tools exist. If asked to delete, say James does deletions in the app.
4. Use tools to act — never claim you did something without calling the tool. A row or page EXISTS ONLY IF you called create_row or create_page in THIS conversation and received an id back. If you were asked to create something and have not called the create tool yet, your ONLY valid next step is to call it. Never report success you cannot point to a tool result for.
5. Tasks with an estimate AND due date auto-schedule onto the calendar. Priorities: Urgent > High > Medium > Low. "Blocked by" relations delay blocked work. After changing tasks, call schedule_warnings and report problems.
6. Answer briefly and technically. Report what you did with names/ids. Do not pad.`;

let mcpClient = null;
let mcpConnecting = null;
let ollamaTools = null;
let history = [];
let resolvedModel = null;

/** Forget the conversation so the next message starts fresh. */
export function resetLocalArchitect() {
  history = [];
}

async function connectMcp() {
  if (mcpClient) return mcpClient;
  if (mcpConnecting) return mcpConnecting;
  mcpConnecting = (async () => {
    try {
      // geekspace-mcp is pure JS (no native modules), so Electron-as-node is
      // safe here — unlike the knowledge server (better-sqlite3, ABI-bound).
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_SERVER],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CONVEX_URL: process.env.CONVEX_URL ?? "http://127.0.0.1:3210",
        },
        stderr: "ignore",
      });
      const c = new Client({ name: "geekspace-local-agent", version: "1.0.0" });
      await c.connect(transport);
      transport.onclose = () => {
        mcpClient = null;
        ollamaTools = null;
      };
      mcpClient = c;
      return c;
    } finally {
      mcpConnecting = null;
    }
  })();
  return mcpConnecting;
}

/** MCP tool defs → Ollama /api/chat `tools` format. */
async function loadTools() {
  if (ollamaTools) return ollamaTools;
  const c = await connectMcp();
  const { tools } = await c.listTools();
  ollamaTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
  return ollamaTools;
}

async function pickModel() {
  if (resolvedModel) return resolvedModel;
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama unreachable at ${OLLAMA_URL}`);
  const { models } = await res.json();
  const names = models.map((m) => m.name).filter((n) => !EXCLUDE.test(n));
  const wanted = process.env.GEEKSPACE_LOCAL_MODEL;
  if (wanted) {
    const hit = names.find((n) => n === wanted || n.startsWith(wanted));
    if (hit) return (resolvedModel = hit);
  }
  for (const pref of MODEL_PREFERENCE) {
    const hit = names.find((n) => n.startsWith(pref));
    if (hit) return (resolvedModel = hit);
  }
  if (names.length) return (resolvedModel = names[0]);
  throw new Error("No usable Ollama models installed");
}

/** {available, model} for the status dot — never throws. */
export async function localArchitectStatus() {
  try {
    const model = await pickModel();
    return { available: true, model };
  } catch (err) {
    return { available: false, error: String(err?.message ?? err) };
  }
}

function textOf(result) {
  return (result.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * One /api/chat round. Deliberately stream:false — on Ollama 0.24 the
 * streaming+tools combination degraded tool behavior for qwen3-coder (it
 * skipped required tool calls and narrated success instead; non-streaming
 * calls the tools correctly). The UI gets each round's text as one frame,
 * which is fine for a local lane. Returns {content, toolCalls}.
 */
async function chatRound(model, messages, tools, onEvent) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      // Low temperature: tool-use needs determinism, not creativity. This is
      // the difference between calling create_row and claiming you did.
      options: { num_ctx: NUM_CTX, temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama /api/chat ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const msg = data.message ?? {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const content = msg.content ?? "";
  // Suppress <think>…</think> reasoning (qwen3/deepseek variants) from the UI.
  const visible = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (visible) onEvent({ type: "token", text: visible });
  return { content, toolCalls };
}

/**
 * Run one local ARCHITECT turn. Same onEvent contract as runArchitect:
 * {type:"token"|"tool"|"error", text}. Resolves when the turn completes.
 */
export async function runArchitectLocal(message, onEvent) {
  const model = await pickModel();
  const tools = await loadTools();
  const c = await connectMcp();

  if (history.length === 0) history.push({ role: "system", content: SYSTEM_PROMPT });
  history.push({ role: "user", content: message });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, toolCalls } = await chatRound(model, history, tools, onEvent);
    history.push({ role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined });

    if (!toolCalls.length) return; // final answer already streamed

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = call.function?.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      onEvent({ type: "tool", text: name });
      let resultText;
      try {
        const result = await c.callTool({ name, arguments: args });
        resultText = textOf(result) || "(empty result)";
        if (result.isError) resultText = `ERROR: ${resultText}`;
      } catch (err) {
        resultText = `ERROR: ${String(err?.message ?? err)}`;
      }
      // Keep giant payloads from blowing the context window.
      if (resultText.length > MAX_TOOL_RESULT_CHARS) {
        resultText = `${resultText.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated)`;
      }
      history.push({ role: "tool", content: resultText, tool_name: name });
    }
  }
  onEvent({ type: "error", text: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.` });
}
