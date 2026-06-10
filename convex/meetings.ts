import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

// WHAT: AI Meeting Notes — the data side. The renderer records audio; the
// Electron main process transcribes (whisper.cpp) and summarizes (local
// Ollama); these functions track pipeline state and build the notes page.

export const list = query({
  args: {},
  handler: async (ctx) => {
    const meetings = await ctx.db.query("meetings").withIndex("by_startedAt").collect();
    meetings.sort((a, b) => b.startedAt - a.startedAt);
    return meetings;
  },
});

export const get = query({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, args) => {
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting) return null;
    const audioUrl = meeting.audioStorageId
      ? await ctx.storage.getUrl(meeting.audioStorageId)
      : null;
    return { ...meeting, audioUrl };
  },
});

export const start = mutation({
  args: {
    title: v.string(),
    meetingType: v.optional(v.string()),
    eventId: v.optional(v.id("events")),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("meetings", {
      title: args.title.trim() || "Untitled meeting",
      meetingType: args.meetingType ?? "general",
      status: "recording",
      startedAt: Date.now(),
      eventId: args.eventId,
    });
  },
});

export const rename = mutation({
  args: { meetingId: v.id("meetings"), title: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.meetingId, { title: args.title });
    const meeting = await ctx.db.get(args.meetingId);
    if (meeting?.pageId) {
      await ctx.db.patch(meeting.pageId, { title: args.title, updatedAt: Date.now() });
    }
  },
});

export const setStatus = mutation({
  args: {
    meetingId: v.id("meetings"),
    status: v.string(),
    progress: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { status: args.status };
    if (args.progress !== undefined) patch.progress = args.progress;
    if (args.error !== undefined) patch.error = args.error;
    await ctx.db.patch(args.meetingId, patch);
  },
});

export const attachAudio = mutation({
  args: {
    meetingId: v.id("meetings"),
    storageId: v.id("_storage"),
    durationSec: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.meetingId, {
      audioStorageId: args.storageId,
      durationSec: Math.round(args.durationSec),
      endedAt: Date.now(),
      status: "transcribing",
      progress: 0,
      error: undefined,
    });
  },
});

export const setTranscript = mutation({
  args: { meetingId: v.id("meetings"), transcript: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.meetingId, {
      transcript: args.transcript,
      status: "summarizing",
      progress: 100,
    });
  },
});

/** Final step: store the summary and build (or rebuild) the notes page. */
export const finishSummary = mutation({
  args: {
    meetingId: v.id("meetings"),
    summary: v.string(),
    keyPoints: v.array(v.string()),
    decisions: v.array(v.string()),
    actionItems: v.array(v.string()),
    modelUsed: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting) return;
    await ctx.db.patch(args.meetingId, {
      summary: args.summary,
      keyPoints: args.keyPoints,
      decisions: args.decisions,
      actionItems: args.actionItems,
      modelUsed: args.modelUsed,
      status: "done",
      error: undefined,
    });
    const pageId = await buildNotesPage(ctx, { ...meeting, ...args });
    if (pageId && meeting.pageId !== pageId) {
      await ctx.db.patch(args.meetingId, { pageId });
    }
  },
});

export const remove = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, args) => {
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting) return;
    if (meeting.audioStorageId) await ctx.storage.delete(meeting.audioStorageId);
    // The notes page survives deliberately — it's workspace content now.
    await ctx.db.delete(args.meetingId);
  },
});

// ---------- notes page generation ----------

type BlockSeed = Record<string, unknown>;

async function ensureMeetingNotesRoot(ctx: MutationCtx): Promise<Id<"pages">> {
  const pages = await ctx.db.query("pages").collect();
  const existing = pages.find(
    (p) => p.title === "Meeting Notes" && p.kind === "doc" && !p.trashed && !p.parentId
  );
  if (existing) return existing._id;
  return ctx.db.insert("pages", {
    title: "Meeting Notes",
    icon: "🎙️",
    kind: "doc",
    content: JSON.stringify([
      { type: "paragraph", content: "Every recorded meeting lands here as its own page." },
    ]),
    favorite: false,
    trashed: false,
    order: Date.now(),
    updatedAt: Date.now(),
  });
}

function transcriptBlocks(transcript: string): BlockSeed[] {
  // Whisper output arrives as lines; group into readable paragraphs, capped so
  // a 2-hour meeting doesn't produce a 5MB page (full text stays on the meeting).
  const paragraphs = transcript
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const blocks: BlockSeed[] = [];
  let buffer = "";
  for (const p of paragraphs) {
    buffer = buffer ? `${buffer} ${p}` : p;
    if (buffer.length > 420) {
      blocks.push({ type: "paragraph", content: buffer });
      buffer = "";
    }
    if (blocks.length >= 220) {
      blocks.push({ type: "paragraph", content: "… transcript truncated — full text lives on the meeting record." });
      return blocks;
    }
  }
  if (buffer) blocks.push({ type: "paragraph", content: buffer });
  return blocks;
}

async function buildNotesPage(
  ctx: MutationCtx,
  meeting: Doc<"meetings"> & {
    summary: string;
    keyPoints: string[];
    decisions: string[];
    actionItems: string[];
  }
): Promise<Id<"pages"> | null> {
  const when = new Date(meeting.startedAt);
  const dur = meeting.durationSec
    ? `${Math.floor(meeting.durationSec / 60)}m ${meeting.durationSec % 60}s`
    : "—";
  const blocks: BlockSeed[] = [
    {
      type: "paragraph",
      content: `🎙️ Recorded ${when.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · ${dur}${meeting.modelUsed ? ` · summarized by ${meeting.modelUsed}` : ""}`,
    },
    { type: "heading", props: { level: 2 }, content: "Summary" },
    ...meeting.summary
      .split(/\n+/)
      .filter((s) => s.trim())
      .map((p) => ({ type: "paragraph", content: p.trim() })),
  ];
  if (meeting.keyPoints.length > 0) {
    blocks.push({ type: "heading", props: { level: 2 }, content: "Key points" });
    for (const k of meeting.keyPoints) blocks.push({ type: "bulletListItem", content: k });
  }
  if (meeting.decisions.length > 0) {
    blocks.push({ type: "heading", props: { level: 2 }, content: "Decisions" });
    for (const d of meeting.decisions) blocks.push({ type: "bulletListItem", content: d });
  }
  if (meeting.actionItems.length > 0) {
    blocks.push({ type: "heading", props: { level: 2 }, content: "Action items" });
    for (const a of meeting.actionItems)
      blocks.push({ type: "checkListItem", props: { checked: false }, content: a });
  }
  if (meeting.transcript) {
    blocks.push({ type: "heading", props: { level: 2 }, content: "Transcript" });
    blocks.push(...transcriptBlocks(meeting.transcript));
  }

  const content = JSON.stringify(blocks);
  if (meeting.pageId) {
    const page = await ctx.db.get(meeting.pageId);
    if (page && !page.trashed) {
      await ctx.db.patch(meeting.pageId, { content, updatedAt: Date.now() });
      return meeting.pageId;
    }
  }
  const rootId = await ensureMeetingNotesRoot(ctx);
  return ctx.db.insert("pages", {
    title: meeting.title,
    icon: "🎙️",
    kind: "doc",
    parentId: rootId,
    content,
    favorite: false,
    trashed: false,
    order: Date.now(),
    updatedAt: Date.now(),
  });
}
