// WHAT: the Day Record view's logic (plan PR 6c, spec R12, R13): which local day it shows,
// what its buttons say, and how each line links to the item it came from.
// WHY labels carry their action (spec, Accessibility): a bare "Undo" or "Approve" next to a
// list doesn't say what it will do, to a screen reader or at a glance.

/** One action of the day, as convex/assistant.ts dayActions returns it. */
export type DayAction = {
  _id: string;
  kind: "createTask" | "createBlock" | "draftLinear";
  at: number;
  groupId: string;
  undoneAt?: number;
  sourceSegmentId?: string;
  sourceScreenshotId?: string;
  title?: string | null;
  start?: number;
  end?: number;
  issueRef?: string | null;
};

/** One day of the record, as convex/assistant.ts dayRecord returns it. */
export type DayRecordRows = {
  transcripts: { _id: string; segmentId: string; start: number; end: number; text: string }[];
  screenshots: { _id: string; takenAt: number; ocrText: string; purged: boolean; appBundleId?: string }[];
  more: { transcripts: boolean; screenshots: boolean };
};

export type Source = { sourceSegmentId?: string; sourceScreenshotId?: string };

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The local day `offset` days from `date`: its name (YYYY-MM-DD) and its window, local midnight
 * to the next. Stepped by calendar day, so a DST change gives a 23- or 25-hour day.
 */
export function dayWindow(date: Date, offset = 0): { day: string; from: number; to: number } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
  const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  return { day, from: start.getTime(), to: next.getTime() };
}

export type ActionGroup = { groupId: string; actions: DayAction[]; undone: boolean; at: number };

/** The day's actions as Undo sees them: one group per commitment, oldest first. */
export function groupActions(actions: DayAction[]): ActionGroup[] {
  const groups = new Map<string, DayAction[]>();
  for (const a of [...actions].sort((x, y) => x.at - y.at || x._id.localeCompare(y._id))) {
    groups.set(a.groupId, [...(groups.get(a.groupId) ?? []), a]);
  }
  return [...groups.entries()].map(([groupId, members]) => ({
    groupId,
    actions: members,
    undone: members.every((a) => a.undoneAt !== undefined),
    at: members[0].at,
  }));
}

function describe(a: DayAction): string {
  if (a.kind === "createTask") return a.title ? `added '${a.title}'` : "added a task";
  if (a.kind === "draftLinear") return a.issueRef ? `drafted an update to ${a.issueRef}` : "drafted a Linear update";
  return a.start !== undefined && a.end !== undefined ? `blocked ${clock(a.start)}–${clock(a.end)}` : "blocked time";
}

/** What the group's Undo button says: what it will undo, named by its main action. */
export function undoLabel(group: ActionGroup): string {
  const main = group.actions.find((a) => a.kind !== "createBlock") ?? group.actions[0];
  return `Undo: ${describe(main)}`;
}

/** A line describing every action of a group, for the list. */
export function groupSummary(group: ActionGroup): string {
  const text = group.actions.map(describe).join(", and ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const approveLabel = (draft: { issueRef: string }) => `Send to ${draft.issueRef}`;
export const discardLabel = (draft: { issueRef: string }) => `Discard the ${draft.issueRef} draft`;

export const segmentAnchor = (segmentId: string) => `src-seg-${segmentId}`;
export const screenshotAnchor = (screenshotId: string) => `src-shot-${screenshotId}`;

export type TimelineEntry =
  | { kind: "transcript"; at: number; anchor: string; row: DayRecordRows["transcripts"][number] }
  | { kind: "screenshot"; at: number; anchor: string; row: DayRecordRows["screenshots"][number] };

/** The day's transcripts and screens in one list, oldest first. */
export function timeline(record: DayRecordRows): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...record.transcripts.map((row) => ({ kind: "transcript" as const, at: row.start, anchor: segmentAnchor(row.segmentId), row })),
    ...record.screenshots.map((row) => ({ kind: "screenshot" as const, at: row.takenAt, anchor: screenshotAnchor(row._id), row })),
  ];
  return entries.sort((a, b) => a.at - b.at);
}

/** Where a line came from in the day's record, or null when its source is not that day's. */
export function sourceLink(source: Source, record: DayRecordRows): { anchor: string; text: string } | null {
  if (source.sourceSegmentId) {
    const t = record.transcripts.find((r) => r.segmentId === source.sourceSegmentId);
    return t ? { anchor: segmentAnchor(t.segmentId), text: `said at ${clock(t.start)}` } : null;
  }
  if (source.sourceScreenshotId) {
    const s = record.screenshots.find((r) => r._id === source.sourceScreenshotId);
    return s ? { anchor: screenshotAnchor(s._id), text: `on screen at ${clock(s.takenAt)}` } : null;
  }
  return null;
}
