import { OPTION_COLOR_IDS, type OptionColorId } from "../../convex/lib/types";

function valid(c?: string | null): OptionColorId {
  return OPTION_COLOR_IDS.includes(c as OptionColorId) ? (c as OptionColorId) : "gray";
}

export const chipClass = (c?: string | null) => `chip chip-${valid(c)}`;
export const swatchClass = (c?: string | null) => `swatch-${valid(c)}`;
/** Color variable class for calendar cards — pair with `evt` or `task-block`. */
export const colorVarClass = (c?: string | null) => `evt-${valid(c)}`;

/** Stable, non-gray palette color derived from a key (e.g. a project id), so
 *  the same project always reads as the same color without storing one. */
export function hashColor(key: string): OptionColorId {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const colors = OPTION_COLOR_IDS.filter((c) => c !== "gray");
  return colors[Math.abs(h) % colors.length];
}

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
