import { convex } from "./convex";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { recorder } from "./recorder";
import { createAudioSaver, type StoppedRecording } from "./audioSaver";
import { meetingProcess, meetingSummarize, type MeetingProcessResult } from "./meetingsBridge";

// WHAT: Orchestrates stop → upload audio → transcribe+summarize → persist.
// Audio is uploaded to Convex storage FIRST and the transcript is saved even when the
// summary fails, so a crash or a down Ollama never loses work (the detail offers Re-run AI).

const AUDIO_FETCH_TIMEOUT_MS = 60_000;

async function uploadAudio(blob: Blob): Promise<string> {
  const uploadUrl = await convex.mutation(api.files.generateUploadUrl, {});
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!res.ok) throw new Error(`Audio upload failed (${res.status})`);
  const { storageId } = (await res.json()) as { storageId: string };
  return storageId;
}

async function markFailed(meetingId: Id<"meetings">, message: string) {
  await convex.mutation(api.meetings.setStatus, { meetingId, status: "error", error: message });
}

/** Save what came back: the transcript always, then the notes or the summary's error. */
async function applyResult(meetingId: Id<"meetings">, result: MeetingProcessResult) {
  await convex.mutation(api.meetings.setTranscript, { meetingId, transcript: result.transcript });
  if (result.summaryError !== undefined) {
    await convex.mutation(api.meetings.setStatus, {
      meetingId,
      status: "error",
      error: `Summary failed: ${result.summaryError}. The transcript is saved; Re-run AI summarises it again.`,
    });
    return;
  }
  await convex.mutation(api.meetings.finishSummary, {
    meetingId,
    summary: result.summary,
    keyPoints: result.keyPoints,
    decisions: result.decisions,
    actionItems: result.actionItems,
    modelUsed: result.modelUsed,
  });
}

async function runAi(meetingId: Id<"meetings">, audio: ArrayBuffer, meetingType: string) {
  const settings = await convex.query(api.settings.get, {});
  const result = await meetingProcess({
    meetingId,
    audio,
    meetingType,
    ollamaUrl: settings.ollamaUrl,
    ollamaModel: settings.ollamaModel,
  });
  if (!result.ok) {
    await markFailed(meetingId, result.error);
    return;
  }
  await applyResult(meetingId, result.data);
}

// Holds a stopped recording until it is attached, so a failed upload can be retried.
const saver = createAudioSaver({
  isRecording: () => recorder.getState().status !== "idle",
  stop: () => recorder.stop(),
  store: async (recording) => {
    const meetingId = recording.meetingId as Id<"meetings">;
    await convex.mutation(api.meetings.setStatus, { meetingId, status: "uploading" });
    const storageId = await uploadAudio(recording.blob);
    await convex.mutation(api.meetings.attachAudio, {
      meetingId,
      storageId: storageId as Id<"_storage">,
      durationSec: recording.durationSec,
    });
  },
  reportFailure: (recording, message) =>
    markFailed(
      recording.meetingId as Id<"meetings">,
      `Couldn't save the audio: ${message}. It's kept until you close the app; use Retry save.`
    ),
});

/** Audio that is stopped but not yet stored, for the Retry save button and the quit guard. */
export const pendingAudio = saver.pending;

/** Run transcription + summary on audio that was just stored; failures land on the meeting. */
async function processStored(recording: StoppedRecording) {
  const meetingId = recording.meetingId as Id<"meetings">;
  try {
    await runAi(meetingId, await recording.blob.arrayBuffer(), recording.meetingType);
  } catch (err) {
    await markFailed(meetingId, err instanceof Error ? err.message : String(err));
  }
}

/** Stop the live recording and run the whole pipeline. */
export async function finishRecording(): Promise<void> {
  let recording: StoppedRecording;
  try {
    recording = await saver.stopAndSave();
  } catch (err) {
    // Already shown on the meeting as its error, with the audio kept for Retry save.
    console.warn("Saving the recording failed", err);
    return;
  }
  await processStored(recording);
}

/** Retry storing one meeting's held audio, then process it. */
export async function retrySave(meetingId: Id<"meetings">): Promise<void> {
  // A save already running for this meeting will process it when it lands; joining it
  // here would start a second AI job for the same recording.
  if (saver.pending.saving(meetingId)) return;
  let recording: StoppedRecording;
  try {
    recording = await saver.retry(meetingId);
  } catch (err) {
    console.warn("Retry save failed", err);
    return;
  }
  await processStored(recording);
}

/** Quit guard: store the live recording and all held audio (no AI) so it survives the app closing. */
export async function saveRecordingBeforeQuit(): Promise<void> {
  if (!saver.hasWork()) return;
  const { stored, failed } = await saver.saveAll();
  for (const recording of stored) {
    await convex.mutation(api.meetings.setStatus, {
      meetingId: recording.meetingId as Id<"meetings">,
      status: "error",
      error: "Saved when the app quit. Use Re-run AI to transcribe and summarise it.",
    });
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} recording(s) could not be saved: ${failed.join("; ")}`);
  }
}

/** The meeting was deleted: let go of any audio still held for it. */
export function discardHeldAudio(meetingId: Id<"meetings">): void {
  saver.discard(meetingId);
}

/**
 * Re-run the AI. With a saved transcript only the summary runs again; otherwise the stored
 * audio is transcribed and summarised. Any failure lands on the meeting as its error.
 */
export async function reprocessMeeting(meetingId: Id<"meetings">): Promise<void> {
  const meeting = await convex.query(api.meetings.get, { meetingId });
  if (!meeting) throw new Error("Meeting not found");
  try {
    const settings = await convex.query(api.settings.get, {});
    if (meeting.transcript) {
      await convex.mutation(api.meetings.setStatus, { meetingId, status: "summarizing", progress: 0 });
      const result = await meetingSummarize({
        meetingId,
        transcript: meeting.transcript,
        meetingType: meeting.meetingType ?? "general",
        ollamaUrl: settings.ollamaUrl,
        ollamaModel: settings.ollamaModel,
      });
      if (!result.ok) throw new Error(result.error);
      await applyResult(meetingId, result.data);
      return;
    }
    if (!meeting.audioUrl) throw new Error("No audio stored for this meeting");
    await convex.mutation(api.meetings.setStatus, { meetingId, status: "transcribing", progress: 0 });
    const response = await fetch(meeting.audioUrl, { signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Audio download failed (${response.status})`);
    await runAi(meetingId, await response.arrayBuffer(), meeting.meetingType ?? "general");
  } catch (err) {
    await markFailed(meetingId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Discard an in-flight recording and its meeting record. */
export async function cancelRecording(): Promise<void> {
  const meetingId = recorder.cancel();
  if (meetingId) {
    await convex.mutation(api.meetings.remove, { meetingId: meetingId as Id<"meetings"> });
  }
}
