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
export type WhisperModel = "base.en" | "small.en";
export const WHISPER_MODELS: Record<WhisperModel, { file: string; size: number; sha256: string }>;
export function ensureModel(onProgress?: (pct: number) => void, model?: WhisperModel): Promise<boolean>;

/** A tool or model the transcription needs is not installed. */
export class ToolMissingError extends Error {}

/** Silence and no speech are results, not errors (plan PR 5). */
export type TranscribeResult =
  | { transcript: string }
  | { silent: true; level: { meanDb: number; peakDb: number } }
  | { noSpeech: true };

export function transcribeFile(
  options: { input: string; model?: WhisperModel },
  onProgress?: (p: { phase: "model" | "transcribing"; pct: number }) => void,
  /** Tests only: the tool and model checks. */
  deps?: {
    toolStatus?: () => Promise<MeetingToolStatus>;
    modelVerified?: (model: WhisperModel) => Promise<boolean>;
    ensureModel?: (onProgress: (pct: number) => void, model: WhisperModel) => Promise<boolean>;
  }
): Promise<TranscribeResult>;
export function checkOllama(
  url?: string
): Promise<{ ok: boolean; models: string[]; error?: string }>;

/** Parse ffmpeg `volumedetect` stderr into dB stats. */
export function parseVolumeStats(stderr: string): VolumeStats;
export function findFfmpeg(): Promise<string | null>;
export function convertToWhisperWav(ffmpegBin: string, input: string, wav: string): Promise<string>;
export function measureVolume(ffmpegBin: string, wavPath: string): Promise<VolumeStats>;

/** True when the audio carries no usable speech signal. Fails open on NaN. */
export function isSilentAudio(stats: VolumeStats): boolean;

/** True when the transcript holds only whisper's non-speech markers (or under 5 characters). */
export function isNoSpeech(transcript: string): boolean;

/** Transcript → notes; long transcripts are summarised in sections, then merged. Throws on failure. */
export function summarizeTranscript(
  transcript: string,
  meetingType: string,
  ollamaUrl?: string,
  ollamaModel?: string,
  onProgress?: (pct: number) => void
): Promise<MeetingSummary>;

/** Either the notes, or the transcript with the summary's error message. */
export type MeetingNotesResult =
  | (MeetingSummary & { transcript: string; summaryError?: undefined })
  | { transcript: string; summaryError: string };

/** Like summarizeTranscript, but a summary failure is returned with the transcript, never thrown. */
export function notesFromTranscript(
  transcript: string,
  meetingType: string,
  ollamaUrl?: string,
  ollamaModel?: string,
  onProgress?: (pct: number) => void
): Promise<MeetingNotesResult>;

export function processMeeting(
  input: {
    audio: ArrayBuffer | Uint8Array;
    meetingType?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
  },
  onProgress?: (p: { phase: MeetingPhase; pct: number }) => void
): Promise<MeetingNotesResult>;
