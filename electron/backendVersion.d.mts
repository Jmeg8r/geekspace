// WHAT: types for the backend-version module, so tests/ can import it (see meetingProcessor.d.mts).

export interface BackendAsset {
  zip: string;
  zipSize: number;
  zipSha256: string;
  binarySize: number;
  binarySha256: string;
}

export const BACKEND_VERSION: string;
export const BACKEND_RELEASE_URL: string;
export const BACKEND_ASSETS: Readonly<Record<string, BackendAsset>>;

export function backendAsset(platform?: string, arch?: string): BackendAsset | null;

export function backendCachePath(options?: {
  platform?: string;
  env?: { LOCALAPPDATA?: string };
  homedir?: string;
}): string;

export function missingBinaryMessage(binaryPath: string): string;
