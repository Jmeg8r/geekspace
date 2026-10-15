import { describe, expect, it } from "vitest";
import { decideIncoming } from "../src/lib/incomingContent";

// WHAT: what the open editor does when the server's copy of its document changes.
// WHY: the editor used to parse its content once, so writes from ARCHITECT, MCP or a
// meeting re-run were never shown and the next autosave overwrote them.
// See docs/changes/2026-10-15-editor-saves/.

describe("decideIncoming", () => {
  it("ignores the echo of the editor's own save", () => {
    expect(decideIncoming({ incoming: "A", lastSynced: "A", dirty: false })).toBe("ignore");
    expect(decideIncoming({ incoming: "A", lastSynced: "A", dirty: true })).toBe("ignore");
  });

  it("applies an external change when there are no unsaved edits", () => {
    expect(decideIncoming({ incoming: "B", lastSynced: "A", dirty: false })).toBe("apply");
  });

  it("asks when an external change meets unsaved edits", () => {
    expect(decideIncoming({ incoming: "B", lastSynced: "A", dirty: true })).toBe("ask");
  });

  it("treats a missing document body as empty, not as a change", () => {
    expect(decideIncoming({ incoming: undefined, lastSynced: undefined, dirty: false })).toBe(
      "ignore"
    );
  });
});
