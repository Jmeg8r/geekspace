import { expect, it, vi } from "vitest";
import { createSaveQueue } from "../src/lib/saveQueue";
it("serializes pending edits behind a slow save", async () => {
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const values: string[] = [];
  const save = async (value: string) => {
    values.push(value);
    if (value === "first") await waiting;
  };
  const queue = createSaveQueue(save, () => {});
  queue.enqueue("first");
  queue.enqueue("second");
  queue.enqueue("latest");
  expect(values).toEqual(["first"]);
  finish();
  await queue.flush();
  expect(values).toEqual(["first", "latest"]);
  expect(queue.hasUnsaved()).toBe(false);
});
it("retains the latest edit after failure until a successful retry", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const report = vi.fn();
  const queue = createSaveQueue(save, report);
  queue.enqueue("first");
  await queue.flush();
  expect(queue.hasUnsaved()).toBe(true);
  queue.enqueue("latest");
  await queue.flush();
  expect(save.mock.calls.map((args) => args[0])).toEqual(["first", "latest"]);
  expect(report).toHaveBeenLastCalledWith(null);
});

it("keeps a newer recovery draft when an older save completes", async () => {
  const { acknowledgeDraft, retainDraft, draftKey } =
    await import("../src/lib/editorDraft");
  const values = new Map<string, string>();
  const storage: Storage = {
    length: 0,
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
  retainDraft(storage, "fixture", "newer");
  acknowledgeDraft(storage, "fixture", "older");
  expect(storage.getItem(draftKey("fixture"))).toBe("newer");
  acknowledgeDraft(storage, "fixture", "newer");
  expect(storage.getItem(draftKey("fixture"))).toBeNull();
});
