import { describe, expect, it } from "vitest";
import { describeCtlError, judgeSoak, processRole, safeSettings, soakSchedule, type SoakRow } from "../scripts/lib/dayRecorderTools.mjs";

// WHAT: the decisions behind the PR 3c part 2 tools (scripts/day-recorder-ctl.mjs and
// scripts/soak-rss.mjs). WHY tested: the ctl script's output lands in terminals and evidence
// logs, where a denylisted app must never be named (protocol.md), and a soak verdict that can
// pass without the helper running proves nothing (Codex review of #80, final check).

describe("safeSettings", () => {
  it("reports the denylist as a count, never its bundle ids", () => {
    const out = safeSettings({
      enabled: true,
      denylist: ["com.example.private-one", "com.example.private-two"],
      shotSec: 30,
      batchMin: 15,
      dailyCapUsd: null,
    });
    expect(out).toEqual({ enabled: true, denylistCount: 2, shotSec: 30, batchMin: 15, dailyCapSet: false });
    expect(JSON.stringify(out)).not.toMatch(/com\.example/);
  });
});

describe("describeCtlError", () => {
  it("says the backend is down without echoing anything", () => {
    expect(describeCtlError(new TypeError("fetch failed"), "http://127.0.0.1:3210")).toMatch(
      /no Geekspace backend at http:\/\/127\.0\.0\.1:3210/
    );
  });

  it("never echoes a backend error's message, which can carry submitted bundle ids", () => {
    const err = Object.assign(new Error("ArgumentValidationError: denylist [com.example.private-one]"), {
      name: "ConvexError",
    });
    const text = describeCtlError(err, "http://127.0.0.1:3210");
    expect(text).not.toMatch(/com\.example/);
    expect(text).toMatch(/ConvexError/);
  });
});

const row = (elapsedMin: number, byRole: Record<string, number>, helperPids: number[]): SoakRow => ({
  elapsedMin,
  byRole,
  helperPids,
  shots: 0,
  segments: 0,
  partials: 0,
});

describe("judgeSoak", () => {
  const opts = { warmupMinutes: 10, limitMB: 50 };

  it("passes a steady run with one helper throughout", () => {
    const rows = [0, 5, 10, 15, 20].map((m) => row(m, { helper: 100 + m * 0.1, main: 200 }, [42]));
    const v = judgeSoak(rows, opts);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it("fails when the helper vanishes partway, even if it was seen once", () => {
    const rows = [row(0, { helper: 100, main: 200 }, [42]), ...[5, 10, 15].map((m) => row(m, { main: 200 }, []))];
    const v = judgeSoak(rows, opts);
    expect(v.pass).toBe(false);
    expect(v.failures.join(" ")).toMatch(/gs-capture missing in 3 of 4 samples/);
  });

  it("fails when there is no helper or app at the warmup mark to measure from", () => {
    const rows = [row(0, { helper: 100, main: 200 }, [42]), row(10, {}, []), row(20, {}, [])];
    const v = judgeSoak(rows, opts);
    expect(v.pass).toBe(false);
    expect(v.failures.join(" ")).toMatch(/no baseline at the warmup mark/);
  });

  it("fails on growth over the limit and on a helper restart", () => {
    const rows = [row(0, { helper: 100 }, [1]), row(10, { helper: 100 }, [1]), row(20, { helper: 160 }, [2])];
    const v = judgeSoak(rows, opts);
    expect(v.failures).toEqual(expect.arrayContaining(["helper grew 60 MB", "gs-capture restarted (2 pids)"]));
  });
});

// Codex re-check of #80: the formatter alone missed two paths. The Convex client logged the
// backend's logLines itself before the handler ran, and a backend message starting "--" was
// taken for the script's own error. So the real script runs against a fake backend here.
describe("day-recorder-ctl, the real script against a fake backend", () => {
  const SECRET = "com.example.private-one";

  async function runCtl(args: string[], respond: (path: string) => object) {
    const { createServer } = await import("node:http");
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respond(req.url ?? "")));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    // SAFETY: listen() on a TCP host and port gives an AddressInfo, never a pipe path or null.
    const port = (server.address() as { port: number }).port;
    try {
      return await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "day-recorder-ctl.mjs"), ...args], {
          env: { ...process.env, CONVEX_URL: `http://127.0.0.1:${port}` },
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
      });
    } finally {
      server.close();
    }
  }

  it("prints neither the backend's log lines nor an error message that names a denylisted app", async () => {
    const { code, out } = await runCtl(["on", "--denylist", SECRET], () => ({
      status: "error",
      errorMessage: `--denylist rejected ${SECRET}`,
      logLines: [`[ERROR] denylist [${SECRET}]`],
    }));
    expect(code).toBe(1);
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/details withheld/);
  });

  it("prints the settings with the denylist as a count", async () => {
    const { code, out } = await runCtl(["settings"], () => ({
      status: "success",
      value: { enabled: true, denylist: [SECRET], shotSec: 30, batchMin: 15, dailyCapUsd: null },
      logLines: [`[LOG] read ${SECRET}`],
    }));
    expect(code).toBe(0);
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/"denylistCount": 1/);
  });

  it("still prints its own usage errors", async () => {
    const { code, out } = await runCtl(["bogus"], () => ({ status: "success", value: null, logLines: [] }));
    expect(code).toBe(1);
    expect(out).toMatch(/usage: day-recorder-ctl/);
  });
});

describe("soakSchedule", () => {
  it("ends with a sample taken at the end of the run, not one interval before it", () => {
    // Codex re-check of #80: the last sample came 30 s before the end, so a helper that died
    // in that window still passed.
    const times = soakSchedule(120 * 60_000, 30_000);
    expect(times.at(-1)).toBe(120 * 60_000);
    expect(times[0]).toBe(0);
    expect(times).toHaveLength(241);
  });

  it("keeps the final sample when the interval doesn't divide the run", () => {
    expect(soakSchedule(100_000, 30_000)).toEqual([0, 30_000, 60_000, 90_000, 100_000]);
  });
});

describe("processRole", () => {
  // Codex re-check round 3 of #80: any gs-capture counted as the helper, so a stray
  // diagnostic run could pass a soak with Geekspace stopped.
  const APP = "/Volumes/x/release/mac-arm64/Geekspace.app";
  it.each([
    [`${APP}/Contents/Resources/gs-capture`, "helper"],
    [`${APP}/Contents/MacOS/Geekspace`, "main"],
    [`${APP}/Contents/Frameworks/Geekspace Helper (Renderer).app/Contents/MacOS/Geekspace Helper (Renderer)`, "renderer"],
    [`${APP}/Contents/Resources/convex-local-backend`, "backend"],
    ["/Volumes/x/native/gs-capture/.build/release/gs-capture", null],
    ["gs-capture", null],
    ["/usr/bin/top", null],
  ])("classifies %s as %s", (comm, expected) => {
    expect(processRole(comm)).toBe(expected);
  });
});
