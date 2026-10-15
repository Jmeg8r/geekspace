import { createSaveQueue } from "./saveQueue";

// WHAT: one save queue per document for the life of the window, shared by every editor
// mount of that document. Saves report to whichever editor is mounted now.
// WHY: a per-mount queue keeps draining after its editor unmounts, so leaving a page
// mid-save and reopening it ran two queues side by side, and an older pending value could
// land after a newer one (Codex review of PR #51). See docs/changes/2026-10-15-editor-saves/.

export type DocumentSaveHooks = {
  save: (value: string) => Promise<void>;
  saved?: (value: string) => void;
  report?: (error: string | null) => void;
};

type Entry = {
  queue: ReturnType<typeof createSaveQueue>;
  hooks: DocumentSaveHooks;
  mounts: number;
};

const entries = new Map<string, Entry>();

function createEntry(hooks: DocumentSaveHooks): Entry {
  const entry: Entry = {
    hooks,
    mounts: 0,
    queue: createSaveQueue(
      async (value) => {
        await entry.hooks.save(value);
        entry.hooks.saved?.(value);
      },
      (error) => entry.hooks.report?.(error)
    ),
  };
  return entry;
}

export function attachDocumentSaves(documentId: string, hooks: DocumentSaveHooks) {
  const entry = entries.get(documentId) ?? createEntry(hooks);
  entries.set(documentId, entry);
  entry.hooks = hooks;
  entry.mounts += 1;
  return {
    queue: entry.queue,
    detach() {
      entry.mounts -= 1;
      if (entry.mounts > 0) return;
      // Keep sending what is queued; stop reporting to the editor that left.
      entry.hooks = { save: hooks.save };
      if (!entry.queue.hasUnsaved()) entries.delete(documentId);
    },
  };
}
