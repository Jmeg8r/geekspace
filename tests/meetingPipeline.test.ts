import { describe, expect, it, vi } from "vitest";
import { createAudioSaver, type AudioSaverDeps, type StoppedRecording } from "../src/lib/audioSaver";

// WHAT: a stopped recording survives a failed upload until it is stored or discarded.
// Codex review of PR #56, round 1. See docs/changes/2026-10-15-meetings/.

const RECORDING: StoppedRecording = {
  blob: new Blob(["audio"], { type: "audio/webm" }),
  durationSec: 60,
  meetingId: "m1",
  meetingType: "general",
};

/** A recorder that is live until stopped, and a store whose outcome each test controls. */
function harness(store: AudioSaverDeps["store"]) {
  let live = true;
  const stored: StoppedRecording[] = [];
  const failures: string[] = [];
  const saver = createAudioSaver({
    isRecording: () => live,
    stop: async () => {
      live = false;
      return RECORDING;
    },
    store: async (recording) => {
      await store(recording);
      stored.push(recording);
    },
    reportFailure: async (_recording, message) => {
      failures.push(message);
    },
  });
  return { saver, stored, failures, isLive: () => live };
}

/** A store that waits until the test releases it. */
function heldStore() {
  const gate = { release: () => {}, started: false };
  const store = () =>
    new Promise<void>((resolve) => {
      gate.started = true;
      gate.release = resolve;
    });
  return { gate, store };
}

describe("createAudioSaver", () => {
  it("keeps the audio after a failed save, so a retry stores it", async () => {
    let up = false;
    const { saver, stored, failures } = harness(async () => {
      if (!up) throw new Error("Audio upload failed (503)");
    });

    await expect(saver.save()).rejects.toThrow(/503/);
    expect(failures).toEqual(["Audio upload failed (503)"]);
    expect(saver.pending.has("m1")).toBe(true);
    expect(saver.pending.busy()).toBe(true);
    expect(saver.hasWork()).toBe(true);

    up = true;
    await saver.save();
    expect(stored).toHaveLength(1);
    expect(saver.pending.has("m1")).toBe(false);
    expect(saver.pending.busy()).toBe(false);
    expect(saver.hasWork()).toBe(false);
  });

  it("reports busy while the upload is in flight, after the recorder is already idle", async () => {
    const { gate, store } = heldStore();
    const { saver, isLive } = harness(store);
    const saving = saver.save();
    await vi.waitFor(() => expect(gate.started).toBe(true));
    expect(isLive()).toBe(false);
    expect(saver.pending.busy()).toBe(true);
    gate.release();
    await saving;
    expect(saver.pending.busy()).toBe(false);
  });

  it("refuses a second save while one is in flight", async () => {
    const { gate, store } = heldStore();
    const { saver, stored } = harness(store);
    const first = saver.save();
    await vi.waitFor(() => expect(gate.started).toBe(true));
    await expect(saver.save()).rejects.toThrow(/already being saved/);
    gate.release();
    await first;
    expect(stored).toHaveLength(1);
  });

  it("notifies subscribers as the pending state changes", async () => {
    const { saver } = harness(async () => {});
    const seen: boolean[] = [];
    const off = saver.pending.subscribe(() => seen.push(saver.pending.busy()));
    await saver.save();
    off();
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
  });
});
