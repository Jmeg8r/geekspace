import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// WHAT: Convex file storage plumbing for editor image uploads.

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

/**
 * Delete an upload whose record never got saved (the client calls this when the follow-up
 * mutation fails). Refuses — returning false — if a doc or a meeting still references the
 * file, so a wrong id can't destroy something in use.
 */
export const discardUnattached = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const docs = await ctx.db.query("docs").collect();
    if (docs.some((d) => d.storageId === args.storageId)) return false;
    const meetings = await ctx.db.query("meetings").collect();
    if (meetings.some((m) => m.audioStorageId === args.storageId)) return false;
    await ctx.storage.delete(args.storageId);
    return true;
  },
});

export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => ctx.storage.getUrl(args.storageId),
});
