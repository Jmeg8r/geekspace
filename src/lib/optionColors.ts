import { OPTION_COLOR_IDS, type OptionColorId } from "../../convex/lib/types";

function valid(c?: string | null): OptionColorId {
  return OPTION_COLOR_IDS.includes(c as OptionColorId) ? (c as OptionColorId) : "gray";
}

export const chipClass = (c?: string | null) => `chip chip-${valid(c)}`;
export const swatchClass = (c?: string | null) => `swatch-${valid(c)}`;
/** Color variable class for calendar cards — pair with `evt` or `task-block`. */
export const colorVarClass = (c?: string | null) => `evt-${valid(c)}`;

/** Pick the least-used palette color for a new select option. */
export function nextOptionColor(used: string[]): OptionColorId {
  const counts = new Map<string, number>(OPTION_COLOR_IDS.map((c) => [c, 0]));
  for (const u of used) {
    if (counts.has(u)) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  // Skip gray for fresh options — it reads as "empty".
  let best: OptionColorId = "orange";
  let bestCount = Number.POSITIVE_INFINITY;
  for (const c of OPTION_COLOR_IDS) {
    if (c === "gray") continue;
    const n = counts.get(c) ?? 0;
    if (n < bestCount) {
      best = c as OptionColorId;
      bestCount = n;
    }
  }
  return best;
}
