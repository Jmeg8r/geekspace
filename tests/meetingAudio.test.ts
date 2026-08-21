// WHAT: guards the silent-recording detector that sits between ffmpeg and whisper.
// WHY: the fixtures below are real `volumedetect` output from this app's own
// meetings — two of which were recorded against a dead input device and only
// surfaced 30+ minutes later as hallucinated whisper filler ("you you you…").
import { describe, expect, it } from "vitest";
import { isSilentAudio, parseVolumeStats } from "../electron/meetingProcessor.mjs";

/** Shape a realistic ffmpeg volumedetect stderr block. */
const stderr = (mean: string, max: string) => `
[Parsed_volumedetect_0 @ 0x8dd038900] n_samples: 124490880
[Parsed_volumedetect_0 @ 0x8dd038900] mean_volume: ${mean} dB
[Parsed_volumedetect_0 @ 0x8dd038900] max_volume: ${max} dB
[Parsed_volumedetect_0 @ 0x8dd038900] histogram_58db: 4
`;

describe("parseVolumeStats", () => {
  it("reads mean and peak from ffmpeg output", () => {
    expect(parseVolumeStats(stderr("-24.0", "0.0"))).toEqual({
      meanDb: -24.0,
      peakDb: 0.0,
    });
  });

  it("maps ffmpeg's -inf to -Infinity", () => {
    expect(parseVolumeStats(stderr("-inf", "-inf"))).toEqual({
      meanDb: -Infinity,
      peakDb: -Infinity,
    });
  });

  it("returns NaN for stats ffmpeg did not report", () => {
    const { meanDb, peakDb } = parseVolumeStats("ffmpeg: some unrelated failure");
    expect(meanDb).toBeNaN();
    expect(peakDb).toBeNaN();
  });
});

describe("isSilentAudio", () => {
  it("passes a healthy meeting (Jul 16: 73min, 44k-char transcript)", () => {
    expect(isSilentAudio(parseVolumeStats(stderr("-24.0", "0.0")))).toBe(false);
  });

  it("passes a quiet but usable recording", () => {
    expect(isSilentAudio(parseVolumeStats(stderr("-42.9", "-22.1")))).toBe(false);
  });

  it("flags a stone-dead input device (Jul 28: 43min, transcript was 347x 'you')", () => {
    expect(isSilentAudio(parseVolumeStats(stderr("-91.0", "-58.5")))).toBe(true);
  });

  it("flags a device that only blips (Jul 26: 78min, peak -13dB but mean -76.5dB)", () => {
    // WHY this case matters: a peak-only check passes -13dB and would have let
    // this recording through to a full whisper run and a nonsense summary.
    expect(isSilentAudio(parseVolumeStats(stderr("-76.5", "-13.0")))).toBe(true);
  });

  it("flags digital silence reported as -inf", () => {
    expect(isSilentAudio(parseVolumeStats(stderr("-inf", "-inf")))).toBe(true);
  });

  it("fails open when levels could not be measured", () => {
    // Losing a good recording is worse than one wasted transcription run.
    expect(isSilentAudio(parseVolumeStats("no stats here"))).toBe(false);
  });
});
