// WHAT: the rules behind the Day Recorder's Settings section (plan PR 3e-2): the denylist
// editor, the screenshot interval, and the onboarding copy shown before the first prompts.
// WHY the server's own checks: convex/dayRecorder.ts validates the same fields at the trust
// boundary, so the editor refuses exactly what the server would, with the same words.
import { assertBundleId, assertShotSec } from "../../convex/lib/dayRecorder";

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

export function removeBundleId(list: string[], id: string): string[] {
  return list.filter((entry) => entry !== id);
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
