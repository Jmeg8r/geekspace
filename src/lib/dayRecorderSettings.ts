// WHAT: the rules behind the Day Recorder's Settings section (plan PR 3e-2): the denylist
// editor, the screenshot interval, and the onboarding copy shown before the first prompts.
// WHY the server's own checks: convex/dayRecorder.ts validates the same fields at the trust
// boundary, so the editor refuses exactly what the server would, with the same words.
import { assertBundleId, assertShotSec, assertStopAtMin } from "../../convex/lib/dayRecorder";

type AddResult = { ok: true; list: string[] } | { ok: false; error: string };

/** Add a bundle id to the denylist, or say why it can't be added. */
export function addBundleId(list: string[], input: string): AddResult {
  const id = input.trim();
  if (!id) return { ok: false, error: "Enter an app bundle id, like com.apple.TextEdit." };
  try {
    assertBundleId(id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (list.includes(id)) return { ok: false, error: `${id} is already on the list.` };
  return { ok: true, list: [...list, id] };
}

const MINUTES_PER_HOUR = 60;
const TIME_FIELD = /^(\d{2}):(\d{2})$/;

type StopAtResult = { ok: true; value: number | null } | { ok: false; error: string };

/** A time field's value ("HH:MM", or empty for none) as the server's end time (plan PR 7). */
export function stopAtFromInput(input: string): StopAtResult {
  if (input === "") return { ok: true, value: null };
  const match = TIME_FIELD.exec(input);
  const minutes = match ? Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]) : NaN;
  if (!match || Number(match[2]) >= MINUTES_PER_HOUR) return { ok: false, error: "Enter a time like 18:00." };
  try {
    assertStopAtMin(minutes);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, value: minutes };
}

/** The server's end time as a time field's value. */
export function stopAtToInput(minutes: number | null): string {
  if (minutes === null) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / MINUTES_PER_HOUR))}:${pad(minutes % MINUTES_PER_HOUR)}`;
}

/** Why an interval would be refused, or null when it is fine. */
export function shotSecError(value: number): string | null {
  try {
    assertShotSec(value);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The recorder runs on macOS only; an `unsupported` status says so too. */
export function recorderSupported(platform: string, status: { status: string } | null): boolean {
  if (status?.status === "unsupported") return false;
  return platform === "darwin" || platform.startsWith("Mac");
}

export const UNSUPPORTED = "Recording your day needs macOS. Geekspace on this computer can't capture.";

// Spec, Security and data: macOS asks for two separate grants (settled on a clean user in
// 3c part 2), and the mic asks once on its own.
export const ONBOARDING = {
  title: "Before you turn it on",
  intro: "macOS will ask for permission. Allow each prompt, or the Day Recorder can't capture.",
  steps: [
    "Geekspace would like to record your system audio: this lets it hear calls and videos playing on this Mac.",
    "Bypass the system private window picker: this lets it take screenshots on its own, without asking each time.",
    "The microphone, if you haven't allowed it for meeting notes already.",
    "While it records, the menu bar says Recording. ⌥⌘R pauses and resumes.",
  ],
};
