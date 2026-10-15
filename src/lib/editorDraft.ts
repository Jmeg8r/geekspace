// WHAT: per-document recovery drafts in this browser's storage, written on every edit
// and cleared once that exact value is saved. A save acknowledges only its own value, so
// a newer draft survives an older save completing. Ported from PR #28.
export const draftKey = (documentId: string) => `geekspace:editor-draft:v1:${documentId}`;

export function retainDraft(storage: Storage, documentId: string, content: string) {
  storage.setItem(draftKey(documentId), content);
}

export function acknowledgeDraft(storage: Storage, documentId: string, saved: string) {
  const key = draftKey(documentId);
  if (storage.getItem(key) === saved) storage.removeItem(key);
}

export function readDraft(storage: Storage, documentId: string): string | null {
  return storage.getItem(draftKey(documentId));
}

export function discardDraft(storage: Storage, documentId: string) {
  storage.removeItem(draftKey(documentId));
}
