// WHAT: types for the verified-download module, so tests/ can import it (see meetingProcessor.d.mts).

export function verifiedFile(file: string, size: number, sha256: string): Promise<boolean>;

export function downloadVerifiedFile(
  url: string,
  destination: string,
  size: number,
  sha256: string,
  onProgress?: (pct: number) => void
): Promise<void>;
