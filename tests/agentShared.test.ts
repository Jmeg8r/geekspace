import { describe, expect, it } from "vitest";
import { errorFrame, mcpEnv, oneTurnAtATime, parseToolArgs, trimHistory } from "../electron/agentShared.mjs";

// WHAT: helpers both ARCHITECT lanes share: the MCP subprocess env, local-lane history
// trimming, tool-argument parsing, and the error frame. See docs/changes/2026-10-16-agent-mcp/.

describe("mcpEnv", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    CONVEX_URL: "http://127.0.0.1:3999",
    ASTGL_API_KEY: "fixture-not-a-real-key",
    CLAUDECLAW_TOKEN: "fixture-not-a-real-token",
  };

  it("passes only what the MCP server needs to start", () => {
    const env = mcpEnv(parent);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      CONVEX_URL: "http://127.0.0.1:3999",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("defaults CONVEX_URL to the local deployment", () => {
    expect(mcpEnv({ PATH: "/usr/bin" }).CONVEX_URL).toBe("http://127.0.0.1:3210");
  });
});

describe("trimHistory", () => {
  const sys = { role: "system", content: "RULES" };
  const turn = (n: number, size = 100) => [
    { role: "user", content: `u${n} ${"x".repeat(size)}` },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "query_schema", arguments: {} } }] },
    { role: "tool", content: `t${n} ${"y".repeat(size)}`, tool_name: "query_schema" },
    { role: "assistant", content: `a${n}` },
  ];
  const chars = (h: Array<{ content?: string }>) => h.reduce((n, m) => n + (m.content?.length ?? 0), 0);

  it("leaves a history under budget untouched", () => {
    const h = [sys, ...turn(1)];
    expect(trimHistory(h, 10_000)).toEqual(h);
  });

  it("keeps the system prompt and drops the oldest whole turns to fit", () => {
    const h = [sys, ...turn(1, 2000), ...turn(2, 2000), ...turn(3, 2000)];
    const out = trimHistory(h, 5000);
    expect(out[0]).toEqual(sys);
    expect(out[1]?.role).toBe("user");
    expect(out.some((m) => m.content?.startsWith("u1"))).toBe(false);
    expect(out.some((m) => m.content?.startsWith("u3"))).toBe(true);
    expect(chars(out)).toBeLessThanOrEqual(5000);
  });

  it("never separates a tool result from the call that produced it", () => {
    const h = [sys, ...turn(1, 2000), ...turn(2, 2000)];
    const out = trimHistory(h, 4500);
    const firstAfterSystem = out[1];
    expect(firstAfterSystem?.role).toBe("user");
    for (let i = 0; i < out.length; i++) {
      if (out[i].role === "tool") expect(out[i - 1]?.role === "assistant" || out[i - 1]?.role === "tool").toBe(true);
    }
  });

  it("keeps the newest turn whole even when it alone is over budget", () => {
    const h = [sys, ...turn(1, 100), ...turn(2, 9000)];
    const out = trimHistory(h, 1000);
    expect(out[0]).toEqual(sys);
    expect(out.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(out[1]?.content?.startsWith("u2")).toBe(true);
  });
});

describe("parseToolArgs", () => {
  it("accepts an object or a JSON object string", () => {
    expect(parseToolArgs({ a: 1 })).toEqual({ ok: true, args: { a: 1 } });
    expect(parseToolArgs('{"a":1}')).toEqual({ ok: true, args: { a: 1 } });
    expect(parseToolArgs(undefined)).toEqual({ ok: true, args: {} });
  });

  it("reports malformed arguments instead of substituting {}", () => {
    const bad = parseToolArgs('{"a":1');
    expect(bad.ok).toBe(false);
    expect(parseToolArgs("[1,2]").ok).toBe(false);
  });
});

describe("errorFrame", () => {
  it("is the one shape both lanes send and the panel renders", () => {
    expect(errorFrame("Agent stopped: error_max_turns")).toEqual({
      type: "error",
      text: "Agent stopped: error_max_turns",
    });
  });
});

describe("oneTurnAtATime", () => {
  it("refuses a second turn while one is running, then allows the next", async () => {
    let finish = () => {};
    const run = oneTurnAtATime(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const first = run();
    await expect(run()).rejects.toThrow(/still working/i);
    finish();
    await first;
    const third = run();
    finish();
    await expect(third).resolves.toBeUndefined();
  });

  it("frees the slot when a turn fails", async () => {
    let fail = true;
    const run = oneTurnAtATime(async () => {
      if (fail) throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    fail = false;
    await expect(run()).resolves.toBeUndefined();
  });
});
