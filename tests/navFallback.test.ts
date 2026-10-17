// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// WHAT: a nav restored from storage that points at a page we can't load lands on Home,
// while a page you opened yourself keeps today's "page is gone" message.
// See docs/changes/2026-10-17-function-sync/.

const STORAGE_KEY = "geekspace-ui";
const PAGE = { kind: "page" as const, pageId: "pages:from-another-deployment" };
const HOME = { kind: "home" as const };

async function loadStore(persisted?: unknown) {
  vi.resetModules();
  localStorage.clear();
  if (persisted) localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: persisted, version: 0 }));
  return import("../src/state/ui");
}

beforeEach(() => localStorage.clear());

describe("fallbackNav", () => {
  it("a page that throws always falls back to Home", async () => {
    const { fallbackNav } = await loadStore();
    expect(fallbackNav(PAGE, true, "error")).toEqual(HOME);
    expect(fallbackNav(PAGE, false, "error")).toEqual(HOME);
  });

  it("a missing page falls back to Home only when the nav was restored", async () => {
    const { fallbackNav } = await loadStore();
    expect(fallbackNav(PAGE, true, "missing")).toEqual(HOME);
    expect(fallbackNav(PAGE, false, "missing")).toEqual(PAGE);
  });

  it("non-page views are left alone", async () => {
    const { fallbackNav } = await loadStore();
    expect(fallbackNav({ kind: "calendar" }, true, "missing")).toEqual({ kind: "calendar" });
  });
});

describe("navRestored", () => {
  it("is set when the persisted nav is a page", async () => {
    const { useUI } = await loadStore({ nav: PAGE });
    expect(useUI.getState().nav).toEqual(PAGE);
    expect(useUI.getState().navRestored).toBe(true);
  });

  it("is not set for a fresh store or a restored non-page view", async () => {
    expect((await loadStore()).useUI.getState().navRestored).toBe(false);
    expect((await loadStore({ nav: { kind: "calendar" } })).useUI.getState().navRestored).toBe(false);
  });

  it("is cleared by navigating, and never persisted", async () => {
    const { useUI } = await loadStore({ nav: PAGE });
    useUI.getState().navigate({ kind: "page", pageId: "pages:chosen" });
    expect(useUI.getState().navRestored).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).not.toMatch(/navRestored/);
  });
});
