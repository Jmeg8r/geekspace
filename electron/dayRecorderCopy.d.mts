// WHAT: types for the Day Recorder's shared state copy, so tests/ and src/ can import it.
import type { RecorderStatus } from "./dayRecorderService.mjs";

/** Appended to every tooltip while another app holds ⌥⌘R. */
export const SHORTCUT_TAKEN: string;

export type Tone = "red" | "amber" | "grey" | "hollow";

export type StatusCopy = { tone: Tone; title: string; tooltip: string; action: "pause" | "resume" };

export function micErrorText(kind: string, error: string): string;

/** What a status looks like and says; null means nothing is shown. */
export function statusCopy(status: RecorderStatus, options: { shortcut: boolean }): StatusCopy | null;
