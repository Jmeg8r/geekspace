import { afterEach, describe, expect, it, vi } from "vitest";
import { approveDraft, assistantAvailable, clearApiKey, hasApiKey, hasLinearKey, saveApiKey, saveLinearKey } from "../src/lib/assistantBridge";

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

// Plan PR 6b: the Linear key is write-only the same way, and a draft is approved by its id.
describe("assistantBridge, Linear", () => {
  const installLinear = (bridge: Record<string, unknown>) => vi.stubGlobal("window", { geekspace: { linear: bridge } });

  it("saves a trimmed Linear key through the linear channels", async () => {
    const setApiKey = vi.fn(async () => ({ ok: true as const, data: undefined }));
    installLinear({ setApiKey });
    expect(await saveLinearKey("  lin_api_SYNTHETIC  ")).toEqual({ ok: true, data: undefined });
    expect(setApiKey).toHaveBeenCalledWith("lin_api_SYNTHETIC");
  });

  it("approves a draft by id, and passes Linear's refusal through", async () => {
    const approve = vi.fn(async () => ({ ok: false as const, error: "Linear answered HTTP 500" }));
    installLinear({ approve });
    expect(await approveDraft("draft-1")).toEqual({ ok: false, error: "Linear answered HTTP 500" });
    expect(approve).toHaveBeenCalledWith("draft-1");
  });

  it("needs the desktop app", async () => {
    vi.stubGlobal("window", {});
    expect(await hasLinearKey()).toEqual({ ok: false, error: "Linear needs the desktop app." });
  });
});
