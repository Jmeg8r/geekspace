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

/**
 * Edits to a list that is saved whole. Each edit applies to the list the previous edit left,
 * not to a saved copy that has not caught up, and saves run one after another, in order.
 * WHY: two quick edits from the same stale copy each replaced the whole list, so the later
 * one undid the earlier (Codex review of PR 3e-2): an app just denied became capturable.
 * The edited list is kept until `sync` sees the page render it, because a save can finish
 * before the saved list reaches the page (round 2).
 */
export function createListEditor(save: (list: string[]) => Promise<void>) {
  let latest: string[] | null = null;
  let outstanding = 0;
  let queue: Promise<void> = Promise.resolve();

  const start = (list: string[]): Promise<void> => {
    try {
      return save(list);
    } catch (err) {
      return Promise.reject(err);
    }
  };

  return {
    /** The saved list the page renders now: once it shows the edits, they are the base again. */
    sync(saved: string[]) {
      if (outstanding === 0 && latest && sameList(saved, latest)) latest = null;
    },
    edit(saved: string[], change: (list: string[]) => string[]): Promise<void> {
      const next = change(latest ?? saved);
      latest = next;
      // With nothing pending the save starts now; otherwise after the one before it.
      const run = outstanding === 0 ? start(next) : queue.then(() => start(next));
      outstanding += 1;
      const settle = (failed: boolean) => () => {
        outstanding -= 1;
        // A failed save was never taken: with nothing else pending, the saved list is the truth.
        if (failed && outstanding === 0) latest = null;
      };
      queue = run.then(settle(false), settle(true));
      return run;
    },
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
