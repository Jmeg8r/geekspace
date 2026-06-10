// WHAT: Default workspace settings (working hours, scheduling knobs, theme).
// WHY: queries must not write, so reads merge these defaults until the first
// mutation persists a settings document.

export const DEFAULT_SETTINGS = {
  key: "global",
  theme: "system",
  workDays: [1, 2, 3, 4, 5], // Mon-Fri
  dayStartMin: 9 * 60,
  dayEndMin: 18 * 60,
  minChunkMin: 30,
  maxChunkMin: 120,
  bufferMin: 10,
  horizonDays: 14,
  granularityMin: 15,
  tzOffsetMin: 240, // America/New_York (EDT) until the client reports its own
};
