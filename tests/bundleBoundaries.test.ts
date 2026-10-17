import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// WHAT: startup code must not statically import the editor or any view except Home and
// the sidebar — a static import pulls the module (and its dependencies, ~860 kB for the
// editor) back into the entry chunk. See docs/changes/2026-10-17-bundle-split/.

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/** Module specifiers this file imports statically (`import … from "x"`), excluding type-only imports. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["'];?/gms)) out.push(m[1]);
  return out;
}

const LAZY_FROM_APP = [
  "./components/calendar/CalendarView",
  "./components/meetings/MeetingsView",
  "./components/search/KnowledgePage",
  "./components/reader/ReaderPage",
  "./components/agent/AgentPanel",
  "./components/templates/TemplatesModal",
  "./components/docs/DocsPage",
  "./components/page/PageView",
  "./components/search/CommandPalette",
  "./components/settings/SettingsModal",
];

describe("bundle boundaries", () => {
  it("App imports no lazily loaded view statically", () => {
    const imports = staticImports(read("src/App.tsx"));
    expect(imports.filter((s) => LAZY_FROM_APP.includes(s))).toEqual([]);
  });

  it("the editor is never imported statically where it renders", () => {
    for (const file of ["src/components/page/PageView.tsx", "src/components/database/RowPeek.tsx"]) {
      const imports = staticImports(read(file));
      expect(imports.filter((s) => /\/Editor$/.test(s)), file).toEqual([]);
    }
  });

  it("control: the import scanner sees a static import it should", () => {
    expect(staticImports(read("src/App.tsx"))).toContain("./components/home/HomeView");
  });
});
