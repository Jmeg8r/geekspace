#!/usr/bin/env node
// WHAT: geekspace-mcp — a stdio MCP server exposing the Geekspace workspace
// (pages, databases, rows, schedule) to ANY agent: ClaudeClaw's ARCHITECT,
// Claude Code, Claude Desktop. Wraps the app's existing Convex functions; no
// new backend logic lives here.
//
// Design rules:
// - Agent ergonomics: tools accept property/option NAMES; ids are resolved
//   internally (and select/status values are validated against real options).
// - Phase A safety: create + edit only — no delete/trash tools.
//
// Run: node mcp/index.mjs   (CONVEX_URL defaults to the local deployment)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const convex = new ConvexHttpClient(CONVEX_URL);
const DAY_MS = 86_400_000;

const server = new McpServer(
  { name: "geekspace", version: "1.0.0" },
  {
    instructions:
      "Operate James's Geekspace workspace (local Notion-style app). Call query_schema FIRST to learn databases, properties, and option values. Property values are passed BY NAME (e.g. {\"Status\": \"In progress\", \"Due\": \"2026-06-20\", \"Estimate (min)\": 60}). Dates are YYYY-MM-DD (calendar dates) or {start, end}. Relations take row ids from list_rows. Tasks with an estimate + due date are auto-scheduled onto the calendar; dependencies (Blocked by) delay blocked work. There are no delete tools — never promise deletion.",
  }
);

const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message) => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  isError: true,
});

function tool(name, description, shape, handler) {
  server.tool(name, description, shape, async (args) => {
    try {
      return ok(await handler(args ?? {}));
    } catch (err) {
      return fail(String(err?.message ?? err).slice(0, 500));
    }
  });
}

// ---------- helpers ----------

async function getDatabase(databaseId) {
  const db = await convex.query(api.databases.get, { databaseId });
  if (!db) throw new Error(`Database not found: ${databaseId}`);
  return db;
}

function describeProperty(p) {
  const d = { id: p.id, name: p.name, type: p.type };
  if (p.options) d.options = p.options.map((o) => ({ name: o.name, color: o.color, group: o.group }));
  if (p.relation) d.relatesToDatabaseId = p.relation.databaseId;
  if (p.numberFormat) d.numberFormat = p.numberFormat;
  return d;
}

function parseDateInput(value) {
  // "YYYY-MM-DD" or { start: "YYYY-MM-DD", end?: "YYYY-MM-DD" } → DateValue
  const toCal = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
    if (!m) throw new Error(`Invalid date "${s}" — use YYYY-MM-DD`);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  };
  if (typeof value === "string") return { start: toCal(value) };
  if (value && typeof value === "object" && value.start) {
    return { start: toCal(value.start), end: value.end ? toCal(value.end) : undefined };
  }
  throw new Error("Date must be YYYY-MM-DD or {start, end}");
}

/** Resolve name-keyed property inputs to the db's prop-id-keyed values. */
function resolveProperties(db, named) {
  const props = db.properties;
  const out = {};
  for (const [name, value] of Object.entries(named ?? {})) {
    const def = props.find((p) => p.name.toLowerCase() === name.toLowerCase() || p.id === name);
    if (!def) {
      throw new Error(
        `Unknown property "${name}". Available: ${props.map((p) => p.name).join(", ")}`
      );
    }
    if (def.type === "rollup" || def.type === "createdTime" || def.type === "updatedTime") {
      throw new Error(`Property "${def.name}" is computed and read-only`);
    }
    if (value === null) {
      out[def.id] = undefined;
      continue;
    }
    switch (def.type) {
      case "select":
      case "status": {
        const opt = (def.options ?? []).find(
          (o) => o.name.toLowerCase() === String(value).toLowerCase() || o.id === value
        );
        if (!opt) {
          throw new Error(
            `"${value}" is not an option of "${def.name}". Options: ${(def.options ?? [])
              .map((o) => o.name)
              .join(", ")}`
          );
        }
        out[def.id] = opt.id;
        break;
      }
      case "multiSelect": {
        const values = Array.isArray(value) ? value : [value];
        out[def.id] = values.map((v) => {
          const opt = (def.options ?? []).find(
            (o) => o.name.toLowerCase() === String(v).toLowerCase() || o.id === v
          );
          if (!opt) throw new Error(`"${v}" is not an option of "${def.name}"`);
          return opt.id;
        });
        break;
      }
      case "date":
        out[def.id] = parseDateInput(value);
        break;
      case "number": {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`"${def.name}" needs a number`);
        out[def.id] = n;
        break;
      }
      case "checkbox":
        out[def.id] = Boolean(value);
        break;
      case "relation": {
        const ids = Array.isArray(value) ? value : [value];
        out[def.id] = ids.map(String);
        break;
      }
      default:
        out[def.id] = String(value);
    }
  }
  return out;
}

function compactRow(row, db, relationTitles = {}) {
  const props = {};
  for (const def of db.properties) {
    const v = row.properties?.[def.id];
    if (v === undefined || v === null) continue;
    switch (def.type) {
      case "select":
      case "status":
        props[def.name] = def.options?.find((o) => o.id === v)?.name ?? v;
        break;
      case "multiSelect":
        props[def.name] = (v ?? []).map((id) => def.options?.find((o) => o.id === id)?.name ?? id);
        break;
      case "date": {
        const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
        props[def.name] = v.end ? `${fmt(v.start)} → ${fmt(v.end)}` : fmt(v.start);
        break;
      }
      case "relation":
        props[def.name] = (v ?? []).map((id) => ({ rowId: id, title: relationTitles[id] ?? "?" }));
        break;
      case "rollup":
        props[def.name] = row.computed?.[def.id] ?? null;
        break;
      default:
        props[def.name] = v;
    }
  }
  return { rowId: row._id, title: row.title, properties: props };
}

// ---------- orientation ----------

tool(
  "query_schema",
  "ALWAYS call this first. Returns every database with its properties, option values, and ids — plus workspace conventions.",
  {},
  async () => {
    const [dbs, pages] = await Promise.all([
      convex.query(api.databases.listAll, {}),
      convex.query(api.pages.list, {}),
    ]);
    return {
      conventions:
        "Dates are calendar dates (YYYY-MM-DD). Tasks in a task-source database get auto-scheduled time blocks when they have an estimate + due date and their status is not complete. 'Blocked by' relations delay scheduling until blockers finish.",
      databases: dbs.map((db) => ({
        databaseId: db._id,
        name: db.name,
        isTaskSource: db.isTaskSource ?? false,
        isSprintDatabase: Boolean(db.sprintConfig),
        properties: db.properties.map(describeProperty),
      })),
      pageTree: pages.map((p) => ({
        pageId: p._id,
        title: p.title,
        kind: p.kind,
        parentId: p.parentId ?? null,
        databaseId: p.databaseId ?? null,
      })),
    };
  }
);

// ---------- pages ----------

tool(
  "get_page",
  "Get one page including its BlockNote content JSON.",
  { pageId: z.string() },
  async ({ pageId }) => {
    const page = await convex.query(api.pages.get, { pageId });
    if (!page) throw new Error("Page not found");
    return page;
  }
);

tool(
  "create_page",
  "Create a doc page (kind=doc) or a new database (kind=database). Returns the new pageId.",
  {
    title: z.string(),
    kind: z.enum(["doc", "database"]).default("doc"),
    parentId: z.string().optional(),
    icon: z.string().optional().describe("Single emoji"),
  },
  async ({ title, kind, parentId, icon }) => {
    const pageId = await convex.mutation(api.pages.create, { title, kind, parentId, icon });
    return { pageId, note: kind === "database" ? "Database created with default properties (Name/Status/Date/Tags) — inspect via query_schema." : "Page created." };
  }
);

tool(
  "update_page",
  "Rename a page or change its emoji icon.",
  { pageId: z.string(), title: z.string().optional(), icon: z.string().optional() },
  async ({ pageId, title, icon }) => {
    await convex.mutation(api.pages.update, { pageId, title, icon });
    return "updated";
  }
);

tool(
  "set_page_content",
  "Replace a doc page's content. Content is a JSON array of BlockNote partial blocks, e.g. [{\"type\":\"heading\",\"props\":{\"level\":2},\"content\":\"Title\"},{\"type\":\"paragraph\",\"content\":\"text\"},{\"type\":\"bulletListItem\",\"content\":\"item\"},{\"type\":\"checkListItem\",\"props\":{\"checked\":false},\"content\":\"todo\"}]",
  { pageId: z.string(), blocks: z.string().describe("JSON array string of BlockNote blocks") },
  async ({ pageId, blocks }) => {
    const parsed = JSON.parse(blocks);
    if (!Array.isArray(parsed)) throw new Error("blocks must be a JSON array");
    await convex.mutation(api.pages.setContent, { pageId, content: JSON.stringify(parsed) });
    return "content set";
  }
);

// ---------- databases & rows ----------

tool(
  "add_property",
  "Add a property (column) to a database. Types: text, number, select, multiSelect, status, date, checkbox, url, relation (needs targetDatabaseId), rollup.",
  {
    databaseId: z.string(),
    type: z.string(),
    name: z.string().optional(),
    targetDatabaseId: z.string().optional(),
  },
  async ({ databaseId, type, name, targetDatabaseId }) => {
    const propId = await convex.mutation(api.databases.addProperty, {
      databaseId,
      type,
      name,
      targetDatabaseId,
    });
    if (!propId) throw new Error("Property creation failed (check databaseId / targetDatabaseId)");
    return { propId };
  }
);

tool(
  "list_rows",
  "List a database's rows with readable property values (option names, dates, relation titles).",
  { databaseId: z.string(), limit: z.number().min(1).max(200).default(100) },
  async ({ databaseId, limit }) => {
    const db = await getDatabase(databaseId);
    const { rows, relationTitles } = await convex.query(api.rows.list, { databaseId });
    return rows.slice(0, limit).map((r) => compactRow(r, db, relationTitles));
  }
);

tool(
  "create_row",
  "Create a row (e.g. a task or project). properties is name-keyed: {\"Name\":\"Write draft\",\"Status\":\"Not started\",\"Priority\":\"High\",\"Due\":\"2026-06-20\",\"Estimate (min)\":90}",
  {
    databaseId: z.string(),
    properties: z.record(z.any()),
  },
  async ({ databaseId, properties }) => {
    const db = await getDatabase(databaseId);
    const resolved = resolveProperties(db, properties);
    if (properties.Name && resolved.title === undefined) {
      resolved.title = String(properties.Name);
    }
    const rowId = await convex.mutation(api.rows.create, { databaseId, properties: resolved });
    return { rowId };
  }
);

tool(
  "update_row",
  "Update one or more properties on a row (name-keyed, same format as create_row). Pass null to clear a property. Relation changes sync both sides; task changes reflow the calendar automatically.",
  { rowId: z.string(), properties: z.record(z.any()) },
  async ({ rowId, properties }) => {
    const got = await convex.query(api.rows.get, { rowId });
    if (!got) throw new Error("Row not found");
    const resolved = resolveProperties(got.database, properties);
    for (const [propId, value] of Object.entries(resolved)) {
      await convex.mutation(api.rows.updateProperty, { rowId, propId, value });
    }
    return `updated ${Object.keys(resolved).length} propert${Object.keys(resolved).length === 1 ? "y" : "ies"}`;
  }
);

tool(
  "set_row_content",
  "Set the document body of a row (every row is a page). Same BlockNote JSON format as set_page_content.",
  { rowId: z.string(), blocks: z.string() },
  async ({ rowId, blocks }) => {
    const parsed = JSON.parse(blocks);
    if (!Array.isArray(parsed)) throw new Error("blocks must be a JSON array");
    await convex.mutation(api.rows.setContent, { rowId, content: JSON.stringify(parsed) });
    return "content set";
  }
);

// ---------- schedule ----------

tool(
  "my_tasks",
  "All open tasks across task databases with due dates, estimates, priority, and blocked status.",
  {},
  async () => convex.query(api.calendarData.myTasks, {})
);

tool(
  "schedule_warnings",
  "Auto-scheduler warnings: tasks that can't fit before the horizon, past-due work, dependency cycles.",
  {},
  async () => convex.query(api.scheduling.getWarnings, {})
);

// ---------- templates (Phase 3 wiring) ----------

tool(
  "list_templates",
  "List available project templates.",
  {},
  async () => {
    // WHY try/catch: api.* is a path proxy — absence only surfaces at call time.
    try {
      return await convex.query(api.templates.list, {});
    } catch {
      return "Templates are not available yet in this build.";
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
