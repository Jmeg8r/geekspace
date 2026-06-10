import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// WHAT: Convex file storage plumbing for editor image uploads.

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => ctx.storage.getUrl(args.storageId),
});
