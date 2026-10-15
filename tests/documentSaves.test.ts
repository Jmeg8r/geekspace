import { describe, expect, it } from "vitest";
import { attachDocumentSaves } from "../src/lib/documentSaves";
import { mustResave } from "../src/lib/incomingContent";

// Codex review of PR #51, round 2. See docs/changes/2026-10-15-editor-saves/.

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("attachDocumentSaves", () => {
  // [P1] Leaving a page mid-save and reopening it must not create a second queue whose
  // older pending value lands after the reopened editor's newer one.
  it("shares one queue per document across mounts, so a newer edit supersedes an older pending one", async () => {
    const sent: string[] = [];
    const slow = gate();
    const save = async (value: string) => {
      sent.push(value);
      if (value === "A") await slow.promise;
    };
    const first = attachDocumentSaves("doc-shared", { save });
    first.queue.enqueue("A");
    first.queue.enqueue("B");
    first.detach();

    const second = attachDocumentSaves("doc-shared", { save });
    expect(second.queue).toBe(first.queue);
    second.queue.enqueue("C");
    slow.open();
    await second.queue.flush();
    await second.queue.flush();
    expect(sent).toEqual(["A", "C"]);
    second.detach();
  });

  it("reports saves to the editor that is mounted now, not the one that left", async () => {
    const seen: string[] = [];
    const save = async () => {};
    const first = attachDocumentSaves("doc-hooks", { save, saved: (v) => seen.push(`old:${v}`) });
    first.detach();
    const second = attachDocumentSaves("doc-hooks", { save, saved: (v) => seen.push(`new:${v}`) });
    second.queue.enqueue("X");
    await second.queue.flush();
    expect(seen).toEqual(["new:X"]);
    second.detach();
  });

  // Codex round 3 [P2]: a reopened editor must see that its document's saves are failing.
  it("replays a failed save to an editor that attaches later", async () => {
    const reports: Array<string | null> = [];
    const first = attachDocumentSaves("doc-failed", {
      save: () => Promise.reject(new Error("backend said no")),
    });
    first.queue.enqueue("lost?");
    await first.queue.flush();
    first.detach();
    const second = attachDocumentSaves("doc-failed", {
      save: () => Promise.resolve(),
      report: (e) => reports.push(e),
    });
    expect(reports).toEqual(["Error: backend said no"]);
    await second.queue.flush();
    expect(reports.at(-1)).toBeNull();
    expect(second.queue.hasUnsaved()).toBe(false);
    second.detach();
  });

  it("exposes the value in flight, so its echo is recognised by a new mount", async () => {
    const slow = gate();
    const handle = attachDocumentSaves("doc-flight", { save: () => slow.promise });
    handle.queue.enqueue("V");
    expect(handle.queue.inFlight()).toBe("V");
    slow.open();
    await handle.queue.flush();
    expect(handle.queue.inFlight()).toBeUndefined();
    handle.detach();
  });
});

describe("mustResave", () => {
  // [P1] "Load latest" must persist the chosen copy when a local save already overwrote it.
  it("re-saves the chosen copy when the server now holds something else", () => {
    expect(mustResave({ chosen: "external", serverNow: "local", saving: false })).toBe(true);
  });
  it("re-saves while a save is still in flight, which may land after the choice", () => {
    expect(mustResave({ chosen: "external", serverNow: "external", saving: true })).toBe(true);
  });
  it("does nothing when the server already holds the chosen copy and nothing is in flight", () => {
    expect(mustResave({ chosen: "external", serverNow: "external", saving: false })).toBe(false);
  });
});
