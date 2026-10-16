// WHAT: helpers both ARCHITECT lanes share (Claude Agent SDK and local Ollama).
// WHY: the lanes drifted (different error frame shapes, one trimming nothing); keeping
// the env allowlist, history budget, argument parsing and turn gate here keeps them
// identical and testable. See docs/changes/2026-10-16-agent-mcp/.

const DEFAULT_CONVEX_URL = "http://127.0.0.1:3210";

// What a Node/Electron child needs to start on mac and Windows. Everything else in the
// main process env (including keys loaded from .env.local) stays out of the MCP server.
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "ComSpec",
];

/** The geekspace-mcp subprocess env: the start-up basics plus CONVEX_URL, nothing else. */
export function mcpEnv(env = process.env) {
  const out = {};
  for (const key of PASSTHROUGH_ENV) {
    if (typeof env[key] === "string") out[key] = env[key];
  }
  out.CONVEX_URL = typeof env.CONVEX_URL === "string" && env.CONVEX_URL ? env.CONVEX_URL : DEFAULT_CONVEX_URL;
  out.ELECTRON_RUN_AS_NODE = "1";
  return out;
}

function messageChars(m) {
  const content = typeof m.content === "string" ? m.content.length : 0;
  return content + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

/**
 * Fit a chat history to `maxChars`: keep the leading system message, then the newest whole
 * turns (a turn starts at a user message), so a tool result is never cut from its call.
 * The newest turn is kept even when it alone is over budget; splitting it would be worse.
 */
export function trimHistory(history, maxChars) {
  const total = history.reduce((n, m) => n + messageChars(m), 0);
  if (total <= maxChars) return history;

  const system = history[0]?.role === "system" ? [history[0]] : [];
  const rest = history.slice(system.length);
  const starts = [];
  rest.forEach((m, i) => {
    if (m.role === "user" || i === 0) starts.push(i);
  });

  let budget = maxChars - system.reduce((n, m) => n + messageChars(m), 0);
  let keepFrom = rest.length;
  for (let t = starts.length - 1; t >= 0; t--) {
    const end = t + 1 < starts.length ? starts[t + 1] : rest.length;
    const size = rest.slice(starts[t], end).reduce((n, m) => n + messageChars(m), 0);
    const isNewest = keepFrom === rest.length;
    if (!isNewest && size > budget) break;
    budget -= size;
    keepFrom = starts[t];
  }
  return [...system, ...rest.slice(keepFrom)];
}

/** Tool-call arguments from a local model: an object, a JSON object string, or nothing. */
export function parseToolArgs(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, args: {} };
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `arguments are not valid JSON (${String(err?.message ?? err)})` };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  return { ok: true, args: value };
}

/** The one error frame shape both lanes send and the agent panel renders. */
export function errorFrame(text) {
  return { type: "error", text: String(text) };
}

/** Wrap a turn runner so a second turn is refused while one is running. */
export function oneTurnAtATime(run) {
  let busy = false;
  return async (...args) => {
    if (busy) throw new Error("ARCHITECT is still working on the last message");
    busy = true;
    try {
      return await run(...args);
    } finally {
      busy = false;
    }
  };
}
