// WHAT: what an open editor does when the server's copy of its document changes.
// `lastSynced` is the last value the editor loaded or saved, so the echo of its own save
// compares equal and is ignored. See docs/changes/2026-10-15-editor-saves/.
export type IncomingAction = "ignore" | "apply" | "ask";

export function decideIncoming({
  incoming,
  lastSynced,
  dirty,
}: {
  incoming: string | undefined;
  lastSynced: string | undefined;
  dirty: boolean;
}): IncomingAction {
  if ((incoming ?? "") === (lastSynced ?? "")) return "ignore";
  return dirty ? "ask" : "apply";
}
