import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// WHAT: the mac package ships the Day Recorder helper and says why it records system audio.
// WHY a config test: both failures are silent on a dev build and only show on end-user
// machines. A package without the helper can't capture at all, and without a real
// NSAudioCaptureUsageDescription electron-builder injects a generic default (spike Q7). This
// repo has shipped a missing-capability bug of that class before (CLAUDE.md, entitlements).

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const HELPER_FROM = "native/gs-capture/.build/release/gs-capture";

describe("Day Recorder packaging", () => {
  it("copies the helper into the mac app's Resources", () => {
    expect(pkg.build.mac.extraResources).toContainEqual({ from: HELPER_FROM, to: "gs-capture" });
  });

  it("takes the helper from where the build script writes it", () => {
    const script = fs.readFileSync(path.join(ROOT, "scripts", "build-gs-capture.mjs"), "utf8");
    expect(script).toContain('path.join(ROOT, "native", "gs-capture")');
    expect(script).toContain('path.join(PACKAGE_DIR, ".build", "release", "gs-capture")');
  });

  it("builds the helper before electron-builder packages the mac app", () => {
    const steps: string[] = pkg.scripts.package.split("&&").map((step: string) => step.trim());
    const build = steps.indexOf("npm run build:gs-capture");
    const builder = steps.findIndex((step) => step.startsWith("electron-builder --mac"));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(builder).toBeGreaterThan(build);
    expect(pkg.scripts["build:gs-capture"]).toBe("node scripts/build-gs-capture.mjs");
  });

  it("explains system-audio capture in its own words, not electron-builder's default", () => {
    const text: string = pkg.build.mac.extendInfo.NSAudioCaptureUsageDescription;
    expect(text).toMatch(/Day Recorder/);
    expect(text).not.toBe("This app needs access to audio capture");
  });

  it("names the Day Recorder in the mic prompt, since it now records the mic too (plan PR 3d-2)", () => {
    const text: string = pkg.build.mac.extendInfo.NSMicrophoneUsageDescription;
    expect(text).toMatch(/Day Recorder/);
    expect(text).toMatch(/stays on this Mac/);
  });

  it("builds the hidden mic window's page with the app", () => {
    expect(fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8")).toMatch(/capture\.html/);
  });

  it("signs the helper with the app's inherited entitlements", () => {
    // electron-builder applies entitlementsInherit to everything in Resources (spike Q7).
    expect(pkg.build.mac.hardenedRuntime).toBe(true);
    expect(pkg.build.mac.entitlementsInherit).toBe("build/entitlements.mac.plist");
  });
});
