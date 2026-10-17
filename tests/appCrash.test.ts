// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppCrash } from "../src/components/common/ViewError";

// WHAT: the crash screen's Reload / Go to Home never throw away meeting audio. Reloading
// the renderer skips the quit guard in electron/main.mjs, so the screen saves first and
// only discards when the user says so. See docs/changes/2026-10-17-function-sync/.

const save = vi.fn<() => Promise<void>>();

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const reload = vi.fn();

function render(saveTimeoutMs?: number) {
  act(() =>
    root.render(createElement(AppCrash, { error: new Error("render failed"), reload, saveAudio: save, saveTimeoutMs })),
  );
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);
async function click(label: string) {
  await act(async () => button(label)!.click());
}

beforeEach(() => {
  save.mockReset();
  reload.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("AppCrash", () => {
  it("saves held audio before reloading", async () => {
    save.mockResolvedValue();
    render();
    await click("Reload");
    expect(save).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("Go to Home also saves first, then reloads", async () => {
    save.mockResolvedValue();
    render();
    await click("Go to Home");
    expect(save).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("a failed save keeps the screen, says why, and reloads only on an explicit discard", async () => {
    save.mockRejectedValue(new Error("1 recording(s) could not be saved: upload failed"));
    render();
    await click("Reload");
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain("upload failed");
    await click("Reload and discard the recording");
    expect(reload).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("a save that never finishes gives the controls back instead of disabling them forever", async () => {
    save.mockReturnValue(new Promise<void>(() => {}));
    render(20);
    await click("Reload");
    await act(async () => new Promise((r) => setTimeout(r, 60)));
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/took too long/);
    expect(button("Reload")!.disabled).toBe(false);
    await click("Reload and discard the recording");
    expect(reload).toHaveBeenCalledOnce();
  });
});
