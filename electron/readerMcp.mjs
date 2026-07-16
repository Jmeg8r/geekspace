// WHAT: Reader connector — talks to the local `aib-reader-mcp` stdio MCP server
// (aib-reader, the self-owned RSS aggregation substrate) and exposes its tools to
// the renderer over IPC. Mirrors knowledgeSearch.mjs.
// WHY main-process: child-process + env control, no CORS. aib-reader owns all of
// fetch/parse/dedup/storage, so this is a THIN data bridge — no LLM in the loop.
// Deliberately electron-import-free so it can be exercised with plain `node`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// WHAT: resolve the `aib-reader-mcp` console script.
// WHY env-first, not hardcoded: it's a Python venv entry point, not on PATH by
// default. GEEKSPACE_READER_BIN mirrors the registered ~/.claude.json MCP server
// (which points at the project .venv so it tracks the editable source the
// aib-pipeline cron uses). Fall back to a PATH scan + the usual install dirs.
// Null → reader stays offline instead of crashing (same graceful-degradation
// contract as the knowledge connector).
function resolveReaderBin() {
  const candidates = [
    process.env.GEEKSPACE_READER_BIN,
    ...(process.env.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .map((dir) => path.join(dir, "aib-reader-mcp")),
    path.join(os.homedir(), ".local", "bin", "aib-reader-mcp"),
    "/opt/homebrew/bin/aib-reader-mcp",
    "/usr/local/bin/aib-reader-mcp",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

let client = null;
let connecting = null;

async function connect() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const bin = resolveReaderBin();
      if (!bin) {
        throw new Error(
          "aib-reader not found — set GEEKSPACE_READER_BIN in .env.local to the aib-reader-mcp console script (e.g. <aib-reader>/.venv/bin/aib-reader-mcp)",
        );
      }
      // WHY the env matters: aib-reader resolves config/feeds.yaml RELATIVE to the
      // process CWD, and Electron's main-process CWD is not the aib-reader dir. So
      // AIB_READER_FEEDS_CONFIG must be set (via .env.local, loaded into
      // process.env by main.mjs) for add/remove to write the canonical file. The
      // DB default (~/.aib-reader/store.db) is home-absolute and needs no override.
      const transport = new StdioClientTransport({
        command: bin,
        args: [],
        env: { ...process.env },
        stderr: "ignore",
      });
      const c = new Client({ name: "geekspace-reader", version: "1.0.0" });
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

/** Connect + list tools only (no data calls) — warms the subprocess at startup. */
export async function prewarmReader() {
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

// aib-reader's FastMCP tools return real typed data in `structuredContent`.
// Non-object returns (a list, an int, a bool) arrive wrapped as { result: <value> };
// object returns (a Feed dict, the poll summary) arrive as the object itself.
// Unwrap the single-key {result} envelope; pass real objects through untouched.
function unwrap(result) {
  const sc = result?.structuredContent;
  if (sc == null || typeof sc !== "object") return sc;
  const keys = Object.keys(sc);
  if (keys.length === 1 && keys[0] === "result") return sc.result;
  return sc;
}

async function callTool(name, args) {
  const c = await connect();
  const result = await c.callTool({ name, arguments: args });
  if (result.isError) throw new Error(textOf(result).slice(0, 300) || `${name} failed`);
  return unwrap(result);
}

export const listFeeds = () => callTool("list_feeds", {});
export const recentItems = ({ limit, since, category } = {}) =>
  callTool("recent_items", { limit, since, category });
export const searchItems = (query, limit) => callTool("search_items", { query, limit });
export const markProcessed = (itemIds, consumer) =>
  callTool("mark_processed", { item_ids: itemIds, consumer });
// Feed mutations rewrite the canonical feeds.yaml, which aib-reader resolves
// RELATIVE to CWD — and Electron's CWD is not the aib-reader dir. Without an
// explicit AIB_READER_FEEDS_CONFIG, add/remove would touch (or create) the wrong
// file. Refuse rather than corrupt the config.
function requireFeedsConfig() {
  const config = process.env.AIB_READER_FEEDS_CONFIG;
  if (!config || !existsSync(config)) {
    throw new Error(
      "Set AIB_READER_FEEDS_CONFIG to the canonical aib-reader feeds.yaml before adding or removing feeds.",
    );
  }
}

export const addFeed = (url, category) => {
  requireFeedsConfig();
  return callTool("add_feed", { url, category });
};
export const removeFeed = (url) => {
  requireFeedsConfig();
  return callTool("remove_feed", { url });
};
export const pollFeeds = (categories) => callTool("poll_feeds", { categories });
