import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

describe("MCP schema-before-write boundary", () => {
  let backend: Server;
  let client: Client;
  let url: string;
  let mutations: number;
  let failSchema: boolean;

  async function connect() {
    const next = new Client({ name: "schema-first-test", version: "1" });
    await next.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../mcp/index.mjs", import.meta.url))],
      env: { CONVEX_URL: url },
      stderr: "ignore",
    }));
    return next;
  }

  beforeEach(async () => {
    mutations = 0;
    failSchema = false;
    backend = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/mutation") {
          mutations++;
          response.end(JSON.stringify({ status: "success", value: "synthetic-page" }));
        } else if (failSchema) {
          response.end(JSON.stringify({ status: "error", errorMessage: "schema unavailable" }));
        } else {
          response.end(JSON.stringify({ status: "success", value: [] }));
        }
      });
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const address = z.object({ port: z.number().int().positive() }).parse(backend.address());
    url = `http://127.0.0.1:${address.port}`;
    client = await connect();
  });

  afterEach(async () => {
    await client?.close();
    if (backend) {
      backend.closeAllConnections();
      await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
    }
  });

  const writes = [
    { name: "create_page", arguments: { title: "Denied" } },
    { name: "update_page", arguments: { pageId: "page", title: "Denied" } },
    { name: "set_page_content", arguments: { pageId: "page", blocks: "[]" } },
    { name: "add_property", arguments: { databaseId: "database", type: "text" } },
    { name: "create_row", arguments: { databaseId: "database", properties: {} } },
    { name: "update_row", arguments: { rowId: "row", properties: {} } },
    { name: "set_row_content", arguments: { rowId: "row", blocks: "[]" } },
    { name: "apply_template", arguments: { templateId: "template", title: "Denied", startDate: "2026-10-11" } },
  ];

  it.each(writes)("refuses $name before any backend mutation", async request => {
    const result = await client.callTool(request);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Call query_schema successfully") }]);
    expect(mutations).toBe(0);
  });

  it("allows a write after a successful schema read", async () => {
    expect((await client.callTool({ name: "query_schema", arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool(writes[0])).isError).not.toBe(true);
    expect(mutations).toBe(1);
  });

  it("does not treat another read-only tool as schema discovery", async () => {
    expect((await client.callTool({ name: "list_templates", arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool(writes[0])).isError).toBe(true);
    expect(mutations).toBe(0);
  });

  it("requires a successful schema refresh after a failed one", async () => {
    await client.callTool({ name: "query_schema", arguments: {} });
    failSchema = true;
    expect((await client.callTool({ name: "query_schema", arguments: {} })).isError).toBe(true);
    expect((await client.callTool(writes[0])).isError).toBe(true);
    expect(mutations).toBe(0);
    failSchema = false;
    await client.callTool({ name: "query_schema", arguments: {} });
    expect((await client.callTool(writes[0])).isError).not.toBe(true);
    expect(mutations).toBe(1);
  });

  it("keeps discovery scoped to each stdio session", async () => {
    await client.callTool({ name: "query_schema", arguments: {} });
    const second = await connect();
    try {
      expect((await second.callTool(writes[0])).isError).toBe(true);
      expect(mutations).toBe(0);
    } finally {
      await second.close();
    }
  });
});
