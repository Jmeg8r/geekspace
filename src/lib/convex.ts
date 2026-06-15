import { ConvexReactClient } from "convex/react";

// WHAT: Single Convex client shared by the React provider and imperative calls
// (e.g. the editor's image upload, which runs outside hooks).
// WHY the fallback: the renderer always talks to the local backend on :3210 (the
// Electron main process guarantees one is listening before this window loads).
// VITE_CONVEX_URL is baked in at build time; if it's somehow missing we default
// to the known local URL so a misbuilt renderer still connects instead of
// crashing on a blank page. The client auto-reconnects if the backend blips.
const url = (import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "http://127.0.0.1:3210";
if (!import.meta.env.VITE_CONVEX_URL) {
  console.warn("VITE_CONVEX_URL not set at build time — defaulting to http://127.0.0.1:3210");
}

export const convex = new ConvexReactClient(url);
