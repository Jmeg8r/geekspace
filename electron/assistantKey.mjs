// WHAT: the Day Recorder assistant's API key (plan PR 6a, spec F4). Stored only encrypted by
// Electron's safeStorage (the macOS Keychain holds the encryption key), in a file only the
// owner can read. Set from Settings through a write-only channel; read only in the main
// process, when a request is made.
// WHY not ANTHROPIC_API_KEY: an env var of that name would move ARCHITECT (the Agent SDK) onto
// API billing (F4), and anything in the environment reaches child processes.

// Anthropic keys are a single token; this only refuses what is plainly not a key.
const KEY_RE = /^\S{10,500}$/;

export function createKeyStore({ file, safeStorage, fs }) {
  return {
    set(key) {
      if (typeof key !== "string" || !KEY_RE.test(key)) throw new Error("That doesn't look like an API key");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("The Keychain isn't available, so the key can't be stored safely");
      }
      fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
    },
    has: () => fs.existsSync(file),
    /** Main process only: never sent to a page, never logged. */
    get() {
      try {
        return safeStorage.decryptString(fs.readFileSync(file));
      } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
      }
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

// A Convex document id: letters and digits only, so a page can't pass a path or anything else.
const SCREENSHOT_ID_RE = /^[a-z0-9]{1,64}$/i;

/**
 * The page's assistant channels, through main.mjs's guarded handle(). The key is write-only
 * (spec F4): a page can set it, clear it, or ask whether there is one; nothing returns it. An
 * image is asked for by screenshot id only (spec R9); `assistant` is the running recorder's
 * handle, null when it is not running.
 */
export function registerAssistantIpc({ handle, keyStore, assistant }) {
  handle("gs:assistant:hasApiKey", () => keyStore.has());
  handle("gs:assistant:setApiKey", ({ key }) => {
    if (typeof key !== "string") throw new Error("An API key is text");
    keyStore.set(key);
  });
  handle("gs:assistant:clearApiKey", () => {
    keyStore.clear();
  });
  handle("gs:assistant:requestImage", ({ screenshotId }) => {
    if (typeof screenshotId !== "string" || !SCREENSHOT_ID_RE.test(screenshotId)) throw new Error("That is not a screenshot id");
    const running = assistant();
    if (!running) return { ok: false, reason: "The Day Recorder isn't running" };
    return running.requestImage(screenshotId);
  });
}
