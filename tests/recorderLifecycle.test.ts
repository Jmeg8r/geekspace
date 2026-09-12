import { afterEach, expect, it, vi } from "vitest";
import { recorder } from "../src/lib/recorder";
afterEach(() => {
  recorder.cancel();
  vi.unstubAllGlobals();
});
const opts = { meetingId: "fixture", title: "Test", meetingType: "general" };
it("releases the microphone when MediaRecorder construction fails", async () => {
  const stop = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop }] }),
    },
  });
  vi.stubGlobal(
    "MediaRecorder",
    class {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        throw new Error("unsupported codec");
      }
    },
  );
  await expect(recorder.start(opts)).rejects.toThrow("unsupported codec");
  expect(stop).toHaveBeenCalledOnce();
  expect(recorder.getState().status).toBe("idle");
});
it("does not open a second microphone while permission is pending", async () => {
  let rejectPermission = (_err: Error) => {};
  const permission = new Promise<never>((_resolve, reject) => {
    rejectPermission = reject;
  });
  const getUserMedia = vi.fn(() => permission);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const first = recorder.start(opts);
  // Attach the rejection handler before resolving the permission request.
  const firstResult = expect(first).rejects.toThrow("denied");
  const second = recorder.start(opts);
  rejectPermission(new Error("denied"));
  await firstResult;
  await expect(second).rejects.toThrow("Already recording");
  expect(getUserMedia).toHaveBeenCalledOnce();
});

it("closes a microphone granted after the pending start was cancelled", async () => {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  let grant = () => {};
  const permission = new Promise((resolve) => {
    grant = () => resolve(stream);
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: () => permission },
  });
  const start = recorder.start(opts);
  recorder.cancel();
  grant();
  await expect(start).rejects.toThrow("cancelled");
  expect(stop).toHaveBeenCalledOnce();
  expect(recorder.getState().status).toBe("idle");
});
