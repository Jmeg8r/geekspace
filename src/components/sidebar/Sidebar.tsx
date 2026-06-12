import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  BookOpen,
  Bot,
  CalendarDays,
  Database,
  FileText,
  Folder,
  Home,
  Mic,
  Plus,
  Search,
  Settings,
  Trash2,
  RotateCcw,
  X,
} from "lucide-react";
import { SidebarRecordingDot } from "../meetings/RecorderWidget";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { cn, isElectron } from "../../lib/utils";
import { Popover } from "../common/Popover";
import { MenuItem, MenuList } from "../common/Menu";
import { Kbd } from "../common/bits";
import { PageRow } from "./PageRow";
import { PageTree } from "./PageTree";

type Page = Doc<"pages">;

export function Sidebar() {
  const pages = useQuery(api.pages.list) ?? [];
  const nav = useUI((s) => s.nav);
  const navigate = useUI((s) => s.navigate);
  const setCommandOpen = useUI((s) => s.setCommandOpen);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const createPage = useMutation(api.pages.create);

  const { roots, childrenOf } = useMemo(() => {
    const childrenOf = new Map<string, Page[]>();
    const roots: Page[] = [];
    for (const p of pages) {
      if (p.parentId) {
        const list = childrenOf.get(p.parentId) ?? [];
        list.push(p);
        childrenOf.set(p.parentId, list);
      }
    }
    // A page is a visible root if it has no parent OR its parent is not in the
    // visible (non-trashed) set — that's how trashed subtrees disappear.
    const ids = new Set(pages.map((p) => p._id as string));
    for (const p of pages) {
      if (!p.parentId || !ids.has(p.parentId)) roots.push(p);
    }
    const byOrder = (a: Page, b: Page) => a.order - b.order;
    roots.sort(byOrder);
    for (const list of childrenOf.values()) list.sort(byOrder);
    return { roots, childrenOf };
  }, [pages]);

  const favorites = pages.filter((p) => p.favorite).sort((a, b) => a.order - b.order);

  async function newPage(kind: "doc" | "database", parentId?: Id<"pages">) {
    const pageId = await createPage({ kind, parentId });
    if (pageId) navigate({ kind: "page", pageId });
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      {/* App header — drag region for the Electron window */}
      <div
        className={cn("app-drag flex items-center gap-2 px-3 pb-2", isElectron() ? "pt-11" : "pt-3")}
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[13px] font-extrabold text-white">
          G
        </div>
        <span className="text-[14px] font-bold tracking-tight">Geekspace</span>
      </div>

      {/* Primary nav */}
      <div className="px-2">
        <NavButton
          icon={Search}
          label="Search"
          right={<Kbd>⌘K</Kbd>}
          onClick={() => setCommandOpen(true)}
        />
        <NavButton
          icon={Home}
          label="Home"
          active={nav.kind === "home"}
          onClick={() => navigate({ kind: "home" })}
        />
        <NavButton
          icon={CalendarDays}
          label="Calendar"
          active={nav.kind === "calendar"}
          onClick={() => navigate({ kind: "calendar" })}
        />
        <NavButton
          icon={Mic}
          label="Meetings"
          right={<SidebarRecordingDot />}
          active={nav.kind === "meetings"}
          onClick={() => navigate({ kind: "meetings" })}
        />
        <NavButton
          icon={Folder}
          label="Docs"
          active={nav.kind === "docs"}
          onClick={() => navigate({ kind: "docs" })}
        />
        <NavButton
          icon={BookOpen}
          label="Knowledge"
          active={nav.kind === "knowledge"}
          onClick={() => navigate({ kind: "knowledge" })}
        />
        <AgentNavButton />
      </div>

      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        {favorites.length > 0 && (
          <>
            <SectionLabel>Favorites</SectionLabel>
            {favorites.map((p) => (
              <PageRow key={`fav-${p._id}`} page={p} depth={0} flat />
            ))}
            <div className="h-3" />
          </>
        )}

        <div className="group/section flex items-center justify-between pr-1">
          <SectionLabel>Pages</SectionLabel>
          <Popover
            placement="bottom-start"
            trigger={(props, open) => (
              <button
                {...props}
                className={cn(
                  "rounded p-0.5 text-ink-3 transition-opacity hover:bg-hov hover:text-ink",
                  open ? "opacity-100" : "opacity-0 group-hover/section:opacity-100"
                )}
                title="New page"
              >
                <Plus size={14} />
              </button>
            )}
          >
            {(close) => (
              <MenuList>
                <MenuItem icon={FileText} label="New page" onClick={() => { close(); void newPage("doc"); }} />
                <MenuItem icon={Database} label="New database" onClick={() => { close(); void newPage("database"); }} />
              </MenuList>
            )}
          </Popover>
        </div>
        <PageTree roots={roots} childrenOf={childrenOf} />
        <button
          onClick={() => void newPage("doc")}
          className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-ink-3 hover:bg-hov hover:text-ink-2"
        >
          <Plus size={14} /> New page
        </button>
      </div>

      {/* Footer */}
      <div className="border-t border-border p-2">
        <TrashButton />
        <NavButton icon={Settings} label="Settings" onClick={() => setSettingsOpen(true)} />
      </div>
    </aside>
  );
}

function AgentNavButton() {
  const open = useUI((s) => s.agentPanelOpen);
  const setOpen = useUI((s) => s.setAgentPanelOpen);
  return (
    <NavButton
      icon={Bot}
      label="Agent"
      active={open}
      onClick={() => setOpen(!open)}
    />
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
      {children}
    </div>
  );
}

function NavButton({
  icon: Icon,
  label,
  right,
  active,
  onClick,
}: {
  icon: typeof Home;
  label: string;
  right?: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "no-drag flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium",
        active ? "bg-act text-ink" : "text-ink-2 hover:bg-hov hover:text-ink"
      )}
    >
      <Icon size={15} />
      <span className="flex-1 text-left">{label}</span>
      {right}
    </button>
  );
}

function TrashButton() {
  const trashed = useQuery(api.pages.listTrashed) ?? [];
  const restore = useMutation(api.pages.restore);
  const deleteForever = useMutation(api.pages.deleteForever);

  return (
    <Popover
      placement="top-start"
      className="w-72"
      trigger={(props) => (
        <button
          {...props}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-hov hover:text-ink"
        >
          <Trash2 size={15} />
          <span className="flex-1 text-left">Trash</span>
          {trashed.length > 0 && <span className="text-[11px] text-ink-3">{trashed.length}</span>}
        </button>
      )}
    >
      {() => (
        <div className="p-2">
          <div className="px-1 pb-1.5 text-[12px] font-semibold text-ink-2">Trash</div>
          {trashed.length === 0 && (
            <div className="px-1 pb-2 text-[12px] text-ink-3">Trash is empty</div>
          )}
          {trashed.map((p) => (
            <div key={p._id} className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-hov">
              <span className="w-5 text-center text-[14px]">{p.icon ?? "📄"}</span>
              <span className="flex-1 truncate text-[13px]">{p.title || "Untitled"}</span>
              <button
                title="Restore"
                onClick={() => void restore({ pageId: p._id })}
                className="rounded p-1 text-ink-3 hover:bg-act hover:text-ink"
              >
                <RotateCcw size={13} />
              </button>
              <button
                title="Delete forever"
                onClick={() => {
                  if (confirm(`Permanently delete "${p.title || "Untitled"}" and everything inside it?`)) {
                    void deleteForever({ pageId: p._id });
                  }
                }}
                className="rounded p-1 text-ink-3 hover:bg-act hover:text-[var(--pal-red)]"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}
