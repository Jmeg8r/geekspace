// WHAT: types for the assistant's key store, so tests/ can import it.

export type KeyStore = {
  set: (key: string) => void;
  has: () => boolean;
  get: () => string | null;
  clear: () => void;
};

export function createKeyStore(options: {
  file: string;
  safeStorage: {
    isEncryptionAvailable: () => boolean;
    encryptString: (plain: string) => Buffer;
    decryptString: (encrypted: Buffer) => string;
  };
  fs: {
    writeFileSync: (file: string, data: Buffer, options: { mode: number }) => void;
    readFileSync: (file: string) => Buffer;
    rmSync: (file: string, options?: { force?: boolean }) => void;
    existsSync: (file: string) => boolean;
  };
}): KeyStore;

type ImageResult = { ok: true; actions: number } | { ok: false; reason: string };

export function registerAssistantIpc(options: {
  handle: (
    channel: string,
    fn: (args: { key?: string | number | null; screenshotId?: string | number | null }) => boolean | void | ImageResult | Promise<ImageResult>
  ) => void;
  keyStore: Pick<KeyStore, "set" | "has" | "clear">;
  /** The running recorder's image requests; null when the recorder is not running. */
  assistant: () => { requestImage: (screenshotId: string) => Promise<ImageResult> } | null;
}): void;
