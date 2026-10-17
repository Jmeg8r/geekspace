import { Suspense, lazy, useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useUI } from "./state/ui";
import { ThemeProvider } from "./state/theme";
import { isWinDesktop, tzOffsetMin } from "./lib/utils";
import { integrationsAvailable } from "./lib/integrations";
import { syncMacCalendar } from "./lib/macSync";
import {
  meetingsAvailable,
  onMeetingProgress,
  onSaveRecordingRequest,
  reportRecordingActive,
} from "./lib/meetingsBridge";
import { recorder } from "./lib/recorder";
import { pendingAudio, saveRecordingBeforeQuit } from "./lib/meetingPipeline";
import { Sidebar } from "./components/sidebar/Sidebar";
import { HomeView } from "./components/home/HomeView";
import { RecorderWidget } from "./components/meetings/RecorderWidget";
import { RowPeek } from "./components/database/RowPeek";
import { ViewLoading } from "./components/common/ViewLoading";
import { preloadEditor } from "./lib/lazyEditor";

// WHY lazy: only Home and the sidebar are needed to draw the first screen. Every other
// view loads on first use, keeping the entry chunk small (bundleBoundaries.test.ts keeps
// these out of static imports). See docs/changes/2026-10-17-bundle-split/.
const CalendarView = lazy(() => import("./components/calendar/CalendarView").then((m) => ({ default: m.CalendarView })));
const MeetingsView = lazy(() => import("./components/meetings/MeetingsView").then((m) => ({ default: m.MeetingsView })));
const KnowledgePage = lazy(() => import("./components/search/KnowledgePage").then((m) => ({ default: m.KnowledgePage })));
const ReaderPage = lazy(() => import("./components/reader/ReaderPage").then((m) => ({ default: m.ReaderPage })));
const AgentPanel = lazy(() => import("./components/agent/AgentPanel").then((m) => ({ default: m.AgentPanel })));
const TemplatesModal = lazy(() => import("./components/templates/TemplatesModal").then((m) => ({ default: m.TemplatesModal })));
const DocsPage = lazy(() => import("./components/docs/DocsPage").then((m) => ({ default: m.DocsPage })));
const PageView = lazy(() => import("./components/page/PageView").then((m) => ({ default: m.PageView })));
const CommandPalette = lazy(() => import("./components/search/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const SettingsModal = lazy(() => import("./components/settings/SettingsModal").then((m) => ({ default: m.SettingsModal })));

// Editor prefetch waits for the browser to be idle after first paint (with a fallback
// where requestIdleCallback is missing), so it never competes with drawing Home.
const IDLE_PREFETCH_TIMEOUT_MS = 2000;

export default function App() {
  const settings = useQuery(api.settings.get);
  const nav = useUI((s) => s.nav);
  const navigate = useUI((s) => s.navigate);
  const commandOpen = useUI((s) => s.commandOpen);
  const setCommandOpen = useUI((s) => s.setCommandOpen);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const templatesOpen = useUI((s) => s.templatesOpen);
  const setTemplatesOpen = useUI((s) => s.setTemplatesOpen);
  const createPage = useMutation(api.pages.create);
  const reflow = useMutation(api.scheduling.reflowNow);
  const setMeetingStatus = useMutation(api.meetings.setStatus);
  const agentPanelOpen = useUI((s) => s.agentPanelOpen);

  useEffect(() => {
    const idle = window.requestIdleCallback;
    if (idle) {
      const handle = idle(() => preloadEditor(), { timeout: IDLE_PREFETCH_TIMEOUT_MS });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(preloadEditor, IDLE_PREFETCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);
  const reconcileMeetings = useMutation(api.meetings.reconcileInterrupted);

  // Pipe meeting-pipeline progress (whisper/model/LLM) into Convex so every
  // surface shows live status. Deduped — model downloads fire rapidly.
  const lastProgress = useRef<string>("");
  useEffect(() => {
    return onMeetingProgress((p) => {
      if (!p.meetingId) return;
      const pct = p.pct;
      const key = `${p.meetingId}:${p.phase}:${pct !== undefined ? Math.floor(pct / 4) : "-"}`;
      if (key === lastProgress.current) return;
      lastProgress.current = key;
      void setMeetingStatus({
        meetingId: p.meetingId as Id<"meetings">,
        status: p.phase === "summarizing" ? "summarizing" : "transcribing",
        progress: pct,
      }).catch(() => {});
    });
  }, [setMeetingStatus]);

  // Meetings left mid-pipeline by a previous run stop spinning and offer Re-run AI.
  // WHY desktop only: a browser tab opened beside the desktop window must not fail a
  // recording that window is still making.
  const launchedAt = useRef(Date.now());
  useEffect(() => {
    if (!meetingsAvailable()) return;
    void reconcileMeetings({ before: launchedAt.current }).catch((err) =>
      console.warn("Could not recover interrupted meetings", err)
    );
  }, [reconcileMeetings]);

  // Quit guard handshake: tell the main process while there is audio it must not lose
  // (a live recording, a save in flight, or stopped audio not yet stored), and save it
  // when the user chooses "Save Recording and Quit".
  useEffect(() => {
    const hasAudioAtRisk = () => recorder.getState().status !== "idle" || pendingAudio.busy();
    let active = hasAudioAtRisk();
    reportRecordingActive(active);
    const update = () => {
      const now = hasAudioAtRisk();
      if (now !== active) reportRecordingActive((active = now));
    };
    const offRecorder = recorder.subscribe(update);
    const offPending = pendingAudio.subscribe(update);
    const offSave = onSaveRecordingRequest(saveRecordingBeforeQuit);
    return () => {
      offRecorder();
      offPending();
      offSave();
    };
  }, []);

  // WHY: reflow on launch — the schedule depends on "now", so a fresh open
  // re-plans around whatever happened since the last session.
  const reflowed = useRef(false);
  useEffect(() => {
    if (!reflowed.current) {
      reflowed.current = true;
      void reflow({ tzOffsetMin: tzOffsetMin() }).catch(() => {});
    }
  }, [reflow]);

  // Background macOS Calendar sync: launch + window focus + every 5 minutes.
  const setMacSyncStatus = useUI((s) => s.setMacSyncStatus);
  const calNamesKey = JSON.stringify(settings?.macCalendarNames ?? []);
  useEffect(() => {
    if (!integrationsAvailable() || !settings?.macCalendarSync) return;
    let cancelled = false;
    const names = JSON.parse(calNamesKey) as string[];
    const doSync = async () => {
      const res = await syncMacCalendar(names);
      if (!cancelled) setMacSyncStatus({ at: Date.now(), ok: res.ok, message: res.message });
    };
    void doSync();
    const interval = setInterval(doSync, 5 * 60 * 1000);
    const onFocus = () => void doSync();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [settings?.macCalendarSync, calNamesKey, setMacSyncStatus]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "k") {
        e.preventDefault();
        setCommandOpen(!useUI.getState().commandOpen);
      } else if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        void (async () => {
          const pageId = await createPage({ kind: "doc" });
          if (pageId) navigate({ kind: "page", pageId });
        })();
      } else if (e.key === "1") {
        e.preventDefault();
        navigate({ kind: "home" });
      } else if (e.key === "2") {
        e.preventDefault();
        navigate({ kind: "calendar" });
      } else if (e.key === "3") {
        e.preventDefault();
        navigate({ kind: "meetings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createPage, navigate, setCommandOpen]);

  return (
    <ThemeProvider theme={settings?.theme ?? "system"}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-ink">
        {isWinDesktop() && (
          // WHY: the Window Controls Overlay's caption buttons float top-right
          // regardless of our layout below — this strip puts them on chrome
          // instead of page content. h-9 (36px) matches the overlay height set
          // in electron/main.mjs and gs:chrome:setOverlay.
          <div className="app-drag h-9 shrink-0 border-b border-border bg-sidebar" />
        )}
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-w-0 flex-1">
            {nav.kind === "home" && <HomeView />}
            <Suspense fallback={<ViewLoading />}>
              {nav.kind === "calendar" && <CalendarView />}
              {nav.kind === "meetings" && <MeetingsView />}
              {nav.kind === "knowledge" && <KnowledgePage />}
              {nav.kind === "reader" && <ReaderPage />}
              {nav.kind === "docs" && <DocsPage />}
              {nav.kind === "page" && (
                <PageView key={nav.pageId} pageId={nav.pageId as Id<"pages">} />
              )}
            </Suspense>
          </main>
          <Suspense fallback={null}>
            {/* Mounted only while open, so its code loads on first use. */}
            {agentPanelOpen && <AgentPanel />}
          </Suspense>
          <RowPeek />
          <RecorderWidget />
          <Suspense fallback={null}>
            {commandOpen && <CommandPalette />}
            {settingsOpen && <SettingsModal />}
            {templatesOpen && <TemplatesModal onClose={() => setTemplatesOpen(false)} />}
          </Suspense>
        </div>
      </div>
    </ThemeProvider>
  );
}
