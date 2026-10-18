import { describe, expect, it } from "vitest";
import { listenerCwd } from "../scripts/lib/listenerCwd.mjs";

// WHAT: deploy:local only records its checkout's ordinal against the packaged data dir when
// the backend on the port provably runs from it. See
// docs/changes/2026-10-17-function-sync-no-downgrade/ (Codex round 1).

type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string };

const fakeLsof = (pid: string, cwd: string): Run => (_cmd, args) => {
  if (args.includes("-t")) return { status: 0, stdout: `${pid}\n` };
  return { status: 0, stdout: `p${pid}\nfcwd\nn${cwd}\n` };
};

describe("listenerCwd", () => {
  it("returns the working directory of the process listening on the port (mac)", () => {
    const cwd = "/Users/me/Library/Application Support/Geekspace/convex";
    expect(listenerCwd(3210, { platform: "darwin", run: fakeLsof("4242", cwd) })).toBe(cwd);
  });

  it("asks lsof about the listener's pid, not the port", () => {
    const calls: string[][] = [];
    const run: Run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return fakeLsof("4242", "/x")(cmd, args);
    };
    listenerCwd(3210, { platform: "darwin", run });
    expect(calls[0]).toEqual(["lsof", "-nP", "-iTCP:3210", "-sTCP:LISTEN", "-t"]);
    expect(calls[1]).toEqual(["lsof", "-a", "-p", "4242", "-d", "cwd", "-Fn"]);
  });

  it("is null when nothing listens", () => {
    const run: Run = () => ({ status: 1, stdout: "" });
    expect(listenerCwd(3210, { platform: "darwin", run })).toBeNull();
  });

  it("is null when more than one process listens (can't tell which one deployed)", () => {
    const run: Run = () => ({ status: 0, stdout: "1\n2\n" });
    expect(listenerCwd(3210, { platform: "darwin", run })).toBeNull();
  });

  it("is null where it can't be determined (Windows), so callers fall back", () => {
    const run: Run = () => {
      throw new Error("must not run");
    };
    expect(listenerCwd(3210, { platform: "win32", run })).toBeNull();
  });
});
