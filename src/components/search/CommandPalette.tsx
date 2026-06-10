import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  BookOpen,
  CalendarDays,
  Database,
  FileText,
  Home,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useUI } from "../../state/ui";
import { cn } from "../../lib/utils";
import {
  knowledgeAvailable,
  knowledgeSearch,
  openExternalUrl,
  type KnowledgeResult,
} from "../../lib/knowledgeBridge";
import { Modal } from "../common/Modal";
import { Kbd } from "../common/bits";

interface Item {
  key: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

// WHAT: ⌘K command palette — search pages + rows, plus quick actions.
export function CommandPalette() {
  const setCommandOpen = useUI((s) => s.setCommandOpen);
  const navigate = useUI((s) => s.navigate);
  const openRow = useUI((s) => s.openRow);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const createPage = useMutation(api.pages.create);

  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const results = useQuery(api.search.searchAll, { q });
  const [knowledge, setKnowledge] = useState<KnowledgeResult[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => setCommandOpen(false);

  // ASTGL knowledge results: debounced, ≥3 chars, desktop app only.
  useEffect(() => {
    if (!knowledgeAvailable() || q.trim().length < 3) {
      setKnowledge([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void knowledgeSearch(q.trim(), 4).then((r) => {
        if (!cancelled) setKnowledge(r.ok ? r.data.results : []);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const p of results?.pages ?? []) {
      out.push({
        key: `page-${p._id}`,
        icon: <span className="w-5 text-center">{p.icon ?? (p.kind === "database" ? <Database size={14} className="inline text-ink-3" /> : <FileText size={14} className="inline text-ink-3" />)}</span>,
        label: p.title || "Untitled",
        hint: p.kind === "database" ? "Database" : "Page",
        run: () => {
          close();
          navigate({ kind: "page", pageId: p._id });
        },
      });
    }
    for (const r of results?.rows ?? []) {
      out.push({
        key: `row-${r._id}`,
        icon: <span className="w-5 text-center">{r.pageIcon ?? "📄"}</span>,
        label: r.title || "Untitled",
        hint: `in ${r.databaseName}`,
        run: () => {
          close();
          navigate({ kind: "page", pageId: r.pageId });
          openRow(r._id);
        },
      });
    }
    for (const k of knowledge) {
      out.push({
        key: `kb-${k.url}-${out.length}`,
        icon: <BookOpen size={15} className="text-accent" />,
        label: k.title,
        hint: "astgl.ai ↗",
        run: () => {
          close();
          if (k.url) void openExternalUrl(k.url);
        },
      });
    }
    if (knowledgeAvailable() && q.trim().length >= 3) {
      out.push({
        key: "kb-ask",
        icon: <Sparkles size={15} className="text-accent" />,
        label: `Ask ASTGL Knowledge: “${q.trim()}”`,
        hint: "answer mode",
        run: () => {
          close();
          navigate({ kind: "knowledge", initialQuery: q.trim() });
        },
      });
    }

    const actions: Item[] = [
      {
        key: "a-home",
        icon: <Home size={15} className="text-ink-2" />,
        label: "Go home",
        run: () => {
          close();
          navigate({ kind: "home" });
        },
      },
      {
        key: "a-cal",
        icon: <CalendarDays size={15} className="text-ink-2" />,
        label: "Open calendar",
        run: () => {
          close();
          navigate({ kind: "calendar" });
        },
      },
      {
        key: "a-new",
        icon: <Plus size={15} className="text-ink-2" />,
        label: "New page",
        hint: "⌘N",
        run: async () => {
          close();
          const pageId = await createPage({ kind: "doc" });
          if (pageId) navigate({ kind: "page", pageId });
        },
      },
      {
        key: "a-newdb",
        icon: <Database size={15} className="text-ink-2" />,
        label: "New database",
        run: async () => {
          close();
          const pageId = await createPage({ kind: "database" });
          if (pageId) navigate({ kind: "page", pageId });
        },
      },
      {
        key: "a-settings",
        icon: <Settings size={15} className="text-ink-2" />,
        label: "Open settings",
        run: () => {
          close();
          setSettingsOpen(true);
        },
      },
    ].filter((a) => !q.trim() || a.label.toLowerCase().includes(q.toLowerCase()));
    return [...out, ...actions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, q, knowledge]);

  useEffect(
    () => setIdx(0),
    [q, results?.pages.length, results?.rows.length, knowledge.length]
  );

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  return (
    <Modal onClose={close} width="min(560px, 92vw)" top="14vh" showClose={false}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Search size={16} className="text-ink-3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              items[idx]?.run();
            }
          }}
          placeholder="Search pages, tasks, or run a command…"
          className="w-full bg-transparent text-[15px] outline-none placeholder:text-ink-3"
        />
        <Kbd>esc</Kbd>
      </div>
      <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
        {items.map((item, i) => (
          <button
            key={item.key}
            data-idx={i}
            onMouseEnter={() => setIdx(i)}
            onClick={item.run}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left",
              i === idx && "bg-hov"
            )}
          >
            {item.icon}
            <span className="min-w-0 flex-1 truncate text-[14px]">{item.label}</span>
            {item.hint && <span className="shrink-0 text-[11.5px] text-ink-3">{item.hint}</span>}
          </button>
        ))}
        {items.length === 0 && (
          <div className="py-8 text-center text-[13px] text-ink-3">No results for “{q}”</div>
        )}
      </div>
    </Modal>
  );
}
