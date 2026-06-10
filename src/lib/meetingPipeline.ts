import { convex } from "./convex";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { recorder } from "./recorder";
import { meetingProcess } from "./meetingsBridge";

// WHAT: Orchestrates stop → upload audio → transcribe+summarize → persist.
// Audio is uploaded to Convex storage FIRST so a crash mid-pipeline never
// loses the recording (the meeting detail offers Reprocess).

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
    await convex.mutation(api.meetings.setStatus, {
      meetingId,
      status: "error",
      error: result.error,
    });
    return;
  }
  await convex.mutation(api.meetings.setTranscript, {
    meetingId,
    transcript: result.data.transcript,
  });
  await convex.mutation(api.meetings.finishSummary, {
    meetingId,
    summary: result.data.summary,
    keyPoints: result.data.keyPoints,
    decisions: result.data.decisions,
    actionItems: result.data.actionItems,
    modelUsed: result.data.modelUsed,
  });
}

/** Stop the live recording and run the whole pipeline. */
export async function finishRecording(): Promise<void> {
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
    await runAi(id, await blob.arrayBuffer(), meetingType);
  } catch (err) {
    await convex.mutation(api.meetings.setStatus, {
      meetingId: id,
      status: "error",
      error: String((err as Error)?.message ?? err),
    });
  }
}

/** Re-run transcription + summary from the stored audio. */
export async function reprocessMeeting(meetingId: Id<"meetings">): Promise<void> {
  const meeting = await convex.query(api.meetings.get, { meetingId });
  if (!meeting?.audioUrl) throw new Error("No audio stored for this meeting");
  await convex.mutation(api.meetings.setStatus, {
    meetingId,
    status: "transcribing",
    progress: 0,
    error: undefined,
  });
  const audio = await (await fetch(meeting.audioUrl)).arrayBuffer();
  await runAi(meetingId, audio, meeting.meetingType ?? "general");
}

/** Discard an in-flight recording and its meeting record. */
export async function cancelRecording(): Promise<void> {
  const meetingId = recorder.cancel();
  if (meetingId) {
    await convex.mutation(api.meetings.remove, { meetingId: meetingId as Id<"meetings"> });
  }
}
