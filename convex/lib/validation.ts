import type { SchedulerConfig } from "./scheduler";

export function validateRange(start: number, end: number) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    Math.abs(start) > 8.64e15 ||
    Math.abs(end) > 8.64e15
  ) {
    throw new Error("End must be after start, with valid dates");
  }
}

export function validateSchedulerConfig(s: SchedulerConfig) {
  const integer = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  if (
    !s.workDays.every((day) => integer(day, 0, 6)) ||
    new Set(s.workDays).size !== s.workDays.length ||
    !integer(s.dayStartMin, 0, 1439) ||
    !integer(s.dayEndMin, 1, 1440) ||
    s.dayEndMin <= s.dayStartMin ||
    !integer(s.minChunkMin, 15, 1440) ||
    !integer(s.maxChunkMin, s.minChunkMin, 1440) ||
    !integer(s.bufferMin, 0, 1440) ||
    !integer(s.horizonDays, 1, 90) ||
    !integer(s.granularityMin, 1, 60) ||
    !integer(s.tzOffsetMin, -840, 840)
  ) {
    throw new Error(
      "Invalid scheduling settings: check hours, chunks, horizon and timezone",
    );
  }
}
