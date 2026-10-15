import { describe, expect, it, vi } from "vitest";
import { createSaveQueue } from "../src/lib/saveQueue";
import { acknowledgeDraft, draftKey, retainDraft } from "../src/lib/editorDraft";

// Ported from PR #28 (tests/saveQueue.test.ts), plus the in-order case.
// See docs/changes/2026-10-15-editor-saves/.

describe("createSaveQueue", () => {
  it("serializes pending edits behind a slow save and sends only the latest", async () => {
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const values: string[] = [];
    const queue = createSaveQueue(async (value) => {
      values.push(value);
      if (value === "first") await waiting;
    }, () => {});
    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("latest");
    expect(values).toEqual(["first"]);
    finish();
    await queue.flush();
    expect(values).toEqual(["first", "latest"]);
    expect(queue.hasUnsaved()).toBe(false);
  });

  it("never lets an older save finish after a newer one", async () => {
    const finished: string[] = [];
    const queue = createSaveQueue(async (value) => {
      await new Promise((r) => setTimeout(r, value === "older" ? 20 : 0));
      finished.push(value);
    }, () => {});
    queue.enqueue("older");
    queue.enqueue("newer");
    await queue.flush();
    await queue.flush();
    expect(finished).toEqual(["older", "newer"]);
  });

  it("retains the latest edit after a failure until a successful retry", async () => {
    const save = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const report = vi.fn();
    const queue = createSaveQueue(save, report);
    queue.enqueue("first");
    await queue.flush();
    expect(queue.hasUnsaved()).toBe(true);
    expect(report).toHaveBeenLastCalledWith("Error: offline");
    queue.enqueue("latest");
    await queue.flush();
    expect(save.mock.calls.map((args) => args[0])).toEqual(["first", "latest"]);
    expect(report).toHaveBeenLastCalledWith(null);
    expect(queue.hasUnsaved()).toBe(false);
  });

  // Codex review of PR #51 [P1]: a value already queued behind an active save must not be
  // sent while a conflict is open, and Retry must not send it either.
  it("holds queued values until released, including through flush", async () => {
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sent: string[] = [];
    const queue = createSaveQueue(async (value) => {
      sent.push(value);
      if (value === "active") await waiting;
    }, () => {});
    queue.enqueue("active");
    queue.enqueue("queued");
    queue.hold();
    finish();
    await queue.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["active"]);
    expect(queue.hasUnsaved()).toBe(true);

    queue.release();
    await queue.flush();
    expect(sent).toEqual(["active", "queued"]);
    expect(queue.hasUnsaved()).toBe(false);
  });

  it("drops a held value when told to", async () => {
    const sent: string[] = [];
    const queue = createSaveQueue(async (value) => {
      sent.push(value);
    }, () => {});
    queue.hold();
    queue.enqueue("stale");
    queue.discardPending();
    queue.release();
    await queue.flush();
    expect(sent).toEqual([]);
    expect(queue.hasUnsaved()).toBe(false);
  });
});

describe("editor recovery drafts", () => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
      key: () => null,
    };
  }

  it("keeps a newer draft when an older save is acknowledged", () => {
    const storage = memoryStorage();
    retainDraft(storage, "doc", "newer");
    acknowledgeDraft(storage, "doc", "older");
    expect(storage.getItem(draftKey("doc"))).toBe("newer");
    acknowledgeDraft(storage, "doc", "newer");
    expect(storage.getItem(draftKey("doc"))).toBeNull();
  });
});
