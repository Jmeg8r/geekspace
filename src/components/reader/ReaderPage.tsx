import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Trash2,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Popover } from "../common/Popover";
import { MenuItem, MenuList } from "../common/Menu";
import { Modal } from "../common/Modal";
import {
  readerAddFeed,
  readerAvailable,
  readerListFeeds,
  readerMarkProcessed,
  readerOpenExternal,
  readerPollFeeds,
  readerRecentItems,
  readerRemoveFeed,
  readerSearchItems,
  type Feed,
  type Item,
} from "../../lib/readerBridge";

// WHAT: Graphical RSS reader over the aib-reader substrate (via its stdio MCP
// server). Two panes: a sources rail (all/category filters + add/delete of the
// 296 feeds) and an item list (recent/search, click-to-open + mark-read). A
// Refresh button triggers a live poll_feeds. aib-reader owns storage/dedup; this
// is a thin view over its contract — no data mirrored into Convex.

type Filter = { kind: "all" } | { kind: "category"; name: string } | { kind: "feed"; id: string };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function feedLabel(feed: Feed): string {
  return feed.title?.trim() || hostOf(feed.url);
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Terse relative time ("now" / "5m" / "3h" / "2d" / "4w" / "6mo").
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
}

export function ReaderPage() {
  const available = readerAvailable();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [busy, setBusy] = useState<"items" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [read, setRead] = useState<Set<string>>(() => new Set());
  // Guards against stale loadItems responses: each load bumps this, and only the
  // latest may apply results — so an older in-flight load can't overwrite a newer
  // view when the user changes filters/search quickly.
  const reqSeq = useRef(0);

  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const f of feeds) for (const c of f.categories) s.add(c);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [feeds]);

  const feedsById = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);

  const filteredFeeds = useMemo(() => {
    const list = [...feeds].sort((a, b) => feedLabel(a).localeCompare(feedLabel(b)));
    const q = sourceFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (f) => feedLabel(f).toLowerCase().includes(q) || f.url.toLowerCase().includes(q)
    );
  }, [feeds, sourceFilter]);

  // Narrow the loaded set to the active filter client-side. recent_items already
  // filters by category server-side, but search returns global matches and the
  // contract has no per-feed query — so re-apply the filter here to keep feed and
  // category selections consistent across BOTH recent and search results.
  const displayed = useMemo(() => {
    if (filter.kind === "feed") return items.filter((i) => i.feed_id === filter.id);
    if (filter.kind === "category") return items.filter((i) => i.categories.includes(filter.name));
    return items;
  }, [items, filter]);

  async function loadFeeds() {
    const r = await readerListFeeds();
    if (r.ok) setFeeds(r.data);
    else setError(r.error);
  }

  async function loadItems(f: Filter, q: string) {
    const seq = ++reqSeq.current;
    setBusy("items");
    setError(null);
    const r = q.trim()
      ? await readerSearchItems(q.trim())
      : f.kind === "category"
        ? await readerRecentItems(200, "30d", f.name)
        : await readerRecentItems(200, "30d");
    if (seq !== reqSeq.current) return; // superseded by a newer load — drop this response
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setItems(r.data);
  }

  useEffect(() => {
    if (!available) return;
    void loadFeeds();
    void loadItems({ kind: "all" }, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectFilter(f: Filter) {
    setFilter(f);
    setQuery("");
    setSubmittedQuery("");
    void loadItems(f, "");
  }

  function runSearch() {
    setSubmittedQuery(query);
    void loadItems(filter, query);
  }

  async function refresh() {
    setBusy("refresh");
    setError(null);
    setNote(null);
    const r = await readerPollFeeds();
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setNote(
      `${r.data.new_items} new · ${r.data.feeds_polled} polled · ${r.data.feeds_failed} failed`
    );
    await loadFeeds();
    await loadItems(filter, submittedQuery);
  }

  async function openItem(item: Item) {
    const url = item.url ?? item.canonical_url;
    if (!url) return; // nothing to open — don't mark an unreachable item read
    const opened = await readerOpenExternal(url);
    if (!opened.ok) {
      setError(opened.error);
      return;
    }
    setRead((prev) => new Set(prev).add(item.id));
    void readerMarkProcessed([item.id]);
  }

  async function addFeed(url: string, category: string): Promise<string | null> {
    const r = await readerAddFeed(url.trim(), category.trim() || undefined);
    if (!r.ok) return r.error;
    setAddOpen(false);
    await loadFeeds();
    return null;
  }

  async function deleteFeed(feed: Feed) {
    if (!confirm(`Delete "${feedLabel(feed)}" and all of its stored items?`)) return;
    const r = await readerRemoveFeed(feed.url);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const wasSelected = filter.kind === "feed" && filter.id === feed.id;
    const nextFilter: Filter = wasSelected ? { kind: "all" } : filter;
    if (wasSelected) setFilter(nextFilter);
    await loadFeeds();
    await loadItems(nextFilter, submittedQuery);
  }

  const selectedFeed = filter.kind === "feed" ? feedsById.get(filter.id) : undefined;
  const headerLabel =
    filter.kind === "all"
      ? "All items"
      : filter.kind === "category"
        ? filter.name
        : selectedFeed
          ? feedLabel(selectedFeed)
          : "Source";

  if (!available) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-[13px] text-ink-2">
        The reader needs the desktop app window.
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left rail: filters + sources management */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center gap-2 px-4 pb-2 pt-5">
          <Rss size={18} className="text-accent" />
          <span className="text-[15px] font-bold tracking-tight">Reader</span>
        </div>

        <div className="px-2">
          <RailButton
            label="All items"
            active={filter.kind === "all"}
            onClick={() => selectFilter({ kind: "all" })}
          />
        </div>

        {categories.length > 0 && (
          <div className="px-2 pt-1">
            <RailLabel>Categories</RailLabel>
            <div className="max-h-48 overflow-y-auto">
              {categories.map((c) => (
                <RailButton
                  key={c}
                  label={c}
                  active={filter.kind === "category" && filter.name === c}
                  onClick={() => selectFilter({ kind: "category", name: c })}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mt-2 flex items-center justify-between px-4 pr-2">
          <RailLabel>Sources · {feeds.length}</RailLabel>
          <button
            title="Add feed"
            onClick={() => setAddOpen(true)}
            className="rounded p-0.5 text-ink-3 hover:bg-hov hover:text-ink"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="px-2 pb-1">
          <input
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            placeholder="Filter sources…"
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] outline-none placeholder:text-ink-3 focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filteredFeeds.map((f) => (
            <FeedRow
              key={f.id}
              feed={f}
              active={filter.kind === "feed" && filter.id === f.id}
              onClick={() => selectFilter({ kind: "feed", id: f.id })}
              onDelete={() => void deleteFeed(f)}
            />
          ))}
          {filteredFeeds.length === 0 && (
            <div className="px-2 py-3 text-[12px] text-ink-3">No sources match.</div>
          )}
        </div>
      </aside>

      {/* Right pane: header + item list */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-6 py-3">
          <h1 className="flex items-baseline gap-2 truncate text-[17px] font-bold tracking-tight">
            <span className="truncate">{headerLabel}</span>
            <span className="text-[12px] font-normal text-ink-3">{displayed.length}</span>
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 focus-within:border-accent">
              <Search size={14} className="shrink-0 text-ink-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch();
                  if (e.key === "Escape" && query) {
                    setQuery("");
                    if (submittedQuery) selectFilter(filter);
                  }
                }}
                placeholder="Search items…"
                className="w-44 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
              />
              {busy === "items" && <Loader2 size={13} className="animate-spin text-accent" />}
            </div>
            <button
              onClick={() => void refresh()}
              disabled={busy === "refresh"}
              title="Fetch new items from all feeds"
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-2 disabled:opacity-50"
            >
              {busy === "refresh" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              Refresh
            </button>
          </div>
        </div>

        {(error || note) && (
          <div
            className={cn(
              "px-6 py-2 text-[12.5px]",
              error ? "text-[var(--pal-red)]" : "text-ink-2"
            )}
          >
            {error ?? note}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {displayed.length === 0 && busy !== "items" ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-ink-3">
              {submittedQuery
                ? "No items match your search."
                : filter.kind === "feed"
                  ? "No items from this source in the last 30 days."
                  : "No recent items — try Refresh."}
            </div>
          ) : (
            <div className="mx-auto max-w-3xl px-6 py-1">
              {displayed.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  read={read.has(it.id)}
                  onOpen={() => openItem(it)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {addOpen && <AddFeedModal onClose={() => setAddOpen(false)} onAdd={addFeed} />}
    </div>
  );
}

function RailLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
      {children}
    </div>
  );
}

function RailButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] font-medium",
        active ? "bg-act text-ink" : "text-ink-2 hover:bg-hov hover:text-ink"
      )}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

function FeedRow({
  feed,
  active,
  onClick,
  onDelete,
}: {
  feed: Feed;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1",
        active ? "bg-act" : "hover:bg-hov"
      )}
    >
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
      >
        <span className={cn("truncate text-[13px]", active ? "text-ink" : "text-ink-2")}>
          {feedLabel(feed)}
        </span>
        {!feed.active && <span className="shrink-0 text-[10px] text-ink-3">off</span>}
      </button>
      <Popover
        placement="bottom-end"
        trigger={(props, open) => (
          <button
            {...props}
            title="Feed actions"
            className={cn(
              "rounded p-0.5 text-ink-3 hover:bg-hov hover:text-ink",
              open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      >
        {(close) => (
          <MenuList>
            <MenuItem
              icon={ArrowUpRight}
              label="Open source site"
              onClick={() => {
                close();
                void readerOpenExternal(feed.site_url || feed.url);
              }}
            />
            <MenuItem
              icon={Trash2}
              label="Delete source"
              danger
              onClick={() => {
                close();
                onDelete();
              }}
            />
          </MenuList>
        )}
      </Popover>
    </div>
  );
}

function ItemRow({ item, read, onOpen }: { item: Item; read: boolean; onOpen: () => void }) {
  const when = timeAgo(item.published_at || item.fetched_at);
  const preview = item.summary ? stripHtml(item.summary).slice(0, 240) : "";
  return (
    <button
      onClick={onOpen}
      className="group block w-full border-b border-border py-3 text-left hover:bg-hov"
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "text-[14.5px] font-semibold group-hover:text-accent",
            read ? "text-ink-3" : "text-ink"
          )}
        >
          {item.title || "(untitled)"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-ink-3">
          {when}
          <ArrowUpRight size={11} />
        </span>
      </div>
      <div className="flex items-center gap-1.5 pt-0.5 text-[11.5px] text-ink-3">
        {item.feed_title && <span className="truncate">{item.feed_title}</span>}
        {item.categories.length > 0 && (
          <span className="truncate text-accent/70">· {item.categories.join(", ")}</span>
        )}
      </div>
      {preview && (
        <p className={cn("pt-1 text-[13px] leading-relaxed", read ? "text-ink-3" : "text-ink-2")}>
          {preview}
        </p>
      )}
    </button>
  );
}

function AddFeedModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (url: string, category: string) => Promise<string | null>;
}) {
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!url.trim()) return;
    setBusy(true);
    setErr(null);
    const error = await onAdd(url, category);
    setBusy(false);
    if (error) setErr(error);
  }

  return (
    <Modal onClose={onClose} width="min(460px, 92vw)">
      <div className="p-5">
        <h2 className="pb-1 text-[16px] font-bold">Add RSS source</h2>
        <p className="pb-4 text-[12.5px] text-ink-2">
          Paste a feed URL. It's written to your canonical feeds.yaml and picked up on the next
          Refresh.
        </p>
        <label htmlFor="reader-add-url" className="block pb-1 text-[12px] font-semibold text-ink-2">
          Feed URL
        </label>
        <input
          id="reader-add-url"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="https://example.com/feed.xml"
          className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-accent"
        />
        <label htmlFor="reader-add-category" className="block pb-1 text-[12px] font-semibold text-ink-2">
          Category <span className="font-normal text-ink-3">(optional)</span>
        </label>
        <input
          id="reader-add-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="AI World"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-accent"
        />
        {err && <p className="pt-3 text-[12.5px] text-[var(--pal-red)]">{err}</p>}
        <div className="flex justify-end gap-2 pt-5">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-hov"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!url.trim() || busy}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-2 disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Add source
          </button>
        </div>
      </div>
    </Modal>
  );
}
