// WHAT: keeps each stopped recording until it is stored, so a failed upload can be retried.
// WHY: once the recorder stops, this is the only copy of a meeting's audio. Losing it on an
// upload error meant losing the meeting (Codex review of PR #56). Held per meeting, so a
// second recording never displaces the first. Dependencies are injected so the retention
// rules are testable without the recorder or the backend.

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
  const unsaved = new Map<string, StoppedRecording>();
  const inFlight = new Map<string, Promise<StoppedRecording>>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());

  /** Store one meeting's held audio. A save already in flight for it is joined, never repeated. */
  function saveOne(meetingId: string): Promise<StoppedRecording> {
    const running = inFlight.get(meetingId);
    if (running) return running;
    const recording = unsaved.get(meetingId);
    if (!recording) return Promise.reject(new Error("No unsaved audio for this meeting"));
    const attempt = (async () => {
      try {
        await deps.store(recording);
        unsaved.delete(meetingId);
        return recording;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps
          .reportFailure(recording, message)
          .catch((reportErr) => console.warn("Could not report the save failure", reportErr));
        throw err;
      } finally {
        inFlight.delete(meetingId);
        changed();
      }
    })();
    inFlight.set(meetingId, attempt);
    changed();
    return attempt;
  }

  async function stopLive(): Promise<StoppedRecording | null> {
    if (!deps.isRecording()) return null;
    const recording = await deps.stop();
    unsaved.set(recording.meetingId, recording);
    changed();
    return recording;
  }

  return {
    /** True when a live recording or held audio exists, i.e. saveAll has work to do. */
    hasWork: (): boolean => deps.isRecording() || unsaved.size > 0,

    /** Stop the live recording and store it. On failure its audio stays held for retry(). */
    async stopAndSave(): Promise<StoppedRecording> {
      const recording = await stopLive();
      if (!recording) throw new Error("Not recording");
      return saveOne(recording.meetingId);
    },

    /** Store one meeting's held audio again. */
    retry: (meetingId: string): Promise<StoppedRecording> => saveOne(meetingId),

    /**
     * Before quitting: stop any live recording, then store every held recording (joining
     * saves already in flight). Throws after trying them all if any failed.
     */
    async saveAll(): Promise<{ stored: StoppedRecording[] }> {
      await stopLive();
      const ids = new Set([...unsaved.keys(), ...inFlight.keys()]);
      const results = await Promise.allSettled([...ids].map((id) => saveOne(id)));
      const stored = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = results.flatMap((r) =>
        r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []
      );
      if (failed.length > 0) {
        throw new Error(`${failed.length} recording(s) could not be saved: ${failed.join("; ")}`);
      }
      return { stored };
    },

    pending: {
      has: (meetingId: string): boolean => unsaved.has(meetingId),
      /** True while a save is in flight or stopped audio is still held. */
      busy: (): boolean => inFlight.size > 0 || unsaved.size > 0,
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}
