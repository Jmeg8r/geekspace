// WHAT: types for ARCHITECT's Claude lane, so tests/ can check its lockdown options
// (see meetingProcessor.d.mts for why electron/ ships declarations).
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** The geekspace-mcp tools ARCHITECT may call, without the mcp__geekspace__ prefix. */
export const ARCHITECT_TOOLS: string[];

export function architectOptions(input?: {
  resumeId?: string | null;
  env?: Record<string, string | undefined>;
}): Options;

export function resetArchitect(): void;
export function architectAuthOk(): boolean;
export function runArchitect(
  message: string,
  onEvent: (frame: { type: "token" | "tool" | "error"; text: string }) => void
): Promise<void>;
