import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SyncError,
  hashRequest,
  readBundle,
  readMarker,
  recordExternalDeploy,
  stripAdminKey,
  syncFunctions,
  writeBundle,
} from "../electron/functionSync.mjs";

// WHAT: a packaged update replays its bundled Convex deploy payload into an existing data
// dir when (and only when) the functions differ, and never half-applies a failed push.
// See docs/changes/2026-10-17-function-sync/ and -function-sync-no-downgrade/.

const URL = "http://127.0.0.1:3210";
const ADMIN_KEY = "test-admin-key-from-data-dir";
const REQUEST = {
  dryRun: false,
  functions: "convex/",
  appDefinition: { changedModules: [{ path: "pages.js", source: "export {}" }], unchangedModuleHashes: [] },
  componentDefinitions: [],
  nodeDependencies: [],
  forCodegen: false,
};
// Commit times (Unix seconds) standing in for what prebake reads from git.
const BUNDLE_ORDINAL = 1_792_245_754;
const DAY_S = 86_400;
const SCHEMA_CHANGE = { allocatedComponentIds: {}, schemaIds: {}, indexDiffs: {} };

type Endpoint = "/api/deploy2/start_push" | "/api/deploy2/wait_for_schema" | "/api/deploy2/finish_push";
type Reply = { status?: number; body: object };
type Replies = { [E in Endpoint]: Reply[] };
// The fields these tests read from what functionSync sends.
type PushBody = { adminKey?: string; appDefinition?: object; schemaChange?: object; startPush?: object };
type Call = { endpoint: string; body: PushBody; authorization: string | null };

const isEndpoint = (path: string): path is Endpoint =>
  path === "/api/deploy2/start_push" || path === "/api/deploy2/wait_for_schema" || path === "/api/deploy2/finish_push";

// A fake backend: answers each endpoint from a queue of replies and records every call.
// The last reply in a queue repeats, so a single "inProgress" polls forever.
function fakeBackend(replies: Replies) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { body: string; headers: { authorization?: string }; signal?: AbortSignal }) => {
    const endpoint = url.slice(URL.length);
    // SAFETY: functionSync serialises a plain object; PushBody lists only optional fields
    // these tests then assert on, so a missing field fails the assertion, not the cast.
    const body = JSON.parse(init.body) as PushBody;
    calls.push({ endpoint, body, authorization: init.headers.authorization ?? null });
    if (!isEndpoint(endpoint)) return new Response("not found", { status: 404 });
    const queue = replies[endpoint];
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { calls, fetchImpl, endpoints: () => calls.map((c) => c.endpoint) };
}

const happyReplies = (): Replies => ({
  "/api/deploy2/start_push": [{ body: { schemaChange: SCHEMA_CHANGE, app: {} } }],
  "/api/deploy2/wait_for_schema": [
    { body: { type: "inProgress", components: {} } },
    { body: { type: "complete" } },
  ],
  "/api/deploy2/finish_push": [{ body: { componentDiffs: {} } }],
});

let root = "";
const dataDir = () => path.join(root, "data");
const bundleDir = () => path.join(root, "bundle");
const logs: string[] = [];
const log = (line: string) => logs.push(line);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fnsync-"));
  fs.mkdirSync(dataDir());
  writeBundle(bundleDir(), stripAdminKey({ ...REQUEST, adminKey: "build-machine-key" }), { convexVersion: "1.46.0", ordinal: BUNDLE_ORDINAL });
  logs.length = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const markerPath = () => path.join(dataDir(), "functions.json");
const writeMarkerFile = (marker: object) => fs.writeFileSync(markerPath(), JSON.stringify(marker));

const sync = (fetchImpl: ReturnType<typeof fakeBackend>["fetchImpl"], extra = {}) =>
  syncFunctions({ dataDir: dataDir(), bundleDir: bundleDir(), url: URL, adminKey: ADMIN_KEY, fetch: fetchImpl, log, ...extra });

describe("bundle", () => {
  it("strips the build machine's admin key and records a hash of exactly what ships", () => {
    const { hash, request } = readBundle(bundleDir());
    expect(request).not.toHaveProperty("adminKey");
    expect(hash).toBe(hashRequest(fs.readFileSync(path.join(bundleDir(), "push-request.json"), "utf8")));
  });

  it("refuses a bundle that still carries an admin key", () => {
    fs.writeFileSync(path.join(bundleDir(), "push-request.json"), JSON.stringify({ ...REQUEST, adminKey: "leaked" }));
    expect(() => readBundle(bundleDir())).toThrow(/admin key/i);
  });

  it("refuses a bundle whose payload does not match its manifest hash", () => {
    fs.writeFileSync(path.join(bundleDir(), "push-request.json"), JSON.stringify({ ...REQUEST, functions: "other/" }));
    expect(() => readBundle(bundleDir())).toThrow(/hash/i);
  });

  it("records the build ordinal in the manifest", () => {
    expect(readBundle(bundleDir()).ordinal).toBe(BUNDLE_ORDINAL);
  });

  it.each([undefined, 0, -1, 1.5, "1792245754"])("refuses to bundle without a positive integer ordinal (%s)", (ordinal) => {
    // SAFETY: deliberately wrong types, to prove the build-time check rejects them.
    const options = { convexVersion: "1.46.0", ordinal } as unknown as { convexVersion: string; ordinal: number };
    expect(() => writeBundle(path.join(root, "bad"), REQUEST, options)).toThrow(/ordinal/i);
  });

  it("reads a manifest from before ordinals as having none", () => {
    const manifest = path.join(bundleDir(), "manifest.json");
    const { hash } = readBundle(bundleDir());
    fs.writeFileSync(manifest, JSON.stringify({ hash, convexVersion: "1.46.0" }));
    expect(readBundle(bundleDir()).ordinal).toBeNull();
  });
});

describe("readMarker", () => {
  it("returns null when there is no marker", () => {
    expect(readMarker(dataDir())).toBeNull();
  });

  it("reads a marker from before ordinals as unknown age", () => {
    writeMarkerFile({ hash: "older-build", deployedAt: "2026-10-17T00:00:00.000Z" });
    expect(readMarker(dataDir())).toEqual({ hash: "older-build", ordinal: null });
  });

  it("reads fields of the wrong type as unknown", () => {
    writeMarkerFile({ hash: 42, ordinal: "tomorrow" });
    expect(readMarker(dataDir())).toEqual({ hash: null, ordinal: null });
  });
});

describe("recordExternalDeploy", () => {
  it("replaces the marker with the deploy's age and no hash, so the next launch redeploys", async () => {
    await sync(fakeBackend(happyReplies()).fetchImpl);
    recordExternalDeploy(dataDir(), BUNDLE_ORDINAL);
    expect(readMarker(dataDir())).toEqual({ hash: null, ordinal: BUNDLE_ORDINAL });
    const again = fakeBackend(happyReplies());
    expect((await sync(again.fetchImpl)).status).toBe("deployed");
  });

  it("works on a data dir that has no marker yet", () => {
    recordExternalDeploy(dataDir(), BUNDLE_ORDINAL);
    expect(readMarker(dataDir())).toEqual({ hash: null, ordinal: BUNDLE_ORDINAL });
  });

  it("refuses an ordinal that isn't a positive integer", () => {
    expect(() => recordExternalDeploy(dataDir(), Number.NaN)).toThrow(/ordinal/i);
    expect(fs.existsSync(markerPath())).toBe(false);
  });
});

describe("syncFunctions", () => {
  it("does nothing when the data dir already runs the bundled functions", async () => {
    const backend = fakeBackend(happyReplies());
    await sync(backend.fetchImpl);
    const again = fakeBackend(happyReplies());
    const result = await sync(again.fetchImpl);
    expect(result.status).toBe("current");
    expect(again.calls).toEqual([]);
  });

  it("deploys start → wait → finish when the marker is missing, then records the hash", async () => {
    const backend = fakeBackend(happyReplies());
    const result = await sync(backend.fetchImpl);
    expect(result.status).toBe("deployed");
    expect(backend.endpoints()).toEqual([
      "/api/deploy2/start_push",
      "/api/deploy2/wait_for_schema",
      "/api/deploy2/wait_for_schema",
      "/api/deploy2/finish_push",
    ]);
    expect(readMarker(dataDir())).toEqual({ hash: readBundle(bundleDir()).hash, ordinal: BUNDLE_ORDINAL });
  });

  it("deploys when the marker names a different build of unknown age", async () => {
    writeMarkerFile({ hash: "older-build" });
    const backend = fakeBackend(happyReplies());
    expect((await sync(backend.fetchImpl)).status).toBe("deployed");
    expect(readMarker(dataDir())).toEqual({ hash: readBundle(bundleDir()).hash, ordinal: BUNDLE_ORDINAL });
  });

  it("authenticates with the data dir's admin key, never one from the bundle", async () => {
    const backend = fakeBackend(happyReplies());
    await sync(backend.fetchImpl);
    for (const call of backend.calls) {
      expect(call.authorization).toBe(`Convex ${ADMIN_KEY}`);
      expect(call.body.adminKey).toBe(ADMIN_KEY);
    }
    expect(backend.calls[0].body.appDefinition).toEqual(REQUEST.appDefinition);
    expect(backend.calls[1].body.schemaChange).toEqual(SCHEMA_CHANGE);
    expect(backend.calls[3].body.startPush).toEqual({ schemaChange: SCHEMA_CHANGE, app: {} });
  });

  it("a failed schema check never finishes the push and leaves the old marker alone", async () => {
    fs.writeFileSync(path.join(dataDir(), "functions.json"), JSON.stringify({ hash: "older-build" }));
    const backend = fakeBackend({
      ...happyReplies(),
      "/api/deploy2/wait_for_schema": [
        { body: { type: "failed", error: "Document does not match schema", tableName: "pages" } },
      ],
    });
    const result = await sync(backend.fetchImpl);
    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(SyncError);
    expect(result.error?.message).toMatch(/pages/);
    expect(result.error?.message).toMatch(/does not match schema/);
    expect(backend.endpoints()).not.toContain("/api/deploy2/finish_push");
    expect(readMarker(dataDir())).toEqual({ hash: "older-build", ordinal: null });
    expect(logs.join("\n")).toMatch(/does not match schema/);
  });

  it("a raced push fails without finishing", async () => {
    const backend = fakeBackend({ ...happyReplies(), "/api/deploy2/wait_for_schema": [{ body: { type: "raceDetected" } }] });
    const result = await sync(backend.fetchImpl);
    expect(result.status).toBe("failed");
    expect(backend.endpoints()).not.toContain("/api/deploy2/finish_push");
    expect(readMarker(dataDir())).toBeNull();
  });

  it("an HTTP error from start_push fails with the backend's message and no marker", async () => {
    const backend = fakeBackend({
      ...happyReplies(),
      "/api/deploy2/start_push": [{ status: 400, body: { code: "BadRequest", message: "invalid module" } }],
    });
    const result = await sync(backend.fetchImpl);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/400/);
    expect(result.error?.message).toMatch(/invalid module/);
    expect(readMarker(dataDir())).toBeNull();
  });

  it("a finish_push error leaves no marker, so the next launch retries", async () => {
    const backend = fakeBackend({ ...happyReplies(), "/api/deploy2/finish_push": [{ status: 500, body: { message: "boom" } }] });
    expect((await sync(backend.fetchImpl)).status).toBe("failed");
    expect(readMarker(dataDir())).toBeNull();
  });

  it("gives up on a schema check that never completes", async () => {
    let clock = 0;
    const backend = fakeBackend({ ...happyReplies(), "/api/deploy2/wait_for_schema": [{ body: { type: "inProgress", components: {} } }] });
    const result = await sync(backend.fetchImpl, { deadlineMs: 30_000, now: () => (clock += 10_000) });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/timed out/i);
    expect(backend.endpoints()).not.toContain("/api/deploy2/finish_push");
    expect(readMarker(dataDir())).toBeNull();
  });

  it("a request that never answers is abandoned at the deadline", async () => {
    // A stalled backend: never resolves, but honours the abort signal like real fetch.
    const hang = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const result = await sync(hang, { deadlineMs: 50 });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/timed out/i);
    expect(readMarker(dataDir())).toBeNull();
  });

  it("a network failure is reported, not thrown", async () => {
    const result = await sync(async () => {
      throw new TypeError("fetch failed");
    });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/fetch failed/);
  });

  it("a missing bundle is skipped with a log line, not treated as a failure", async () => {
    fs.rmSync(bundleDir(), { recursive: true });
    const backend = fakeBackend(happyReplies());
    const result = await sync(backend.fetchImpl);
    expect(result.status).toBe("skipped");
    expect(backend.calls).toEqual([]);
    expect(logs.join("\n")).toMatch(/no bundled functions/i);
  });

  it("a data dir without an admin key fails with a clear message instead of a 401", async () => {
    const backend = fakeBackend(happyReplies());
    const result = await sync(backend.fetchImpl, { adminKey: undefined });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/admin key/i);
    expect(backend.calls).toEqual([]);
  });

  it("a packaged app missing its bundle fails loudly", async () => {
    fs.rmSync(bundleDir(), { recursive: true });
    const result = await sync(fakeBackend(happyReplies()).fetchImpl, { requireBundle: true });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/no bundled functions/i);
  });
});

describe("syncFunctions ordering", () => {
  it("treats the same hash as current whatever the ordinals say", async () => {
    writeMarkerFile({ hash: readBundle(bundleDir()).hash, ordinal: BUNDLE_ORDINAL + DAY_S });
    const backend = fakeBackend(happyReplies());
    expect((await sync(backend.fetchImpl)).status).toBe("current");
    expect(backend.calls).toEqual([]);
  });

  it("deploys a newer bundle and records its ordinal", async () => {
    writeMarkerFile({ hash: "older-build", ordinal: BUNDLE_ORDINAL - DAY_S });
    const backend = fakeBackend(happyReplies());
    expect((await sync(backend.fetchImpl)).status).toBe("deployed");
    expect(readMarker(dataDir())).toEqual({ hash: readBundle(bundleDir()).hash, ordinal: BUNDLE_ORDINAL });
  });

  it("deploys a different bundle of the same age", async () => {
    writeMarkerFile({ hash: "same-commit-dirty-tree", ordinal: BUNDLE_ORDINAL });
    const backend = fakeBackend(happyReplies());
    expect((await sync(backend.fetchImpl)).status).toBe("deployed");
  });

  it("refuses an older bundle: no deploy, marker untouched, both ordinals reported", async () => {
    writeMarkerFile({ hash: "newer-build", ordinal: BUNDLE_ORDINAL + DAY_S });
    const before = fs.readFileSync(markerPath(), "utf8");
    const backend = fakeBackend(happyReplies());
    const result = await sync(backend.fetchImpl);
    expect(result).toMatchObject({ status: "downgrade", bundleOrdinal: BUNDLE_ORDINAL, liveOrdinal: BUNDLE_ORDINAL + DAY_S });
    expect(backend.calls).toEqual([]);
    expect(fs.readFileSync(markerPath(), "utf8")).toBe(before);
    expect(logs.join("\n")).toMatch(/older/i);
  });

  it("refuses a bundle older than what deploy:local pushed", async () => {
    recordExternalDeploy(dataDir(), BUNDLE_ORDINAL + 1);
    const backend = fakeBackend(happyReplies());
    expect((await sync(backend.fetchImpl)).status).toBe("downgrade");
    expect(backend.calls).toEqual([]);
  });

  it("refuses a bundle from before ordinals once the data dir runs one that has an ordinal", async () => {
    const { hash } = readBundle(bundleDir());
    fs.writeFileSync(path.join(bundleDir(), "manifest.json"), JSON.stringify({ hash, convexVersion: "1.46.0" }));
    writeMarkerFile({ hash: "newer-build", ordinal: BUNDLE_ORDINAL });
    const backend = fakeBackend(happyReplies());
    expect((await sync(backend.fetchImpl)).status).toBe("downgrade");
    expect(backend.calls).toEqual([]);
  });

  it("deploys a bundle from before ordinals onto a data dir of unknown age, as before", async () => {
    const { hash } = readBundle(bundleDir());
    fs.writeFileSync(path.join(bundleDir(), "manifest.json"), JSON.stringify({ hash, convexVersion: "1.46.0" }));
    writeMarkerFile({ hash: "older-build" });
    expect((await sync(fakeBackend(happyReplies()).fetchImpl)).status).toBe("deployed");
  });

  it("deploys an older bundle when the downgrade is forced, and records the older ordinal", async () => {
    writeMarkerFile({ hash: "newer-build", ordinal: BUNDLE_ORDINAL + DAY_S });
    const backend = fakeBackend(happyReplies());
    expect((await sync(backend.fetchImpl, { allowDowngrade: true })).status).toBe("deployed");
    expect(readMarker(dataDir())).toEqual({ hash: readBundle(bundleDir()).hash, ordinal: BUNDLE_ORDINAL });
    expect(logs.join("\n")).toMatch(/forced/i);
  });
});
