// WHAT: keeps a stopped recording until it is stored, so a failed upload can be retried.
// WHY: once the recorder stops, this is the only copy of the audio. Losing it on an
// upload error meant losing the meeting (Codex review of PR #56). Dependencies are
// injected so the retention rules are testable without the recorder or the backend.

export interface StoppedRecording {
  blob: Blob;
  durationSec: number;
  meetingId: string;
  meetingType: string;
}

export interface AudioSaverDeps {
  isRecording: () => boolean;
  stop: () => Promise<StoppedRecording>;
  /** Upload and attach the audio; throws on failure. */
  store: (recording: StoppedRecording) => Promise<void>;
  /** Tell the user the save failed (the audio is still held). */
  reportFailure: (recording: StoppedRecording, message: string) => Promise<void>;
}

export function createAudioSaver(deps: AudioSaverDeps) {
  let unsaved: StoppedRecording | null = null;
  let saving = false;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());

  return {
    /** True when a live recording or unsaved audio exists, i.e. save() has work to do. */
    hasWork: (): boolean => deps.isRecording() || unsaved !== null,

    /** Stop the live recording (if any) and store it, or retry storing held audio. */
    async save(): Promise<StoppedRecording> {
      // One upload at a time: a second would store the same audio twice.
      if (saving) throw new Error("The recording is already being saved");
      if (deps.isRecording()) {
        unsaved = await deps.stop();
        changed();
      }
      const recording = unsaved;
      if (!recording) throw new Error("No recording to save");
      saving = true;
      changed();
      try {
        await deps.store(recording);
        unsaved = null;
        return recording;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps
          .reportFailure(recording, message)
          .catch((reportErr) => console.warn("Could not report the save failure", reportErr));
        throw err;
      } finally {
        saving = false;
        changed();
      }
    },

    pending: {
      has: (meetingId: string): boolean => unsaved?.meetingId === meetingId,
      /** True while a save is in flight or stopped audio is still unsaved. */
      busy: (): boolean => saving || unsaved !== null,
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}
