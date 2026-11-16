// WHAT: the meeting and search tools in geekspace-mcp, against a mock Convex backend.
// WHY: these tools hand meeting content to outside agents, so the test pins what leaves
// (no audio URL or storage ids) and that they stay read-only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const STARTED_AT = Date.UTC(2026, 10, 16, 14, 0);
const ENDED_AT = Date.UTC(2026, 10, 16, 14, 30);

const LIST = [
  { _id: "m2", _creationTime: 2, title: "Eval planning", meetingType: "brainstorm", status: "done", startedAt: STARTED_AT, endedAt: ENDED_AT, durationSec: 1800, pageId: "p2" },
  { _id: "m1", _creationTime: 1, title: "Standup", status: "error", startedAt: STARTED_AT - 1000, error: "boom" },
];
const FULL = {
  ...LIST[0],
  transcript: "we decided to ship",
  summary: "Planned evals",
  keyPoints: ["k"],
  decisions: ["ship it"],
  actionItems: ["write spec"],
  audioStorageId: "storage-secret",
  audioUrl: "http://127.0.0.1/signed-secret",
  generatedContent: "internal",
};
const SEARCH = { pages: [{ _id: "p1", title: "Evals", kind: "doc" }], rows: [], docs: [], transcripts: [], screenshots: [] };

// The tools under test only ever send string, number and boolean arguments.
const ToolArg = z.union([z.string(), z.number(), z.boolean()]);
type ToolArgs = Record<string, z.infer<typeof ToolArg>>;
const ArgsBody = z.object({ path: z.string(), args: z.array(z.record(z.string(), ToolArg)) });
const TextContent = z.array(z.object({ type: z.literal("text"), text: z.string() }));

describe("MCP meeting and search tools", () => {
  let backend: Server;
  let client: Client;
  let mutations: number;
  let calls: { path: string; args: ToolArgs }[];

  beforeEach(async () => {
    mutations = 0;
    calls = [];
    backend = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/mutation") {
          mutations++;
          response.end(JSON.stringify({ status: "success", value: null }));
          return;
        }
        const { path, args } = ArgsBody.parse(JSON.parse(body));
        calls.push({ path, args: args[0] ?? {} });
        const value =
          path === "meetings:list" ? LIST
          : path === "meetings:get" ? (args[0]?.meetingId === "m2" ? FULL : null)
          : path === "search:searchAll" ? SEARCH
          : [];
        response.end(JSON.stringify({ status: "success", value }));
      });
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const address = z.object({ port: z.number().int().positive() }).parse(backend.address());
    client = new Client({ name: "read-tools-test", version: "1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../mcp/index.mjs", import.meta.url))],
      env: { CONVEX_URL: `http://127.0.0.1:${address.port}` },
      stderr: "ignore",
    }));
  });

  afterEach(async () => {
    await client?.close();
    if (backend) {
      backend.closeAllConnections();
      await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
    }
  });

  async function call(name: string, args: ToolArgs = {}) {
    const result = await client.callTool({ name, arguments: args });
    const [content] = TextContent.parse(result.content);
    return { isError: result.isError === true, text: content.text };
  }

  it("lists meetings newest first, shaped for agents, without query_schema", async () => {
    const { isError, text } = await call("list_meetings", { limit: 1 });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual([{
      meetingId: "m2",
      title: "Eval planning",
      meetingType: "brainstorm",
      status: "done",
      startedAt: "2026-11-16T14:00:00.000Z",
      endedAt: "2026-11-16T14:30:00.000Z",
      durationSec: 1800,
      notesPageId: "p2",
    }]);
  });

  it("returns meeting notes and transcript but never audio URLs or storage ids", async () => {
    const { isError, text } = await call("get_meeting", { meetingId: "m2" });
    expect(isError).toBe(false);
    const meeting = JSON.parse(text);
    expect(meeting).toMatchObject({
      summary: "Planned evals",
      decisions: ["ship it"],
      actionItems: ["write spec"],
      transcript: "we decided to ship",
    });
    expect(text).not.toContain("secret");
    expect(text).not.toContain("internal");
  });

  it("omits the transcript when asked", async () => {
    const meeting = JSON.parse((await call("get_meeting", { meetingId: "m2", includeTranscript: false })).text);
    expect(meeting).not.toHaveProperty("transcript");
    expect(meeting.summary).toBe("Planned evals");
  });

  it("reports a missing meeting as an error", async () => {
    const { isError, text } = await call("get_meeting", { meetingId: "nope" });
    expect(isError).toBe(true);
    expect(text).toContain("Meeting not found: nope");
  });

  it("passes the trimmed query to searchAll and returns its result", async () => {
    const { isError, text } = await call("search_workspace", { query: "  evals " });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual(SEARCH);
    expect(calls).toContainEqual({ path: "search:searchAll", args: { q: "evals" } });
  });

  it("rejects an empty search query before calling the backend", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "   " } });
    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.path === "search:searchAll")).toBe(false);
  });

  it("never mutates", async () => {
    await call("list_meetings");
    await call("get_meeting", { meetingId: "m2" });
    await call("search_workspace", { query: "evals" });
    expect(mutations).toBe(0);
  });
});
