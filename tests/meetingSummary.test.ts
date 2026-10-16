import { afterEach, describe, expect, it, vi } from "vitest";
import { isNoSpeech, notesFromTranscript, summarizeTranscript } from "../electron/meetingProcessor.mjs";

// WHAT: the transcript → notes half of the meeting pipeline, against a stubbed Ollama.
// See docs/changes/2026-10-15-meetings/.

const OLLAMA = "http://ollama.test";

/** Stub Ollama: /api/tags lists one model; /api/generate answers via `reply(prompt)`. */
function stubOllama(reply: (prompt: string) => string) {
  const prompts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "gemma3:12b" }] });
      if (url.endsWith("/api/generate")) {
        const prompt = String(JSON.parse(init?.body ?? "{}").prompt);
        prompts.push(prompt);
        return Response.json({ response: reply(prompt) });
      }
      return new Response("not found", { status: 404 });
    })
  );
  return prompts;
}

const notes = (summary: string) =>
  JSON.stringify({ summary, key_points: [summary], decisions: [], action_items: [] });

afterEach(() => vi.unstubAllGlobals());

describe("isNoSpeech", () => {
  it("accepts short real speech", () => {
    // The old character-class regex deleted every B, L, A, N, K, U, D, I, O: "Hello world" → "hewrl".
    expect(isNoSpeech("Hello world")).toBe(false);
  });

  it("rejects whisper's non-speech markers on their own", () => {
    expect(isNoSpeech("[BLANK_AUDIO]")).toBe(true);
    expect(isNoSpeech(" [Music]\n(silence)  [BLANK_AUDIO] ")).toBe(true);
    expect(isNoSpeech("")).toBe(true);
  });
});

describe("summarizeTranscript", () => {
  it("sends a long transcript to the model in full, across sections, then merges", async () => {
    const words = Array.from({ length: 12000 }, (_, i) => `w${i}`);
    const transcript = words.join(" ");
    expect(transcript.length).toBeGreaterThan(60_000);
    const prompts = stubOllama((p) => (p.includes("PARTIAL NOTES") ? notes("merged") : notes("part")));

    const result = await summarizeTranscript(transcript, "general", OLLAMA, "");

    const sectionPrompts = prompts.filter((p) => !p.includes("PARTIAL NOTES"));
    expect(sectionPrompts.length).toBeGreaterThan(1);
    const seen = sectionPrompts.join(" ");
    for (const w of [words[0], words[6000], words[11999]]) expect(seen).toMatch(new RegExp(`\\b${w}\\b`));
    expect(prompts.filter((p) => p.includes("PARTIAL NOTES"))).toHaveLength(1);
    expect(result.summary).toBe("merged");
  });

  it("uses one request for a short transcript", async () => {
    const prompts = stubOllama(() => notes("short"));
    const result = await summarizeTranscript("we agreed to ship on friday", "general", OLLAMA, "");
    expect(prompts).toHaveLength(1);
    expect(result.summary).toBe("short");
  });

  it("fails loud on an unparseable or empty summary instead of a placeholder", async () => {
    stubOllama(() => "I could not do that");
    await expect(summarizeTranscript("some real words here", "general", OLLAMA, "")).rejects.toThrow();
    stubOllama(() => JSON.stringify({ summary: "  ", key_points: [] }));
    await expect(summarizeTranscript("some real words here", "general", OLLAMA, "")).rejects.toThrow(
      /no usable summary/i
    );
  });
});

describe("notesFromTranscript", () => {
  it("keeps the transcript when the summary fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      })
    );
    const result = await notesFromTranscript("the full transcript text", "general", OLLAMA, "");
    expect(result.transcript).toBe("the full transcript text");
    expect(result.summaryError).toMatch(/not reachable/i);
  });
});
