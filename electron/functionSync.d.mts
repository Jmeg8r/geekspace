// WHAT: types for startup function sync, so tests/ can import it (see meetingProcessor.d.mts).

export const REQUEST_FILE: string;
export const MANIFEST_FILE: string;
export const MARKER_FILE: string;

export class SyncError extends Error {
  constructor(message: string, options?: { tableName?: string });
  tableName: string | undefined;
}

/** The fields of a `convex deploy --write-push-request` payload this module touches. */
export interface PushRequest {
  adminKey?: string;
  appDefinition?: object;
  componentDefinitions?: object[];
  [field: string]: unknown;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: { "content-type": string; authorization: string }; body: string; signal: AbortSignal }
) => Promise<Response>;

export function hashRequest(json: string): string;
export function stripAdminKey(request: PushRequest): Omit<PushRequest, "adminKey">;
export function writeBundle(dir: string, request: PushRequest, options: { convexVersion: string }): string;
export function readBundle(dir: string): { hash: string; request: PushRequest };
export function readMarker(dataDir: string): string | null;
export function invalidateMarker(dataDir: string): boolean;
export function writeMarker(dataDir: string, hash: string, options?: { now?: () => number }): void;

export function pushFunctions(options: {
  url: string;
  adminKey: string;
  request: PushRequest;
  fetch?: FetchLike;
  deadlineMs?: number;
  now?: () => number;
}): Promise<void>;

export function syncFunctions(options: {
  dataDir: string;
  bundleDir: string;
  url: string;
  adminKey: string | undefined;
  fetch?: FetchLike;
  log: (line: string) => void;
  requireBundle?: boolean;
  deadlineMs?: number;
  now?: () => number;
}): Promise<{ status: "current" | "deployed" | "skipped" | "failed"; hash?: string; error?: Error }>;
