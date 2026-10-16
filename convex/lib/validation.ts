import type { SchedulerConfig } from "./scheduler";

// WHAT: bounds for the auto-scheduler's settings, checked where they are saved and before
// every schedule run. WHY: the Settings UI clamps its inputs, but settings.update is also
// reachable from MCP, and a zero chunk size or an inverted working day would stall or
// corrupt the engine. Ported from PR #28. See docs/changes/2026-10-15-scheduler-correctness/.

const MINUTES_PER_DAY = 1440;
const MIN_CHUNK_FLOOR_MIN = 15;
const MAX_HORIZON_DAYS = 90;
const MAX_GRANULARITY_MIN = 60;
// UTC−14:00 to UTC+14:00 cover every real timezone.
const MAX_TZ_OFFSET_MIN = 14 * 60;

export function validateSchedulerConfig(s: SchedulerConfig): void {
  const integer = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  const ok =
    s.workDays.every((day) => integer(day, 0, 6)) &&
    new Set(s.workDays).size === s.workDays.length &&
    integer(s.dayStartMin, 0, MINUTES_PER_DAY - 1) &&
    integer(s.dayEndMin, 1, MINUTES_PER_DAY) &&
    s.dayEndMin > s.dayStartMin &&
    integer(s.minChunkMin, MIN_CHUNK_FLOOR_MIN, MINUTES_PER_DAY) &&
    integer(s.maxChunkMin, s.minChunkMin, MINUTES_PER_DAY) &&
    integer(s.bufferMin, 0, MINUTES_PER_DAY) &&
    integer(s.horizonDays, 1, MAX_HORIZON_DAYS) &&
    integer(s.granularityMin, 1, MAX_GRANULARITY_MIN) &&
    integer(s.tzOffsetMin, -MAX_TZ_OFFSET_MIN, MAX_TZ_OFFSET_MIN);
  if (!ok) {
    throw new Error(
      "Invalid scheduling settings: check working days and hours, block sizes, buffer, horizon and timezone"
    );
  }
}
