import { describe, expect, it } from "vitest";
import { SILENCE_LEVEL, rmsLevel } from "../src/lib/recorder";

// WHAT: the level math Meetings and the Day Recorder's mic share (plan PR 3d-2, spec R3: the
// silence warning reuses recorder.ts's floor). WHY tested: a dead device reads exactly the
// byte midpoint, and that must land below the floor while real room tone lands above it.

describe("rmsLevel", () => {
  it("reads a dead device's flat line as 0, below the silence floor", () => {
    const level = rmsLevel(new Uint8Array(512).fill(128));
    expect(level).toBe(0);
    expect(level).toBeLessThan(SILENCE_LEVEL);
  });

  it("reads quiet room tone above the floor, and caps a loud signal at 1", () => {
    const quiet = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 129 : 127));
    expect(rmsLevel(quiet)).toBeGreaterThan(SILENCE_LEVEL);
    const loud = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 0));
    expect(rmsLevel(loud)).toBe(1);
  });
});
