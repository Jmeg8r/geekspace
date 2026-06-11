// WHAT: Enterprise Search connectors (pluggable-lite). The first connector
// talks to the local mcp-astgl-knowledge server over stdio MCP.
// WHY main-process: child process + env control, no CORS; the renderer
// reaches it via IPC. Deliberately electron-import-free so it can be tested
// standalone with plain `node`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";

const ASTGL_SERVER = "/path/to/mcp-astgl-knowledge/dist/index.js";

// WHY a real node binary (NOT Electron-as-node): mcp-astgl-knowledge depends
// on better-sqlite3, a native module compiled against the system node ABI.
// Electron bundles a different Node ABI, so spawning it via
// process.execPath + ELECTRON_RUN_AS_NODE crashes the server on import
// ("NODE_MODULE_VERSION" mismatch → MCP error -32000: Connection closed).
// Rebuilding the module for Electron would break the standalone server's
// LaunchAgents, so we find a system node instead.
function resolveNodeBinary() {
  const candidates = [
    process.env.GEEKSPACE_NODE, // explicit override, e.g. for the packaged app
    ...(process.env.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .map((dir) => path.join(dir, "node")),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  // Last resort: under plain node (tests) execPath IS node and this is fine;
  // under Electron the ABI mismatch will surface in the connector's error.
  return process.execPath;
}

let client = null;
let connecting = null;

async function connect() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const transport = new StdioClientTransport({
        command: resolveNodeBinary(),
        args: [ASTGL_SERVER],
        env: { ...process.env },
        stderr: "ignore",
      });
      const c = new Client({ name: "geekspace", version: "1.0.0" });
      await c.connect(transport);
      transport.onclose = () => {
        client = null;
      };
      client = c;
      return c;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/** Connect + list tools only — no rate-limited tool calls burned on warmup. */
export async function prewarmKnowledge() {
  const c = await connect();
  await c.listTools();
  return true;
}

function textOf(result) {
  return (result.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Parse search_articles output:
 *   ### 1. Title — Section\n**Source:** url\n**Relevance:** 0.83\n\ncontent…
 * separated by "---" rules, with an optional rate-limit footer segment.
 */
function parseSearchText(text) {
  const segments = text.split(/\n-{3,}\n/);
  const results = [];
  let rateInfo;
  for (const seg of segments) {
    const head = seg.match(/###\s*\d+\.\s*(.+?)(?:\s+—\s+(.+))?\s*\n/);
    if (!head) {
      const trimmed = seg.trim();
      if (/rate|quer/i.test(trimmed) && trimmed.length < 300) rateInfo = trimmed.replace(/^\*|\*$/g, "");
      continue;
    }
    const url = seg.match(/\*\*Source:\*\*\s*(\S+)/)?.[1];
    const score = Number(seg.match(/\*\*Relevance:\*\*\s*([\d.]+)/)?.[1] ?? 0);
    const body = seg
      .replace(/###[^\n]*\n/, "")
      .replace(/\*\*Source:\*\*[^\n]*\n?/, "")
      .replace(/\*\*Relevance:\*\*[^\n]*\n?/, "")
      .trim();
    results.push({
      title: head[1].trim(),
      section: head[2]?.trim(),
      url,
      score,
      snippet: body.length > 320 ? `${body.slice(0, 320)}…` : body,
    });
  }
  return { results, rateInfo };
}

export async function searchKnowledge(query, limit = 5) {
  const c = await connect();
  const result = await c.callTool({
    name: "search_articles",
    arguments: { query, limit: Math.max(1, Math.min(limit, 20)) },
  });
  const text = textOf(result);
  if (/no matching articles/i.test(text)) return { results: [], rateInfo: undefined };
  if (result.isError) throw new Error(text.slice(0, 300) || "search failed");
  return parseSearchText(text);
}

/** Returns the raw markdown-ish answer text with sources — rendered as-is. */
export async function answerKnowledge(question) {
  const c = await connect();
  const result = await c.callTool({ name: "get_answer", arguments: { question } });
  const text = textOf(result);
  if (result.isError) throw new Error(text.slice(0, 300) || "answer failed");
  return text;
}
