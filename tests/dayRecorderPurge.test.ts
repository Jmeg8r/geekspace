import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RETENTION_DAYS as CONVEX_RETENTION_DAYS } from "../convex/lib/dayRecorder";
import {
  RETENTION_DAYS,
  ensureMediaRoot,
  localDay,
  purgeExpired,
  resolveMediaPath,
  type ExpiredMedia,
  type PurgeMarks,
} from "../electron/dayRecorderMedia.mjs";

// WHAT: the main-process half of retention (spec R14, plan PR 3c). Convex picks the rows
// past 30 days (tests/dayRecorderData.test.ts); this deletes their files, and sweeps day
// folders past retention for files no row names (a crash's `.partial-*`, a shot written
// but never announced). WHY the guard tests: the purge is the one code path that deletes
// files, so every path is resolved and must stay inside the media root first.

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();
const d31 = localDay(NOW - 31 * DAY);
const d29 = localDay(NOW - 29 * DAY);

let base: string;
let root: string;
let outside: string;
const logs: string[] = [];

function write(rel: string, text = "SYNTHETIC media") {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const exists = (rel: string) => fs.existsSync(path.join(root, rel));

/** A fake Convex side: serves the given rows a page at a time and records what was marked. */
function convexSide(pages: ExpiredMedia[]) {
  const marked: PurgeMarks[] = [];
  let served = 0;
  return {
    marked,
    listExpired: async () => pages[served++] ?? { segments: [], screenshots: [] },
    markPurged: async (marks: PurgeMarks) => void marked.push(marks),
  };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gs-purge-"));
  root = ensureMediaRoot(path.join(base, "day-recorder"));
  outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "escape.txt"), "must survive");
  logs.length = 0;
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const run = (side: ReturnType<typeof convexSide>) =>
  purgeExpired({ root, now: NOW, ...side, log: (m) => logs.push(m) });

it("keeps the same retention as the Convex side that picks the rows", () => {
  expect(RETENTION_DAYS).toBe(CONVEX_RETENTION_DAYS);
});

describe("ensureMediaRoot", () => {
  it("creates the root private to the user and returns its real path", () => {
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(root).toBe(fs.realpathSync(root));
  });
});

describe("resolveMediaPath", () => {
  it("resolves a <day>/<file> path inside the root", () => {
    write(`${d31}/shot-1.heic`);
    expect(resolveMediaPath(root, `${d31}/shot-1.heic`)).toBe(path.join(root, d31, "shot-1.heic"));
  });

  it.each([
    ["a parent hop", "../outside/escape.txt"],
    ["a hop inside the day", `${d31}/../../outside/escape.txt`],
    ["an absolute path", "/etc/hosts"],
    ["a nested path", `${d31}/a/b.heic`],
    ["a hidden file", `${d31}/.partial-x.m4a`],
    ["no day folder", "shot-1.heic"],
  ])("refuses %s", (_name, rel) => {
    expect(() => resolveMediaPath(root, rel)).toThrow(/outside the media root|media path/);
  });

  it("refuses a day folder that is a symlink out of the root", () => {
    fs.symlinkSync(outside, path.join(root, d31));
    expect(() => resolveMediaPath(root, `${d31}/escape.txt`)).toThrow(/outside the media root/);
  });
});

describe("purgeExpired", () => {
  it("deletes the files of expired rows and marks them, leaving 29-day media alone", async () => {
    write(`${d31}/shot-1.heic`);
    write(`${d31}/sys-1.m4a`);
    write(`${d29}/shot-2.heic`);
    const side = convexSide([
      {
        screenshots: [{ _id: "shot31", path: `${d31}/shot-1.heic` }],
        segments: [{ _id: "seg31", path: `${d31}/sys-1.m4a` }],
      },
    ]);
    const result = await run(side);
    expect(exists(`${d31}/shot-1.heic`)).toBe(false);
    expect(exists(`${d31}/sys-1.m4a`)).toBe(false);
    expect(exists(`${d29}/shot-2.heic`)).toBe(true);
    expect(side.marked).toEqual([{ screenshotIds: ["shot31"], segmentIds: ["seg31"], at: NOW }]);
    expect(result).toMatchObject({ deleted: 2, missing: 0, refused: 0 });
  });

  it("marks a row whose file is already gone", async () => {
    const side = convexSide([{ screenshots: [{ _id: "gone", path: `${d31}/shot-9.heic` }], segments: [] }]);
    const result = await run(side);
    expect(side.marked).toEqual([{ screenshotIds: ["gone"], segmentIds: [], at: NOW }]);
    expect(result).toMatchObject({ deleted: 0, missing: 1 });
  });

  it("refuses rows that point outside the root, never marks them, and stops paging", async () => {
    const side = convexSide([
      {
        screenshots: [
          { _id: "evil1", path: "../outside/escape.txt" },
          { _id: "evil2", path: `${d31}/../../outside/escape.txt` },
        ],
        segments: [{ _id: "evil3", path: "/etc/hosts" }],
      },
      // Served again if the loop kept paging over rows it can never mark.
      { screenshots: [{ _id: "evil1", path: "../outside/escape.txt" }], segments: [] },
    ]);
    const result = await run(side);
    expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(true);
    expect(side.marked).toEqual([]);
    expect(result).toMatchObject({ deleted: 0, refused: 3 });
    expect(logs.join("\n")).toMatch(/evil1/);
  });

  it("pages until Convex has nothing left", async () => {
    write(`${d31}/shot-1.heic`);
    write(`${d31}/shot-2.heic`);
    const side = convexSide([
      { screenshots: [{ _id: "a", path: `${d31}/shot-1.heic` }], segments: [] },
      { screenshots: [{ _id: "b", path: `${d31}/shot-2.heic` }], segments: [] },
    ]);
    const result = await run(side);
    expect(side.marked.map((m) => m.screenshotIds)).toEqual([["a"], ["b"]]);
    expect(result.deleted).toBe(2);
  });

  it("sweeps day folders past retention, orphans and partial files included", async () => {
    write(`${d31}/.partial-sys-1.m4a`);
    write(`${d31}/shot-orphan.heic`);
    write(`${d29}/.partial-sys-2.m4a`);
    write("claude-key.enc", "SYNTHETIC key blob");
    fs.mkdirSync(path.join(root, "notes"));
    const result = await run(convexSide([]));
    expect(exists(d31)).toBe(false);
    expect(exists(`${d29}/.partial-sys-2.m4a`)).toBe(true);
    expect(exists("claude-key.enc")).toBe(true);
    expect(exists("notes")).toBe(true);
    expect(result.sweptDays).toBe(1);
  });

  it("keeps the folder of the day that is only partly past retention", async () => {
    const d30 = localDay(NOW - 30 * DAY);
    write(`${d30}/shot-late.heic`);
    await run(convexSide([]));
    expect(exists(`${d30}/shot-late.heic`)).toBe(true);
  });

  it("never follows a symlinked day folder when sweeping", async () => {
    fs.symlinkSync(outside, path.join(root, d31));
    await run(convexSide([]));
    expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(true);
  });

  it("logs counts only, never paths", async () => {
    write(`${d31}/shot-1.heic`);
    await run(convexSide([{ screenshots: [{ _id: "a", path: `${d31}/shot-1.heic` }], segments: [] }]));
    expect(logs.join("\n")).not.toContain("shot-1.heic");
    expect(logs.join("\n")).toMatch(/deleted 1/);
  });
});
