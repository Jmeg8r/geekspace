import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantAvailable, clearApiKey, hasApiKey, saveApiKey } from "../src/lib/assistantBridge";

// WHAT: the page's side of the assistant's key (plan PR 6a, spec F4). WHY tested: the key goes
// in and never comes back out, and a failure to save it must come back as an error the
// Settings section can show.

type Bridge = {
  setApiKey?: (key: string) => Promise<{ ok: true; data: undefined } | { ok: false; error: string }>;
  hasApiKey?: () => Promise<{ ok: true; data: boolean }>;
  clearApiKey?: () => Promise<{ ok: true; data: undefined }>;
};

const install = (bridge: Bridge | undefined) => vi.stubGlobal("window", bridge ? { geekspace: { assistant: bridge } } : {});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assistantBridge", () => {
  it("needs the desktop app", async () => {
    install(undefined);
    expect(assistantAvailable()).toBe(false);
    expect(await hasApiKey()).toEqual({ ok: false, error: "The assistant needs the desktop app." });
  });

  it("saves a trimmed key and passes a refusal through", async () => {
    const setApiKey = vi.fn(async () => ({ ok: false as const, error: "That doesn't look like an API key" }));
    install({ setApiKey });
    expect(await saveApiKey("  sk-ant-SYNTHETIC  ")).toEqual({ ok: false, error: "That doesn't look like an API key" });
    expect(setApiKey).toHaveBeenCalledWith("sk-ant-SYNTHETIC");
  });

  it("asks only whether a key is saved, and can remove it", async () => {
    const clear = vi.fn(async () => ({ ok: true as const, data: undefined }));
    install({ hasApiKey: async () => ({ ok: true, data: true }), clearApiKey: clear });
    expect(await hasApiKey()).toEqual({ ok: true, data: true });
    await clearApiKey();
    expect(clear).toHaveBeenCalledOnce();
  });
});
