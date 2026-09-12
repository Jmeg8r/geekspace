// Acknowledged saves remove only their own draft; a newer edit must survive.
export const draftKey = (documentId: string) =>
  `geekspace:editor-draft:v1:${documentId}`;
export function retainDraft(
  storage: Storage,
  documentId: string,
  content: string,
) {
  storage.setItem(draftKey(documentId), content);
}
export function acknowledgeDraft(
  storage: Storage,
  documentId: string,
  saved: string,
) {
  const key = draftKey(documentId);
  if (storage.getItem(key) === saved) storage.removeItem(key);
}
