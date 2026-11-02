import { create } from "zustand";
import { persist } from "zustand/middleware";

// WHAT: UI/navigation state. Domain data lives in Convex; this is only what the
// shell needs to render (current page, open modals, expanded tree nodes).

export type Nav =
  | { kind: "home" }
  | { kind: "calendar" }
  | { kind: "meetings" }
  | { kind: "knowledge"; initialQuery?: string }
  | { kind: "docs" }
  | { kind: "reader" }
  | { kind: "dayRecord" }
  | { kind: "page"; pageId: string };

/** Why a page view couldn't show its page: it threw, or the page no longer exists. */
export type PageFailure = "error" | "missing";

/**
 * Where to go when a page view can't show its page. A page that throws goes Home. A
 * missing page goes Home only when the nav was restored from storage (it may name a page
 * from another deployment); one you opened yourself keeps the "page is gone" message.
 */
export function fallbackNav(nav: Nav, navRestored: boolean, failure: PageFailure): Nav {
  if (nav.kind !== "page") return nav;
  if (failure === "error" || navRestored) return { kind: "home" };
  return nav;
}

interface UIState {
  nav: Nav;
  /** True while `nav` is a page restored from storage rather than one navigated to. */
  navRestored: boolean;
  navigate: (nav: Nav) => void;
  openRowId: string | null;
  openRow: (rowId: string | null) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  expanded: Record<string, boolean>;
  toggleExpanded: (pageId: string) => void;
  setExpanded: (pageId: string, value: boolean) => void;
  calMode: "week" | "month";
  setCalMode: (mode: "week" | "month") => void;
  calAnchor: number; // epoch ms of any moment inside the displayed period
  setCalAnchor: (ms: number) => void;
  viewByDb: Record<string, string>;
  setViewForDb: (databaseId: string, viewId: string) => void;
  macSyncStatus: { at: number; ok: boolean; message: string } | null;
  setMacSyncStatus: (status: { at: number; ok: boolean; message: string }) => void;
  agentPanelOpen: boolean;
  setAgentPanelOpen: (open: boolean) => void;
  templatesOpen: boolean;
  setTemplatesOpen: (open: boolean) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      nav: { kind: "home" },
      navRestored: false,
      navigate: (nav) => set({ nav, navRestored: false, openRowId: null }),
      openRowId: null,
      openRow: (openRowId) => set({ openRowId }),
      commandOpen: false,
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      settingsOpen: false,
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      expanded: {},
      toggleExpanded: (pageId) =>
        set((s) => ({ expanded: { ...s.expanded, [pageId]: !s.expanded[pageId] } })),
      setExpanded: (pageId, value) =>
        set((s) => ({ expanded: { ...s.expanded, [pageId]: value } })),
      calMode: "week",
      setCalMode: (calMode) => set({ calMode }),
      calAnchor: Date.now(),
      setCalAnchor: (calAnchor) => set({ calAnchor }),
      viewByDb: {},
      setViewForDb: (databaseId, viewId) =>
        set((s) => ({ viewByDb: { ...s.viewByDb, [databaseId]: viewId } })),
      macSyncStatus: null,
      setMacSyncStatus: (macSyncStatus) => set({ macSyncStatus }),
      agentPanelOpen: false,
      setAgentPanelOpen: (agentPanelOpen) => set({ agentPanelOpen }),
      templatesOpen: false,
      setTemplatesOpen: (templatesOpen) => set({ templatesOpen }),
    }),
    {
      name: "geekspace-ui",
      partialize: (s) => ({
        nav: s.nav,
        expanded: s.expanded,
        calMode: s.calMode,
        viewByDb: s.viewByDb,
      }),
      // WHY merge, not onRehydrateStorage: localStorage hydrates synchronously inside
      // create(), before `useUI` exists, so a rehydrate callback can't set state yet.
      merge: (persisted, current) => {
        // SAFETY: `persisted` is what partialize above wrote under this key; every field
        // is optional here and only `nav.kind` is read before spreading.
        const saved = (persisted ?? {}) as Partial<Pick<UIState, "nav" | "expanded" | "calMode" | "viewByDb">>;
        return { ...current, ...saved, navRestored: saved.nav?.kind === "page" };
      },
    }
  )
);
