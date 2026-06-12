import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, MoreHorizontal, Plus, Star, Trash2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { cn, debounce } from "../../lib/utils";
import { hashColor } from "../../lib/optionColors";
import { Popover } from "../common/Popover";
import { MenuItem, MenuList } from "../common/Menu";
import { Chip } from "../common/bits";
import { EmojiPicker } from "../common/EmojiPicker";
import { Editor } from "./Editor";
import { DatabaseContainer } from "../database/DatabaseContainer";

export function PageView({ pageId }: { pageId: Id<"pages"> }) {
  const page = useQuery(api.pages.get, { pageId });
  const setContent = useMutation(api.pages.setContent);

  if (page === undefined) {
    return <div className="flex h-full items-center justify-center text-ink-3">Loading…</div>;
  }
  if (page === null || page.trashed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
        <span className="text-3xl">🗑️</span>
        <p className="text-[14px]">This page is gone — check the trash.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader page={page} />
      {page.kind === "doc" ? (
        <div className="mx-auto w-full max-w-3xl flex-1 px-14 pb-40">
          <Editor
            key={page._id}
            initialJson={page.content}
            onSave={(json) => void setContent({ pageId: page._id, content: json })}
          />
        </div>
      ) : page.databaseId ? (
        <DatabaseContainer key={page.databaseId} databaseId={page.databaseId} />
      ) : null}
    </div>
  );
}

function PageHeader({ page }: { page: Doc<"pages"> }) {
  const update = useMutation(api.pages.update);
  const toggleFavorite = useMutation(api.pages.toggleFavorite);
  const trash = useMutation(api.pages.trash);
  const navigate = useUI((s) => s.navigate);

  const [title, setTitle] = useState(page.title);
  const pageIdRef = useRef(page._id);
  useEffect(() => {
    if (pageIdRef.current !== page._id) {
      pageIdRef.current = page._id;
      setTitle(page.title);
    }
  }, [page._id, page.title]);

  const saveTitle = useRef(
    debounce((pageId: Id<"pages">, value: string) => {
      void update({ pageId, title: value });
    }, 400)
  );
  useEffect(() => {
    const saver = saveTitle.current;
    return () => saver.flush();
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-14 pb-2 pt-10">
      {/* top-right page actions */}
      <div className="flex justify-end gap-1 pb-4">
        <button
          title={page.favorite ? "Remove from favorites" : "Add to favorites"}
          onClick={() => void toggleFavorite({ pageId: page._id })}
          className={cn(
            "rounded-md p-1.5 hover:bg-hov",
            page.favorite ? "text-[var(--pal-yellow)]" : "text-ink-3"
          )}
        >
          <Star size={16} fill={page.favorite ? "currentColor" : "none"} />
        </button>
        <Popover
          placement="bottom-end"
          trigger={(props) => (
            <button {...props} className="rounded-md p-1.5 text-ink-3 hover:bg-hov">
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <MenuList>
              <MenuItem
                icon={Trash2}
                label="Move to trash"
                danger
                onClick={() => {
                  close();
                  void trash({ pageId: page._id });
                  navigate({ kind: "home" });
                }}
              />
            </MenuList>
          )}
        </Popover>
      </div>

      <Popover
        trigger={(props) => (
          <button
            {...props}
            className="-ml-1 mb-1 rounded-lg p-1 text-[42px] leading-none hover:bg-hov"
            title="Change icon"
          >
            {page.icon ?? <span className="text-[36px] text-ink-3">{page.kind === "database" ? "🗄️" : "📄"}</span>}
          </button>
        )}
      >
        {(close) => (
          <EmojiPicker
            close={close}
            onPick={(emoji) => void update({ pageId: page._id, icon: emoji })}
            onRemove={() => void update({ pageId: page._id, icon: "" })}
          />
        )}
      </Popover>

      <input
        value={title}
        placeholder="Untitled"
        onChange={(e) => {
          setTitle(e.target.value);
          saveTitle.current(page._id, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="mb-2 w-full bg-transparent text-[34px] font-extrabold tracking-tight outline-none placeholder:text-ink-3"
      />

      <PageProjects page={page} />
    </div>
  );
}

// WHAT: Project tags on a page — colored chips linking the page to rows in the
// Projects database. Click a chip to open that project; use the picker to add
// or remove. Hidden entirely when there's no Projects database.
function PageProjects({ page }: { page: Doc<"pages"> }) {
  const projects = useQuery(api.projects.listForPicker) ?? [];
  const setProjects = useMutation(api.pages.setProjects);
  const openRow = useUI((s) => s.openRow);

  const linked = page.projectRowIds ?? [];
  const byId = new Map(projects.map((p) => [p.rowId, p]));
  const linkedProjects = linked
    .map((id) => byId.get(id))
    .filter((p): p is { rowId: Id<"rows">; title: string } => Boolean(p));

  // Nothing to link to and nothing already linked → don't show the affordance.
  if (projects.length === 0 && linkedProjects.length === 0) return null;

  function toggle(rowId: Id<"rows">) {
    const next = linked.includes(rowId)
      ? linked.filter((id) => id !== rowId)
      : [...linked, rowId];
    void setProjects({ pageId: page._id, projectRowIds: next });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-1">
      {linkedProjects.map((p) => (
        <span key={p.rowId} className="group/chip inline-flex items-center">
          <button
            onClick={() => openRow(p.rowId)}
            title={`Open ${p.title}`}
            className="rounded transition-opacity hover:opacity-80"
          >
            <Chip color={hashColor(p.rowId)} name={p.title} />
          </button>
          <button
            onClick={() => toggle(p.rowId)}
            title="Remove project"
            className="ml-0.5 text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover/chip:opacity-100"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <Popover
        placement="bottom-start"
        trigger={(props) => (
          <button
            {...props}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-3 hover:bg-hov hover:text-ink-2"
          >
            <Plus size={12} /> Project
          </button>
        )}
      >
        {() => <ProjectPicker projects={projects} selected={linked} onToggle={toggle} />}
      </Popover>
    </div>
  );
}

function ProjectPicker({
  projects,
  selected,
  onToggle,
}: {
  projects: { rowId: Id<"rows">; title: string }[];
  selected: Id<"rows">[];
  onToggle: (rowId: Id<"rows">) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = projects.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="w-60 p-1.5">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search projects…"
        className="mb-1 w-full rounded-md bg-hov px-2 py-1 text-[13px] outline-none placeholder:text-ink-3"
      />
      <div className="max-h-64 overflow-auto">
        {filtered.map((p) => (
          <button
            key={p.rowId}
            onClick={() => onToggle(p.rowId)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hov"
          >
            <Chip color={hashColor(p.rowId)} name={p.title} />
            {selected.includes(p.rowId) && <Check size={14} className="shrink-0 text-accent" />}
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-2 text-[12px] text-ink-3">No projects found</div>
        )}
      </div>
    </div>
  );
}
