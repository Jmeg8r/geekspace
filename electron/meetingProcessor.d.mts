// WHAT: types for the meeting pipeline's main-process module.
// WHY: electron/ is deliberately plain untyped ESM so the main process needs no
// build step, but the audio-silence guard is pure logic worth unit-testing from
// tests/ — this declaration is the typed boundary that makes that import legal.

export interface MeetingToolStatus {
  ffmpeg: boolean;
  whisper: boolean;
  model: boolean;
  modelName: string;
}

export interface VolumeStats {
  /** Average level in dB; NaN when unmeasured, -Infinity for ffmpeg's "-inf". */
  meanDb: number;
  /** Peak level in dB; NaN when unmeasured, -Infinity for ffmpeg's "-inf". */
  peakDb: number;
}

export interface MeetingSummary {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  modelUsed: string;
}

export type MeetingPhase = "model" | "transcribing" | "summarizing";

export function toolStatus(): Promise<MeetingToolStatus>;
export function ensureModel(onProgress?: (pct: number) => void): Promise<boolean>;
export function checkOllama(
  url?: string
): Promise<{ ok: boolean; models: string[]; error?: string }>;

/** Parse ffmpeg `volumedetect` stderr into dB stats. */
export function parseVolumeStats(stderr: string): VolumeStats;

/** True when the audio carries no usable speech signal. Fails open on NaN. */
export function isSilentAudio(stats: VolumeStats): boolean;

export function processMeeting(
  input: {
    audio: ArrayBuffer | Uint8Array;
    meetingType?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
  },
  onProgress?: (p: { phase: MeetingPhase; pct: number }) => void
): Promise<MeetingSummary & { transcript: string }>;
