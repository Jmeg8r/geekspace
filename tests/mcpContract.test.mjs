import { expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

it("serves working Zod 4 tools, validates dates and clears a row atomically", async () => {
  const db = {
    _id: "database",
    properties: [
      { id: "title", type: "title", name: "Name" },
      { id: "due", type: "date", name: "Due" },
      { id: "checked", type: "checkbox", name: "Check" },
    ],
  };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const value =
      body.path === "databases:get"
        ? db
        : body.path === "rows:get"
          ? { row: { _id: "row" }, database: db }
          : "row";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", value }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp/index.mjs", import.meta.url))],
    env: {
      PATH: process.env.PATH,
      CONVEX_URL: `http://127.0.0.1:${server.address().port}`,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "geekspace-offline-test",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(14);
    const created = await client.callTool({
      name: "create_row",
      arguments: {
        databaseId: "database",
        properties: { Name: "Fixture", Due: "2026-09-12" },
      },
    });
    expect(created.isError).not.toBe(true);
    expect(requests.at(-1).path).toBe("rows:create");
    const badDate = await client.callTool({
      name: "create_row",
      arguments: { databaseId: "database", properties: { Due: "2026-02-30" } },
    });
    expect(badDate.isError).toBe(true);
    const badBoolean = await client.callTool({
      name: "create_row",
      arguments: { databaseId: "database", properties: { Check: "false" } },
    });
    expect(badBoolean.isError).toBe(true);
    const before = requests.length;
    const updated = await client.callTool({
      name: "update_row",
      arguments: { rowId: "row", properties: { Name: "Changed", Due: null } },
    });
    expect(updated.isError).not.toBe(true);
    expect(requests.slice(before).map((r) => r.path)).toEqual([
      "rows:get",
      "rows:updateProperties",
    ]);
    expect(requests.at(-1).args[0]).toMatchObject({
      properties: { title: "Changed", due: null },
    });
  } finally {
    await client.close();
    await transport.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
