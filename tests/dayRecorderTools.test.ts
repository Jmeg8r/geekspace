import { describe, expect, it } from "vitest";
import { describeCtlError, judgeSoak, safeSettings, type SoakRow } from "../scripts/lib/dayRecorderTools.mjs";

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
