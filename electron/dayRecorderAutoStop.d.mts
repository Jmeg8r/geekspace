// WHAT: types for the Day Recorder's auto-stop, so tests/ can import it.

export type StopMoment = { at: number; reason: "endTime" | "midnight" };

export function stopDue(args: { stopAtMin: number | null; since: number; now: number }): StopMoment | null;

export type AutoStop = {
  update: (settings: { enabled: boolean; stopAtMin: number | null; session: number }) => void;
  check: () => Promise<void>;
};

export function createAutoStop(options: { now: () => number; stop: (due: StopMoment, target: { session: number; stopAtMin: number }) => Promise<boolean> }): AutoStop;
