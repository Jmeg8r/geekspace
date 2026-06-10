import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useUI } from "./state/ui";
import { ThemeProvider } from "./state/theme";
import { tzOffsetMin } from "./lib/utils";
import { integrationsAvailable } from "./lib/integrations";
import { syncMacCalendar } from "./lib/macSync";
import { Sidebar } from "./components/sidebar/Sidebar";
import { HomeView } from "./components/home/HomeView";
import { CalendarView } from "./components/calendar/CalendarView";
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
          {nav.kind === "page" && (
            <PageView key={nav.pageId} pageId={nav.pageId as Id<"pages">} />
          )}
        </main>
        <RowPeek />
        {commandOpen && <CommandPalette />}
        {settingsOpen && <SettingsModal />}
      </div>
    </ThemeProvider>
  );
}
