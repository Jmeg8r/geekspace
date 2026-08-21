// WHAT: Reader connector — talks to the local `aib-reader-mcp` stdio MCP server
// (aib-reader, the self-owned RSS aggregation substrate) and exposes its tools to
// the renderer over IPC. Mirrors knowledgeSearch.mjs.
// WHY main-process: child-process + env control, no CORS. aib-reader owns all of
// fetch/parse/dedup/storage, so this is a THIN data bridge — no LLM in the loop.
// Deliberately electron-import-free so it can be exercised with plain `node`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// WHY: Windows executables carry the .exe suffix; used when probing PATH
// entries for the aib-reader-mcp console script.
const EXE = process.platform === "win32" ? ".exe" : "";

// WHAT: cross-platform "app support" root — mirrors Electron's
// app.getPath("appData") without importing electron (see the file WHY above).
// Callers append "Geekspace" themselves, same as convexBackend.mjs's DATA_DIR.
function appSupportDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  return path.join(os.homedir(), "Library", "Application Support");
}

// WHAT: optional packaged-app config. A double-clicked .app can't read the dev
// `.env.local` (it lives outside the bundle), so it reads reader setup from a JSON
// file in Geekspace's app-support dir instead. Both keys optional; env vars win.
//   { "readerBin": "/abs/aib-reader-mcp", "feedsConfig": "/abs/config/feeds.yaml" }
function readerConfig() {
  try {
    const p = path.join(appSupportDir(), "Geekspace", "reader.json");
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

// The canonical aib-reader feeds.yaml path. Dev: AIB_READER_FEEDS_CONFIG (from
// .env.local). Packaged: `feedsConfig` from reader.json — so add/remove/poll write the
// SAME file the aib-pipeline cron uses, not a CWD-relative path the .app can't control.
function resolveFeedsConfig() {
  const fromEnv = process.env.AIB_READER_FEEDS_CONFIG?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readerConfig().feedsConfig;
  return typeof fromFile === "string" && fromFile.trim() ? fromFile.trim() : undefined;
}

// WHAT: resolve the `aib-reader-mcp` console script.
// WHY env-first, not hardcoded: it's a Python venv entry point, not on PATH by
// default. GEEKSPACE_READER_BIN mirrors the registered ~/.claude.json MCP server
// (which points at the project .venv so it tracks the editable source the
// aib-pipeline cron uses). Fall back to a PATH scan + the usual install dirs.
// Null → reader stays offline instead of crashing (same graceful-degradation
// contract as the knowledge connector).
function resolveReaderBin() {
  // Try the platform-appropriate suffix first per PATH dir. EXE is "" on mac,
  // so this collapses to the single original candidate there.
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) =>
      EXE
        ? [path.join(dir, "aib-reader-mcp" + EXE), path.join(dir, "aib-reader-mcp")]
        : [path.join(dir, "aib-reader-mcp")]
    );
  const candidates = [
    process.env.GEEKSPACE_READER_BIN,
    readerConfig().readerBin,
    ...pathCandidates,
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
      // Give the child the canonical feeds.yaml path so add/remove/poll write the
      // right file: aib-reader resolves config/feeds.yaml RELATIVE to CWD, which the
      // Electron process doesn't control. Dev gets it from .env.local (already in
      // process.env); the packaged .app gets it from reader.json (resolveFeedsConfig).
      // The DB default (~/.aib-reader/store.db) is home-absolute and needs no override.
      const feedsConfig = resolveFeedsConfig();
      const transport = new StdioClientTransport({
        command: bin,
        args: [],
        env: { ...process.env, ...(feedsConfig ? { AIB_READER_FEEDS_CONFIG: feedsConfig } : {}) },
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
// Feed mutations (add/remove) rewrite the canonical feeds.yaml. Refuse unless we can
// resolve a real feeds.yaml FILE — otherwise aib-reader falls back to a CWD-relative
// path the app can't control. (existsSync also passes for directories, and guards
// statSync from throwing on a missing path via short-circuit.)
function requireFeedsConfig() {
  const config = resolveFeedsConfig();
  if (!config || !existsSync(config) || !statSync(config).isFile()) {
    throw new Error(
      "No aib-reader feeds.yaml configured — set AIB_READER_FEEDS_CONFIG (dev) or `feedsConfig` in ~/Library/Application Support/Geekspace/reader.json on mac (packaged) or %APPDATA%\\Geekspace\\reader.json on Windows to the canonical feeds.yaml before adding or removing feeds.",
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
