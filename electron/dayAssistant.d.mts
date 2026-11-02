// WHAT: types for the Day Recorder assistant, so tests/ can import it.

export const MODEL: string;
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }>;

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function costOf(usage: Usage, model: string): number;

export const STOP_GRACE_MS: number;

type Cursor = { at: number; ids: string[] };

/** What assistant.unread returns: a page of the batch's material, and where it ended. */
export type AssistantInput = {
  transcriptsDone?: boolean;
  screenshotsDone?: boolean;
  transcriptAfter?: Cursor;
  screenshotAfter?: Cursor;
  transcripts: { _id: string; segmentId: string; start: number; end: number; text: string; readChars?: number }[];
  screenshots: { _id: string; takenAt: number; appBundleId?: string; ocrText: string; readChars?: number }[];
};

/** What the assistant sends (the fields it sets on client.messages.create). */
export type AssistantRequest = {
  model: string;
  max_tokens: number;
  output_config: { effort: string; format: { type: "json_schema"; schema: object } };
  system: { type: "text"; text: string; cache_control: { type: "ephemeral" } }[];
  messages: { role: "user"; content: string | ContentBlock[] }[];
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };

type Reply = { content: { type: string; text?: string }[]; stop_reason: string; model: string; usage: Usage };

/** The parts of the SDK client the assistant uses. */
export type AssistantClient = { messages: { create: (params: AssistantRequest) => Promise<Reply> } };

/** The SDK client for a key, with logging off whatever ANTHROPIC_LOG says. */
export function assistantClient(apiKey: string): AssistantClient & { logLevel: string | undefined; maxRetries: number };

/** Writes the imageSent event for a screenshot about to be sent (spec R9). */
export type ImageSentLogger = (event: { screenshotId: string }) => Promise<void>;

/** What came of an image request, in words for the page. */
export type ImageResult = { ok: true; actions: number } | { ok: false; reason: string };

/** Rows per page when a summary reads the day (convex dayPage). */
export const SUMMARY_PAGE_ROWS: number;

/** What came of a summary request, in words for the page. */
export type SummaryResult = { ok: true; items: number; unsourced: number; leftOut: number } | { ok: false; reason: string };

type DayRecordRows = {
  transcripts: { _id: string; segmentId: string; start: number; end: number; text: string }[];
  screenshots: { _id: string; takenAt: number; ocrText: string; purged: boolean; appBundleId?: string }[];
  more: { transcripts: boolean; screenshots: boolean };
};

export type DayAssistant = {
  runBatch: () => Promise<void>;
  /** The end-of-day summary of one local day (`from`–`to`), on request. */
  summarize: (day: string, from: number, to: number) => Promise<SummaryResult>;
  /** The logger is required and comes first (spec R9): an unlogged send does not compile. */
  sendImage: (logImageSent: ImageSentLogger, screenshotId: string) => Promise<ImageResult>;
  stop: () => Promise<void>;
};

/** A screenshot as JPEG bytes (macOS: sips), made in `workDir` and swept from it. */
export function screenshotJpeg(file: string, workDir: string): Promise<Buffer>;

/** Make the image work folder owner-only and remove conversions a crash left in it. */
export function sweepImageWork(workDir: string, now?: number): void;

type Proposal = Record<string, string | number | { start: number; end: number } | undefined>;

export type OpenRequest = {
  _id: string;
  status: "inFlight" | "settled";
  proposals: { proposal: object; state: string }[];
};

export function createDayAssistant(options: {
  client: () => AssistantClient | null;
  convex: {
    ensureStart: (args: { at: number }) => Promise<number>;
    unread: (args: { since: number; limit: number; transcriptAfter?: Cursor; screenshotAfter?: Cursor }) => Promise<AssistantInput>;
    capStatus: (day: string) => Promise<{ capUsd: number | null; spentUsd: number; reached: boolean }>;
    beginRequest: (args: {
      day: string;
      reservedUsd: number;
      transcriptIds: string[];
      screenshotIds: string[];
      transcriptEnds?: number[];
      screenshotEnds?: number[];
    }) => Promise<string | null>;
    settleRequest: (args: {
      requestId: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheWriteTokens: number;
      cacheReadTokens: number;
      proposals: Proposal[];
    }) => Promise<void>;
    failRequest: (args: { requestId: string }) => Promise<void>;
    abandonRequest: (args: { requestId: string }) => Promise<void>;
    openRequests: () => Promise<OpenRequest[]>;
    applyProposal: (args: { requestId: string; index: number; tzOffsetMin?: number }) => Promise<void>;
    refuseProposal: (args: { requestId: string; index: number }) => Promise<void>;
    logEvent: (event: { kind: "capPaused"; detail: string }) => Promise<void>;
    /** One page of a day's transcripts or screens, oldest first (convex dayPage). */
    dayPage: (args: {
      from: number;
      to: number;
      kind: "transcripts" | "screenshots";
      cursor: string | null;
    }) => Promise<{ rows: DayRecordRows["transcripts"] | DayRecordRows["screenshots"]; done: boolean; cursor: string }>;
    saveSummary: (args: { day: string; items: { text: string; sourceSegmentId?: string; sourceScreenshotId?: string }[] }) => Promise<void>;
    screenshot: (screenshotId: string) => Promise<{ _id: string; path: string; takenAt: number; appBundleId?: string } | null>;
  };
  log: (message: string) => void;
  /** A screenshot's path, confined to the media root; throws for one outside it. */
  resolvePath: (relativePath: string) => string;
  /** A screenshot as JPEG bytes: screenshotJpeg with the media root's work folder. */
  toJpeg: (file: string) => Promise<Buffer>;
  model?: string;
}): DayAssistant;
