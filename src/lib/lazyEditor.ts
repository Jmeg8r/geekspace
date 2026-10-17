import { lazy } from "react";

// WHAT: the block editor, loaded on first use instead of at startup.
// WHY: BlockNote and its stack (Tiptap, ProseMirror, Yjs, Mantine) are ~860 kB minified —
// over half the old entry chunk — and Home never shows an editor. preloadEditor() is
// called once the app is idle so the first page open doesn't wait.
// See docs/changes/2026-10-17-bundle-split/.
const load = () => import("../components/page/Editor");

export const LazyEditor = lazy(() => load().then((m) => ({ default: m.Editor })));

export function preloadEditor(): void {
  load().catch((err) => console.warn("Editor prefetch failed; it will load on first use", err));
}
