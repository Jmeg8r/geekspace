import { describe, expect, it } from "vitest";
import {
  ONBOARDING,
  UNSUPPORTED,
  addBundleId,
  createListEditor,
  recorderSupported,
  removeBundleId,
  shotSecError,
} from "../src/lib/dayRecorderSettings";

// WHAT: the Day Recorder Settings section's rules (plan PR 3e-2). WHY tested: the denylist
// decides which apps are never captured (R4), so the editor must refuse what the server would
// refuse, with the server's own words, and never lose an entry already on the list.

describe("addBundleId", () => {
  it("adds a trimmed, valid bundle id", () => {
    expect(addBundleId(["com.apple.Mail"], "  com.apple.TextEdit ")).toEqual({
      ok: true,
      list: ["com.apple.Mail", "com.apple.TextEdit"],
    });
  });

  it("asks for an id when the field is empty", () => {
    expect(addBundleId([], "   ")).toEqual({ ok: false, error: "Enter an app bundle id, like com.apple.TextEdit." });
  });

  it("refuses an invalid id with the server's own message", () => {
    expect(addBundleId([], "not a bundle id")).toEqual({ ok: false, error: 'Invalid app bundle id "not a bundle id"' });
  });

  it("refuses a duplicate", () => {
    expect(addBundleId(["com.apple.TextEdit"], "com.apple.TextEdit")).toEqual({
      ok: false,
      error: "com.apple.TextEdit is already on the list.",
    });
  });
});

describe("removeBundleId", () => {
  it("removes only that id", () => {
    expect(removeBundleId(["a.b", "c.d", "e.f"], "c.d")).toEqual(["a.b", "e.f"]);
  });
});

describe("shotSecError", () => {
  it("accepts the server's range and refuses outside it", () => {
    expect(shotSecError(30)).toBeNull();
    expect(shotSecError(2)).toBe("Screenshot interval must be 5–3600 seconds, got 2");
    expect(shotSecError(12.5)).toBe("Screenshot interval must be 5–3600 seconds, got 12.5");
  });
});

describe("ONBOARDING", () => {
  // Spec, Security and data: two separate TCC grants, settled on a clean macOS user (3c part 2).
  it("prepares for both macOS prompts, and the mic", () => {
    const text = ONBOARDING.steps.join(" ");
    expect(text).toContain("record your system audio");
    expect(text).toContain("private window picker");
    expect(text).toContain("microphone");
    expect(text).toContain("⌥⌘R");
  });
});

// Codex 3e-2 r1 P1: two quick edits each replaced the whole list from the same stale copy,
// so "add TextEdit, then remove Mail" saved [] last and TextEdit lost its protection.
describe("createListEditor", () => {
  it("applies each edit to the list the previous edit left, and saves in order", async () => {
    const saved: string[][] = [];
    let finish: () => void = () => {};
    const save = (list: string[]) => {
      saved.push(list);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const editor = createListEditor(save);
    const first = editor.edit(["com.apple.Mail"], (list) => [...list, "com.apple.TextEdit"]);
    const second = editor.edit(["com.apple.Mail"], (list) => list.filter((id) => id !== "com.apple.Mail"));
    expect(saved).toEqual([["com.apple.Mail", "com.apple.TextEdit"]]);
    finish();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([["com.apple.Mail", "com.apple.TextEdit"], ["com.apple.TextEdit"]]);
    finish();
    await second;
  });

  // Codex 3e-2 r2 P1: a save had finished, but the page had not re-rendered the saved list
  // yet, so the next edit started from the stale one and saved [] again.
  it("keeps the edited list until the saved list it renders has caught up", async () => {
    const saved: string[][] = [];
    const editor = createListEditor(async (list) => void saved.push(list));
    await editor.edit(["com.apple.Mail"], (list) => [...list, "com.apple.TextEdit"]);
    await editor.edit(["com.apple.Mail"], (list) => list.filter((id) => id !== "com.apple.Mail"));
    expect(saved).toEqual([["com.apple.Mail", "com.apple.TextEdit"], ["com.apple.TextEdit"]]);
  });

  it("rebases on the saved list once it has caught up", async () => {
    const saved: string[][] = [];
    const editor = createListEditor(async (list) => void saved.push(list));
    await editor.edit(["a.b"], (list) => [...list, "c.d"]);
    editor.sync(["a.b", "c.d"]);
    // Changed elsewhere (another window) after this one's edit was saved and shown.
    await editor.edit(["x.y"], (list) => [...list, "e.f"]);
    expect(saved).toEqual([["a.b", "c.d"], ["x.y", "e.f"]]);
  });

  it("turns a save that throws at once into a rejection, and recovers", async () => {
    let fail = true;
    const editor = createListEditor((list) => {
      if (fail) throw new Error("bridge gone");
      return Promise.resolve(void list);
    });
    await expect(editor.edit(["a.b"], (list) => [...list, "c.d"])).rejects.toThrow("bridge gone");
    fail = false;
    await expect(editor.edit(["a.b"], (list) => list)).resolves.toBeUndefined();
  });

  it("passes a failed save on, and recovers for the next edit", async () => {
    let fail = true;
    const editor = createListEditor(async () => {
      if (fail) throw new Error("backend down");
    });
    await expect(editor.edit(["a.b"], (list) => [...list, "c.d"])).rejects.toThrow("backend down");
    fail = false;
    await expect(editor.edit(["a.b"], (list) => list)).resolves.toBeUndefined();
  });
});

// Codex 3e-2 r1 P2: off macOS the recorder is `unsupported`, which has no state copy.
describe("UNSUPPORTED", () => {
  it("says the recorder needs macOS", () => {
    expect(UNSUPPORTED).toBe("Recording your day needs macOS. Geekspace on this computer can't capture.");
  });
});

// Codex 3e-2 r2 P2: support was judged from the status, which is `off` on Windows too until
// the recorder is turned on, so Windows offered the macOS onboarding.
describe("recorderSupported", () => {
  it("is decided by the platform, whatever the status says", () => {
    expect(recorderSupported("MacIntel", { status: "off" })).toBe(true);
    expect(recorderSupported("Win32", { status: "off" })).toBe(false);
    expect(recorderSupported("MacIntel", { status: "unsupported" })).toBe(false);
    expect(recorderSupported("MacIntel", null)).toBe(true);
  });
});
