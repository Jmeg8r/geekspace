import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useUI } from "./state/ui";
import { ThemeProvider } from "./state/theme";
import { tzOffsetMin } from "./lib/utils";
import { integrationsAvailable } from "./lib/integrations";
import { syncMacCalendar } from "./lib/macSync";
import { onMeetingProgress } from "./lib/meetingsBridge";
import { Sidebar } from "./components/sidebar/Sidebar";
import { HomeView } from "./components/home/HomeView";
import { CalendarView } from "./components/calendar/CalendarView";
import { MeetingsView } from "./components/meetings/MeetingsView";
import { RecorderWidget } from "./components/meetings/RecorderWidget";
import { PageView } from "./components/page/PageView";
import { RowPeek } from "./components/database/RowPeek";
import { CommandPalette } from "./components/search/CommandPalette";
import { SettingsModal } from "./components/settings/SettingsModal";

export default function App() {
  const settings = useQuery(api.settings.get);
  const nav = useUI((s) => s.nav);
  const navigate = useUI((s) => s.navigate);
  const commandOpen = useUI((s) => s.commandOpen);
  const setCommandOpen = useUI((s) => s.setCommandOpen);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const createPage = useMutation(api.pages.create);
  const reflow = useMutation(api.scheduling.reflowNow);
  const setMeetingStatus = useMutation(api.meetings.setStatus);

  // Pipe meeting-pipeline progress (whisper/model/LLM) into Convex so every
  // surface shows live status. Deduped — model downloads fire rapidly.
  const lastProgress = useRef<string>("");
  useEffect(() => {
    return onMeetingProgress((p) => {
      if (!p.meetingId) return;
      const pct = p.phase === "summarizing" ? undefined : p.pct;
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
      <div className="flex h-screen w-screen overflow-hidden bg-bg text-ink">
        <Sidebar />
        <main className="min-w-0 flex-1">
          {nav.kind === "home" && <HomeView />}
          {nav.kind === "calendar" && <CalendarView />}
          {nav.kind === "meetings" && <MeetingsView />}
          {nav.kind === "page" && (
            <PageView key={nav.pageId} pageId={nav.pageId as Id<"pages">} />
          )}
        </main>
        <RowPeek />
        <RecorderWidget />
        {commandOpen && <CommandPalette />}
        {settingsOpen && <SettingsModal />}
      </div>
    </ThemeProvider>
  );
}
