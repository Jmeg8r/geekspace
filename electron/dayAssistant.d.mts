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
  messages: { role: "user"; content: string }[];
};

type Reply = { content: { type: string; text?: string }[]; stop_reason: string; model: string; usage: Usage };

/** The parts of the SDK client the assistant uses. */
export type AssistantClient = { messages: { create: (params: AssistantRequest) => Promise<Reply> } };

/** The SDK client for a key, with logging off whatever ANTHROPIC_LOG says. */
export function assistantClient(apiKey: string): AssistantClient & { logLevel: string | undefined; maxRetries: number };

export type DayAssistant = { runBatch: () => Promise<void>; stop: () => Promise<void> };

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
  };
  log: (message: string) => void;
  model?: string;
}): DayAssistant;
