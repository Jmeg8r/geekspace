import { v, type Infer } from "convex/values";

// WHAT: one action the Day Recorder assistant proposes (plan PR 6a, spec R10, R12), as the
// main process hands it over and as a request keeps it until it is applied. Its own module so
// the schema can store it without importing the assistant's functions.

const source = {
  sourceSegmentId: v.optional(v.id("captureSegments")),
  sourceScreenshotId: v.optional(v.id("screenshots")),
};

export const proposal = v.union(
  v.object({
    type: v.literal("createTask"),
    title: v.string(),
    estimateMin: v.number(),
    dueMs: v.optional(v.number()),
    block: v.optional(v.object({ start: v.number(), end: v.number() })),
    ...source,
  }),
  v.object({
    type: v.literal("draftLinear"),
    issueRef: v.string(),
    body: v.string(),
    ...source,
  })
);

export type Proposal = Infer<typeof proposal>;
