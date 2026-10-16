import { describe, expect, it, vi } from "vitest";
import { createAudioSaver, type AudioSaverDeps, type StoppedRecording } from "../src/lib/audioSaver";

// WHAT: a stopped recording survives a failed upload until it is stored, per meeting.
// Codex review of PR #56, rounds 1 and 2. See docs/changes/2026-10-15-meetings/.

const recordingFor = (meetingId: string): StoppedRecording => ({
  blob: new Blob([`audio ${meetingId}`], { type: "audio/webm" }),
  durationSec: 60,
  meetingId,
  meetingType: "general",
});

/** A recorder that is live until stopped, and a store whose outcome each test controls. */
function harness(store: AudioSaverDeps["store"]) {
  const state = { live: "m1" as string | null };
  const stored: string[] = [];
  const failures: string[] = [];
  const saver = createAudioSaver({
    isRecording: () => state.live !== null,
    stop: async () => {
      const id = state.live ?? "none";
      state.live = null;
      return recordingFor(id);
    },
    store: async (recording) => {
      await store(recording);
      stored.push(recording.meetingId);
    },
    reportFailure: async (recording, message) => {
      failures.push(`${recording.meetingId}: ${message}`);
    },
  });
  return { saver, stored, failures, state };
}

/** A store that waits until the test releases it. */
function heldStore() {
  const gate = { release: () => {}, started: 0 };
  const store = () =>
    new Promise<void>((resolve) => {
      gate.started += 1;
      gate.release = resolve;
    });
  return { gate, store };
}

describe("createAudioSaver", () => {
  it("keeps the audio after a failed save, so a retry of that meeting stores it", async () => {
    let up = false;
    const { saver, stored, failures } = harness(async () => {
      if (!up) throw new Error("Audio upload failed (503)");
    });

    await expect(saver.stopAndSave()).rejects.toThrow(/503/);
    expect(failures).toEqual(["m1: Audio upload failed (503)"]);
    expect(saver.pending.has("m1")).toBe(true);
    expect(saver.pending.busy()).toBe(true);
    expect(saver.hasWork()).toBe(true);

    up = true;
    await saver.retry("m1");
    expect(stored).toEqual(["m1"]);
    expect(saver.pending.has("m1")).toBe(false);
    expect(saver.pending.busy()).toBe(false);
    expect(saver.hasWork()).toBe(false);
  });

  it("never drops one meeting's unsaved audio when another recording stops", async () => {
    let up = false;
    const { saver, stored, state } = harness(async () => {
      if (!up) throw new Error("down");
    });
    await expect(saver.stopAndSave()).rejects.toThrow("down");
    state.live = "m2";
    await expect(saver.stopAndSave()).rejects.toThrow("down");
    expect(saver.pending.has("m1")).toBe(true);
    expect(saver.pending.has("m2")).toBe(true);

    up = true;
    const result = await saver.saveAll();
    expect(result.stored.map((r) => r.meetingId).sort()).toEqual(["m1", "m2"]);
    expect(stored.sort()).toEqual(["m1", "m2"]);
    expect(saver.hasWork()).toBe(false);
  });

  it("saveAll stops a live recording and stores it along with held audio", async () => {
    let up = false;
    const { saver, state } = harness(async () => {
      if (!up) throw new Error("down");
    });
    await expect(saver.stopAndSave()).rejects.toThrow("down");
    state.live = "m2";
    up = true;
    const result = await saver.saveAll();
    expect(result.stored.map((r) => r.meetingId).sort()).toEqual(["m1", "m2"]);
    expect(state.live).toBeNull();
  });

  it("saveAll stores what it can and then reports what failed", async () => {
    const { saver, state } = harness(async (r) => {
      if (r.meetingId === "m1") throw new Error("m1 down");
    });
    await expect(saver.stopAndSave()).rejects.toThrow("m1 down");
    state.live = "m2";
    await expect(saver.saveAll()).rejects.toThrow(/m1 down/);
    expect(saver.pending.has("m1")).toBe(true);
    expect(saver.pending.has("m2")).toBe(false);
  });

  it("reports busy while an upload is in flight, after the recorder is already idle", async () => {
    const { gate, store } = heldStore();
    const { saver, state } = harness(store);
    const saving = saver.stopAndSave();
    await vi.waitFor(() => expect(gate.started).toBe(1));
    expect(state.live).toBeNull();
    expect(saver.pending.busy()).toBe(true);
    gate.release();
    await saving;
    expect(saver.pending.busy()).toBe(false);
  });

  it("a second save of the same meeting joins the one in flight instead of uploading twice", async () => {
    const { gate, store } = heldStore();
    const { saver, stored } = harness(store);
    const first = saver.stopAndSave();
    await vi.waitFor(() => expect(gate.started).toBe(1));
    const second = saver.saveAll();
    gate.release();
    await first;
    await second;
    expect(gate.started).toBe(1);
    expect(stored).toEqual(["m1"]);
  });

  it("notifies subscribers as the pending state changes", async () => {
    const { saver } = harness(async () => {});
    const seen: boolean[] = [];
    const off = saver.pending.subscribe(() => seen.push(saver.pending.busy()));
    await saver.stopAndSave();
    off();
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
  });
});
