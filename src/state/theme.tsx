import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// WHAT: Resolves the user's theme setting ("light" | "dark" | "system") to a
// boolean and keeps the <html> class in sync so CSS vars flip everywhere.

const ThemeContext = createContext(false);

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
  }, [isDark]);

  return <ThemeContext.Provider value={isDark}>{children}</ThemeContext.Provider>;
}

export const useIsDark = () => useContext(ThemeContext);
