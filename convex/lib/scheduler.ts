// WHAT: The auto-scheduling engine. Pure, deterministic, dependency-free.
// WHY: pure functions are unit-testable and run identically inside Convex
// mutations and (if ever needed) the renderer. All the "Motion/Reclaim-style"
// behavior lives here: working hours, fixed events, EDF + priority ordering,
// chunking, buffers, locked blocks, past-due placement, capacity warnings.
//
// Timezone model: we use a fixed UTC offset (minutes BEHIND UTC, i.e. the value
// of Date.getTimezoneOffset()). The schedule is recomputed constantly as the
// user works, so near-term blocks are always correct; far-future blocks across
// a DST switch may shift by an hour until the next reflow. Acceptable tradeoff
// for a single-user tool — documented in the README.

export const MIN_MS = 60_000;
export const DAY_MS = 86_400_000;
/** System-wide floor: never create a block shorter than this. */
export const MIN_BLOCK_FLOOR_MIN = 15;

export interface SchedulerConfig {
  workDays: number[]; // 0=Sun .. 6=Sat
  dayStartMin: number; // minutes from local midnight
  dayEndMin: number;
  minChunkMin: number;
  maxChunkMin: number;
  bufferMin: number;
  horizonDays: number;
  granularityMin: number;
  tzOffsetMin: number;
}

export interface SchedulerTask {
  id: string;
  title: string;
  remainingMin: number;
  dueMs?: number;
  priority: number; // 0=urgent .. 3=low
  earliestMs?: number;
  noSplit?: boolean;
  /** Task ids that must finish before this one starts (dependencies). */
  blockedBy?: string[];
}

export interface Interval {
  start: number;
  end: number;
}

export interface ScheduledBlock {
  taskId: string;
  start: number;
  end: number;
  pastDue: boolean;
}

export interface SchedulerWarning {
  taskId: string;
  title: string;
  unscheduledMin: number;
  reason: "no_capacity" | "past_due" | "dependency_cycle";
}

export interface ScheduleResult {
  blocks: ScheduledBlock[];
  warnings: SchedulerWarning[];
}

export function ceilTo(ms: number, granularityMin: number): number {
  const g = granularityMin * MIN_MS;
  return Math.ceil(ms / g) * g;
}

/** UTC ms of local midnight for the local day containing `ms`. */
export function localDayStartUtc(ms: number, tzOffsetMin: number): number {
  const local = new Date(ms - tzOffsetMin * MIN_MS);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) +
    tzOffsetMin * MIN_MS
  );
}

/** Local weekday (0-6) of the local day containing `ms`. */
export function localWeekday(ms: number, tzOffsetMin: number): number {
  return new Date(ms - tzOffsetMin * MIN_MS).getUTCDay();
}

/**
 * Convert a calendar date (stored as UTC midnight, see DateValue convention)
 * to an epoch ms at `minOfDay` local time.
 */
export function calendarDateToLocalMs(
  dateOnlyUtcMidnight: number,
  tzOffsetMin: number,
  minOfDay: number
): number {
  return dateOnlyUtcMidnight + tzOffsetMin * MIN_MS + minOfDay * MIN_MS;
}

/** Epoch ms → calendar date (UTC midnight) in the given offset's local frame. */
export function localMsToCalendarDate(ms: number, tzOffsetMin: number): number {
  const local = new Date(ms - tzOffsetMin * MIN_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

function subtract(window: Interval, busy: Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = window.start;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end });
  return out;
}

/** Working-hour windows over the horizon, clipped to start no earlier than nowSnap. */
export function buildDayWindows(nowMs: number, cfg: SchedulerConfig): Interval[] {
  const nowSnap = ceilTo(nowMs, cfg.granularityMin);
  const firstDay = localDayStartUtc(nowMs, cfg.tzOffsetMin);
  const windows: Interval[] = [];
  for (let d = 0; d < cfg.horizonDays; d++) {
    const dayStart = firstDay + d * DAY_MS;
    // WHY: weekday read at local noon avoids edge effects at exact midnight.
    const weekday = localWeekday(dayStart + 12 * 60 * MIN_MS, cfg.tzOffsetMin);
    if (!cfg.workDays.includes(weekday)) continue;
    const start = Math.max(dayStart + cfg.dayStartMin * MIN_MS, nowSnap);
    const end = dayStart + cfg.dayEndMin * MIN_MS;
    if (end - start >= MIN_BLOCK_FLOOR_MIN * MIN_MS) windows.push({ start, end });
  }
  return windows;
}

function compareTasks(a: SchedulerTask, b: SchedulerTask): number {
  const dueA = a.dueMs ?? Number.POSITIVE_INFINITY;
  const dueB = b.dueMs ?? Number.POSITIVE_INFINITY;
  if (dueA !== dueB) return dueA - dueB;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.remainingMin !== b.remainingMin) return b.remainingMin - a.remainingMin;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Greedy earliest-fit scheduler with dependency awareness.
 * Ordering: hard deadline asc → priority desc → estimate desc (per Motion/Reclaim
 * conventions), processed topologically — a task never starts before its
 * blockers' last scheduled block ends. Notion treats dependencies as visual
 * metadata; here they actually shape the plan. Each placement consumes free
 * time (plus buffer), so the loop always makes forward progress.
 */
export function computeSchedule(
  nowMs: number,
  tasks: SchedulerTask[],
  busy: Interval[],
  cfg: SchedulerConfig
): ScheduleResult {
  const windows = buildDayWindows(nowMs, cfg);
  const busyExpanded = mergeIntervals(
    busy.map((b) => ({
      start: b.start - cfg.bufferMin * MIN_MS,
      end: b.end + cfg.bufferMin * MIN_MS,
    }))
  );

  let free: Interval[] = [];
  for (const w of windows) free.push(...subtract(w, busyExpanded));
  free = free
    .map((s) => ({ start: ceilTo(s.start, cfg.granularityMin), end: s.end }))
    .filter((s) => s.end - s.start >= MIN_BLOCK_FLOOR_MIN * MIN_MS);

  const blocks: ScheduledBlock[] = [];
  const warnings: SchedulerWarning[] = [];
  const ordered = [...tasks]
    .filter((t) => t.remainingMin > 0)
    .sort(compareTasks);

  // Topological processing: among tasks whose blockers are all satisfied, keep
  // the EDF/priority order. A blocker outside the set (done, or unschedulable)
  // counts as satisfied. If nothing is eligible, there's a cycle — schedule
  // anyway and warn rather than dropping work.
  const inSet = new Set(ordered.map((t) => t.id));
  const finishedAt = new Map<string, number>();
  const pending = [...ordered];

  while (pending.length > 0) {
    let idx = pending.findIndex((t) =>
      (t.blockedBy ?? []).every((b) => !inSet.has(b) || finishedAt.has(b))
    );
    const inCycle = idx === -1;
    if (inCycle) idx = 0;
    const task = pending.splice(idx, 1)[0];
    if (inCycle) {
      warnings.push({
        taskId: task.id,
        title: task.title,
        unscheduledMin: 0,
        reason: "dependency_cycle",
      });
    }

    const blockerEnds = (task.blockedBy ?? [])
      .filter((b) => finishedAt.has(b))
      .map((b) => finishedAt.get(b)!);
    const depEarliestMs = blockerEnds.length > 0 ? Math.max(...blockerEnds) : 0;

    let rem = Math.max(task.remainingMin, MIN_BLOCK_FLOOR_MIN);
    const earliest = ceilTo(
      Math.max(task.earliestMs ?? 0, depEarliestMs),
      cfg.granularityMin
    );
    let placedPastDue = false;
    let lastEnd = earliest;

    let i = 0;
    while (i < free.length && rem > 0) {
      const slot = free[i];
      const start = Math.max(slot.start, earliest);
      const startSnapped = ceilTo(start, cfg.granularityMin);
      const availMin = Math.floor((slot.end - startSnapped) / MIN_MS);
      const minNeeded = Math.min(rem, Math.max(cfg.minChunkMin, MIN_BLOCK_FLOOR_MIN));

      if (availMin < minNeeded || (task.noSplit && availMin < rem)) {
        i++;
        continue;
      }

      const cap = task.noSplit ? rem : Math.min(rem, cfg.maxChunkMin);
      const chunk = Math.min(cap, availMin);
      const end = startSnapped + chunk * MIN_MS;
      const pastDue = task.dueMs !== undefined && end > task.dueMs;
      if (pastDue) placedPastDue = true;
      blocks.push({ taskId: task.id, start: startSnapped, end, pastDue });
      lastEnd = Math.max(lastEnd, end);
      rem -= chunk;

      // Consume the slot: keep the left remainder (other tasks may use it) and
      // the right remainder after a buffer gap.
      const replacements: Interval[] = [];
      if (startSnapped - slot.start >= MIN_BLOCK_FLOOR_MIN * MIN_MS) {
        replacements.push({ start: slot.start, end: startSnapped });
      }
      const rightStart = ceilTo(end + cfg.bufferMin * MIN_MS, cfg.granularityMin);
      if (slot.end - rightStart >= MIN_BLOCK_FLOOR_MIN * MIN_MS) {
        replacements.push({ start: rightStart, end: slot.end });
      }
      free.splice(i, 1, ...replacements);
      // WHY: restart the scan — placement may have left an earlier-fitting
      // remainder for the next chunk; total free time strictly decreased, so
      // this terminates.
      i = 0;
    }

    if (rem > 0) {
      warnings.push({
        taskId: task.id,
        title: task.title,
        unscheduledMin: rem,
        reason: "no_capacity",
      });
    } else if (placedPastDue) {
      warnings.push({
        taskId: task.id,
        title: task.title,
        unscheduledMin: 0,
        reason: "past_due",
      });
    }
    finishedAt.set(task.id, lastEnd);
  }

  blocks.sort((a, b) => a.start - b.start);
  return { blocks, warnings };
}
