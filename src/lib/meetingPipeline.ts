import { convex } from "./convex";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { recorder } from "./recorder";
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

/** Stop the live recording and store its audio. Marks the meeting failed (and rethrows) if that fails. */
async function saveRecording() {
  const { blob, durationSec, meetingId, meetingType } = await recorder.stop();
  const id = meetingId as Id<"meetings">;
  try {
    await convex.mutation(api.meetings.setStatus, { meetingId: id, status: "uploading" });
    const storageId = await uploadAudio(blob);
    await convex.mutation(api.meetings.attachAudio, {
      meetingId: id,
      storageId: storageId as Id<"_storage">,
      durationSec,
    });
  } catch (err) {
    await markFailed(id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { id, blob, meetingType };
}

/** Stop the live recording and run the whole pipeline. */
export async function finishRecording(): Promise<void> {
  let saved: Awaited<ReturnType<typeof saveRecording>>;
  try {
    saved = await saveRecording();
  } catch (err) {
    // Already shown on the meeting as its error; logged for debugging.
    console.warn("Saving the recording failed", err);
    return;
  }
  try {
    await runAi(saved.id, await saved.blob.arrayBuffer(), saved.meetingType);
  } catch (err) {
    await markFailed(saved.id, err instanceof Error ? err.message : String(err));
  }
}

/** Quit guard: store the live recording's audio (no AI) so it survives the app closing. */
export async function saveRecordingBeforeQuit(): Promise<void> {
  if (recorder.getState().status === "idle") return;
  const { id } = await saveRecording();
  await convex.mutation(api.meetings.setStatus, {
    meetingId: id,
    status: "error",
    error: "Saved when the app quit. Use Re-run AI to transcribe and summarise it.",
  });
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
