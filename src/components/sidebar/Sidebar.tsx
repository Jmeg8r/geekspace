import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Home,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  RotateCcw,
  X,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { cn, isElectron } from "../../lib/utils";
import { Popover } from "../common/Popover";
import { MenuItem, MenuList, MenuSeparator } from "../common/Menu";
import { Kbd } from "../common/bits";

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
      </div>

      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        {favorites.length > 0 && (
          <>
            <SectionLabel>Favorites</SectionLabel>
            {favorites.map((p) => (
              <PageItem key={`fav-${p._id}`} page={p} childrenOf={childrenOf} depth={0} flat />
            ))}
            <div className="h-3" />
          </>
        )}

        <div className="group/section flex items-center justify-between pr-1">
          <SectionLabel>Pages</SectionLabel>
          <Popover
            placement="bottom-start"
            trigger={(props) => (
              <button
                {...props}
                className="rounded p-0.5 text-ink-3 opacity-0 transition-opacity hover:bg-hov hover:text-ink group-hover/section:opacity-100"
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
        {roots.map((p) => (
          <PageItem key={p._id} page={p} childrenOf={childrenOf} depth={0} />
        ))}
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

function PageItem({
  page,
  childrenOf,
  depth,
  flat,
}: {
  page: Page;
  childrenOf: Map<string, Page[]>;
  depth: number;
  flat?: boolean;
}) {
  const nav = useUI((s) => s.nav);
  const navigate = useUI((s) => s.navigate);
  const expanded = useUI((s) => s.expanded[page._id] ?? false);
  const toggleExpanded = useUI((s) => s.toggleExpanded);
  const setExpanded = useUI((s) => s.setExpanded);
  const createPage = useMutation(api.pages.create);
  const toggleFavorite = useMutation(api.pages.toggleFavorite);
  const trash = useMutation(api.pages.trash);

  const children = flat ? [] : (childrenOf.get(page._id) ?? []);
  const active = nav.kind === "page" && nav.pageId === page._id;

  async function addChild(kind: "doc" | "database") {
    const pageId = await createPage({ kind, parentId: page._id });
    setExpanded(page._id, true);
    if (pageId) navigate({ kind: "page", pageId });
  }

  return (
    <>
      <div
        className={cn(
          "group flex w-full cursor-pointer items-center rounded-md py-1 pr-1 text-[13px]",
          active ? "bg-act font-medium text-ink" : "text-ink-2 hover:bg-hov hover:text-ink"
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => navigate({ kind: "page", pageId: page._id })}
      >
        {!flat ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(page._id);
            }}
            className="mr-0.5 rounded p-0.5 text-ink-3 hover:bg-act"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="w-1.5" />
        )}
        <span className="mr-1.5 w-4 text-center text-[14px] leading-none">
          {page.icon ?? (page.kind === "database" ? <Database size={14} className="inline text-ink-3" /> : <FileText size={14} className="inline text-ink-3" />)}
        </span>
        <span className="flex-1 truncate">{page.title || "Untitled"}</span>

        {!flat && (
          <span className="hidden items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
            <Popover
              trigger={(props) => (
                <button {...props} className="rounded p-0.5 text-ink-3 hover:bg-act hover:text-ink" title="Options">
                  <MoreHorizontal size={14} />
                </button>
              )}
            >
              {(close) => (
                <MenuList>
                  <MenuItem
                    icon={Star}
                    label={page.favorite ? "Remove from favorites" : "Add to favorites"}
                    onClick={() => {
                      close();
                      void toggleFavorite({ pageId: page._id });
                    }}
                  />
                  <MenuSeparator />
                  <MenuItem
                    icon={Trash2}
                    label="Move to trash"
                    danger
                    onClick={() => {
                      close();
                      void trash({ pageId: page._id });
                      if (active) navigate({ kind: "home" });
                    }}
                  />
                </MenuList>
              )}
            </Popover>
            <Popover
              trigger={(props) => (
                <button {...props} className="rounded p-0.5 text-ink-3 hover:bg-act hover:text-ink" title="Add page inside">
                  <Plus size={14} />
                </button>
              )}
            >
              {(close) => (
                <MenuList>
                  <MenuItem icon={FileText} label="New page" onClick={() => { close(); void addChild("doc"); }} />
                  <MenuItem icon={Database} label="New database" onClick={() => { close(); void addChild("database"); }} />
                </MenuList>
              )}
            </Popover>
          </span>
        )}
      </div>
      {expanded && !flat && (
        <>
          {children.map((c) => (
            <PageItem key={c._id} page={c} childrenOf={childrenOf} depth={depth + 1} />
          ))}
          {children.length === 0 && (
            <div className="py-0.5 text-[12px] text-ink-3" style={{ paddingLeft: 26 + depth * 14 }}>
              No pages inside
            </div>
          )}
        </>
      )}
    </>
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
