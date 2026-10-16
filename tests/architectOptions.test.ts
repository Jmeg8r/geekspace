import { describe, expect, it } from "vitest";
import { ARCHITECT_TOOLS, architectOptions } from "../electron/architect.mjs";

// WHAT: the Claude lane is confined to the geekspace MCP tools. Before this change the SDK
// exposed 32 built-in tools (Bash, Edit, Write…) and ~30 of James's MCP servers with
// permission checks bypassed. See docs/changes/2026-10-16-agent-mcp/.

describe("architectOptions", () => {
  const opts = architectOptions({ env: { PATH: "/usr/bin", HOME: "/Users/x", SECRET_TOKEN: "fixture" } });

  it("disables every built-in tool and loads no filesystem settings", () => {
    expect(opts.tools).toEqual([]);
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
  });

  it("denies anything not pre-approved instead of bypassing permissions", () => {
    expect(opts.permissionMode).toBe("dontAsk");
    expect(opts.allowDangerouslySkipPermissions).toBeFalsy();
  });

  it("pre-approves exactly the geekspace workspace tools", () => {
    expect(ARCHITECT_TOOLS).toHaveLength(14);
    expect(opts.allowedTools).toEqual(ARCHITECT_TOOLS.map((t: string) => `mcp__geekspace__${t}`));
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["geekspace"]);
  });

  it("starts the MCP server without the parent's secrets", () => {
    const env = opts.mcpServers?.geekspace?.env ?? {};
    expect(env).not.toHaveProperty("SECRET_TOKEN");
    expect(env.CONVEX_URL).toBe("http://127.0.0.1:3210");
  });

  it("resumes the previous session only when given one", () => {
    expect(opts.resume).toBeUndefined();
    expect(architectOptions({ resumeId: "s1", env: {} }).resume).toBe("s1");
  });
});
