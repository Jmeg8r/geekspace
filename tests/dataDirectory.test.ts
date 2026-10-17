import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedDataDirectory } from "../electron/dataDirectory.mjs";

// WHAT: first launch copies the bundled seed into place whole or not at all.
// See docs/changes/2026-10-16-electron-sync/.

let root = "";
const seed = () => path.join(root, "seed");
const dest = () => path.join(root, "data", "convex");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-seed-"));
  fs.mkdirSync(path.join(seed(), "storage"), { recursive: true });
  fs.writeFileSync(path.join(seed(), "config.json"), JSON.stringify({ deploymentName: "fixture" }));
  fs.writeFileSync(path.join(seed(), "convex_local_backend.sqlite3"), "sqlite fixture");
  fs.writeFileSync(path.join(seed(), "storage", "blob"), "blob");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const leftovers = () => fs.readdirSync(path.dirname(dest())).filter((n) => n !== path.basename(dest()));

describe("seedDataDirectory", () => {
  it("copies the whole seed into place and leaves no staging directory", () => {
    expect(seedDataDirectory(seed(), dest())).toBe(true);
    expect(fs.readFileSync(path.join(dest(), "storage", "blob"), "utf8")).toBe("blob");
    expect(fs.existsSync(path.join(dest(), "convex_local_backend.sqlite3"))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("does nothing when the data directory already exists", () => {
    seedDataDirectory(seed(), dest());
    fs.writeFileSync(path.join(dest(), "mine"), "user data");
    expect(seedDataDirectory(seed(), dest())).toBe(false);
    expect(fs.readFileSync(path.join(dest(), "mine"), "utf8")).toBe("user data");
  });

  it("an interrupted copy leaves no data directory, so the next launch retries", () => {
    // A copy that dies partway: it writes one file into the staging dir, then throws.
    const failingCopy = (_from: string, to: string) => {
      fs.mkdirSync(to, { recursive: true });
      fs.writeFileSync(path.join(to, "config.json"), "{}");
      throw new Error("disk full (simulated)");
    };
    expect(() => seedDataDirectory(seed(), dest(), { copy: failingCopy })).toThrow(/disk full/);
    expect(fs.existsSync(dest())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a seed without its database file", () => {
    fs.rmSync(path.join(seed(), "convex_local_backend.sqlite3"));
    expect(() => seedDataDirectory(seed(), dest())).toThrow(/sqlite3/);
    expect(fs.existsSync(dest())).toBe(false);
  });

  it("moves a half-seeded directory from the old copy aside, then seeds fresh", () => {
    fs.mkdirSync(dest(), { recursive: true });
    fs.writeFileSync(path.join(dest(), "convex_local_backend.sqlite3"), "partial");
    expect(seedDataDirectory(seed(), dest())).toBe(true);
    expect(fs.existsSync(path.join(dest(), "config.json"))).toBe(true);
    const aside = leftovers().filter((n) => n.startsWith("convex.incomplete-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(dest()), aside[0], "convex_local_backend.sqlite3"), "utf8")).toBe("partial");
  });

  it("refuses a seed without config.json", () => {
    fs.rmSync(path.join(seed(), "config.json"));
    expect(() => seedDataDirectory(seed(), dest())).toThrow(/config\.json/);
    expect(fs.existsSync(dest())).toBe(false);
  });
});
