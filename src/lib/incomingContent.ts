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

// After the user picks a version in a conflict, does it still have to be written? Yes if
// the server now holds something else (a local save landed meanwhile), or if a save is
// still in flight and may land after the choice.
export function mustResave({
  chosen,
  serverNow,
  saving,
}: {
  chosen: string | undefined;
  serverNow: string | undefined;
  saving: boolean;
}): boolean {
  return saving || (chosen ?? "") !== (serverNow ?? "");
}
