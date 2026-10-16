// WHAT: types for the shared ARCHITECT helpers, so tests/ can import them (see meetingProcessor.d.mts).

export interface ChatMessage {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  tool_name?: string;
}

export function mcpEnv(env?: Record<string, string | undefined>): Record<string, string>;

export function trimHistory<T extends ChatMessage>(history: T[], maxChars: number): T[];

// Tool arguments come from a model as arbitrary JSON; the MCP server validates each tool's
// fields with zod, so this boundary only guarantees "a JSON object".
export function parseToolArgs(
  raw: unknown
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export function errorFrame(text: string): { type: "error"; text: string };

export function oneTurnAtATime<A extends unknown[], R>(run: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
