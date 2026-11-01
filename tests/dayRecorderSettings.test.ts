import { describe, expect, it } from "vitest";
import { ONBOARDING, addBundleId, removeBundleId, shotSecError } from "../src/lib/dayRecorderSettings";

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
