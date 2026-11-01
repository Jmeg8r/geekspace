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

/** What assistant.input returns: the batch's material. */
export type AssistantInput = {
  transcripts: { _id: string; segmentId: string; start: number; end: number; text: string }[];
  screenshots: { _id: string; takenAt: number; appBundleId?: string; ocrText: string }[];
};

/** What the assistant sends (the fields it sets on client.beta.messages.parse). */
export type AssistantRequest = {
  model: string;
  max_tokens: number;
  betas: string[];
  fallbacks: "default";
  output_config: { effort: string; format: object };
  system: { type: "text"; text: string; cache_control: { type: "ephemeral" } }[];
  messages: { role: "user"; content: string }[];
};

/** The parts of the SDK client the assistant uses. */
export type AssistantClient = {
  beta: { messages: { parse: (params: AssistantRequest) => Promise<{ parsed_output: { actions: object[] } | null; stop_reason: string; model: string; usage: Usage }> } };
};

export type DayAssistant = { runBatch: () => Promise<void> };

export function createDayAssistant(options: {
  client: () => AssistantClient | null;
  convex: {
    input: (window: { after: number; until: number }) => Promise<AssistantInput>;
    applyActions: (actions: object[]) => Promise<void>;
    recordUsage: (row: { day: string; inputTokens: number; outputTokens: number; costUsd: number }) => Promise<void>;
    capStatus: (day: string) => Promise<{ capUsd: number | null; spentUsd: number; reached: boolean }>;
    logEvent: (event: { kind: "capPaused"; detail: string }) => Promise<void>;
    watermark: () => Promise<number | null>;
    setWatermark: (at: number) => Promise<void>;
  };
  log: (message: string) => void;
  model?: string;
}): DayAssistant;
