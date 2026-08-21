import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// WHAT: Resolves the user's theme setting ("light" | "dark" | "system") to a
// boolean and keeps the <html> class in sync so CSS vars flip everywhere.

const ThemeContext = createContext(false);

interface ChromeBridge {
  setOverlay(color: string, symbolColor: string): void;
}
const chromeBridge = () =>
  (window as { geekspace?: { chrome?: ChromeBridge } }).geekspace?.chrome;

// WHY: mirrors src/styles/index.css so the Windows title-bar overlay's native
// caption buttons read as part of the app chrome instead of a stock white bar.
// dark mirrors .dark's --bg/--ink (also the BrowserWindow ctor defaults in
// electron/main.mjs); light mirrors :root's --sidebar/--ink.
const OVERLAY_COLORS = {
  dark: { color: "#1A1A2E", symbolColor: "#E8E8F0" },
  light: { color: "#F2F3F5", symbolColor: "#363737" },
} satisfies Record<"dark" | "light", { color: string; symbolColor: string }>;

export function ThemeProvider({ theme, children }: { theme: string; children: ReactNode }) {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isDark = theme === "dark" || (theme === "system" && systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    // WHY: also fires on initial mount (the window starts with the
    // BrowserWindow constructor's dark defaults, which need re-theming the
    // instant the resolved theme turns out to be light).
    const { color, symbolColor } = OVERLAY_COLORS[isDark ? "dark" : "light"];
    chromeBridge()?.setOverlay(color, symbolColor);
  }, [isDark]);

  return <ThemeContext.Provider value={isDark}>{children}</ThemeContext.Provider>;
}

export const useIsDark = () => useContext(ThemeContext);
