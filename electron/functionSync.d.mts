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
/** Committer time (Unix seconds) of the commit a bundle was built from. */
export type Ordinal = number;
export interface Marker {
  hash: string | null;
  ordinal: Ordinal | null;
}

export function describeOrdinal(ordinal: Ordinal | null): string;
export function writeBundle(dir: string, request: PushRequest, options: { convexVersion: string; ordinal: Ordinal }): string;
export function readBundle(dir: string): { hash: string; request: PushRequest; ordinal: Ordinal | null };
export function readMarker(dataDir: string): Marker | null;
export function writeMarker(dataDir: string, marker: Marker, options?: { now?: () => number }): void;
export function recordExternalDeploy(dataDir: string, ordinal: Ordinal, options?: { now?: () => number }): void;

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
  allowDowngrade?: boolean;
  deadlineMs?: number;
  now?: () => number;
}): Promise<{
  status: "current" | "deployed" | "downgrade" | "skipped" | "failed";
  hash?: string;
  /** Set on "downgrade". */
  bundleOrdinal?: Ordinal | null;
  liveOrdinal?: Ordinal;
  error?: Error;
}>;
