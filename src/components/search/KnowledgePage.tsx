import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Loader2, Search, Sparkles } from "lucide-react";
import { useUI } from "../../state/ui";
import { cn } from "../../lib/utils";
import {
  knowledgeAnswer,
  knowledgeAvailable,
  knowledgeSearch,
  openExternalUrl,
  type KnowledgeResult,
} from "../../lib/knowledgeBridge";

// WHAT: Enterprise Search over ASTGL knowledge (local mcp-astgl-knowledge).
// Results are instant-ish; Answer mode is an explicit click (conserves the
// server's daily query quota).
export function KnowledgePage() {
  const nav = useUI((s) => s.nav);
  const initialQuery = nav.kind === "knowledge" ? (nav.initialQuery ?? "") : "";
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState<KnowledgeResult[]>([]);
  const [rateInfo, setRateInfo] = useState<string | undefined>();
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState<"search" | "answer" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchedOnce = useRef(false);

  async function runSearch(query: string) {
    if (!query.trim()) return;
    setBusy("search");
    setError(null);
    setAnswer(null);
    const r = await knowledgeSearch(query.trim(), 8);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    searchedOnce.current = true;
    setResults(r.data.results);
    setRateInfo(r.data.rateInfo);
  }

  async function runAnswer() {
    if (!q.trim()) return;
    setBusy("answer");
    setError(null);
    const r = await knowledgeAnswer(q.trim());
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setAnswer(r.data);
  }

  useEffect(() => {
    if (initialQuery) void runSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-10 pb-24 pt-12">
        <h1 className="flex items-center gap-2 pb-1 text-[28px] font-extrabold tracking-tight">
          <BookOpen size={24} className="text-accent" /> Knowledge
        </h1>
        <p className="pb-5 text-[13px] text-ink-2">
          Enterprise search across ASTGL — powered by your local knowledge server.
        </p>

        {!knowledgeAvailable() && (
          <div className="mb-4 rounded-lg border border-border bg-hov px-3 py-2 text-[13px] text-ink-2">
            Knowledge search needs the desktop app window.
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 focus-within:border-accent">
            <Search size={15} className="shrink-0 text-ink-3" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch(q)}
              placeholder="Search ASTGL articles, tutorials, FAQs…"
              className="w-full bg-transparent text-[14.5px] outline-none placeholder:text-ink-3"
            />
            {busy === "search" && <Loader2 size={15} className="animate-spin text-accent" />}
          </div>
          <button
            disabled={!q.trim() || busy !== null || !knowledgeAvailable()}
            onClick={() => void runAnswer()}
            title="Ask for a single sourced answer"
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13.5px] font-semibold text-white hover:bg-accent-2 disabled:opacity-50"
          >
            {busy === "answer" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Answer
          </button>
        </div>

        {error && <p className="pt-3 text-[13px] text-[var(--pal-red)]">{error}</p>}

        {answer && (
          <div className="mt-5 rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
            <div className="flex items-center gap-1.5 pb-2 text-[12px] font-bold uppercase tracking-wide text-accent">
              <Sparkles size={13} /> Answer
            </div>
            <LinkifiedText text={answer} />
          </div>
        )}

        <div className="pt-5">
          {results.map((r, i) => (
            <button
              key={`${r.url}-${i}`}
              onClick={() => r.url && void openExternalUrl(r.url)}
              className="group block w-full border-b border-border py-3 text-left hover:bg-hov"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[14.5px] font-semibold group-hover:text-accent">
                  {r.title}
                </span>
                {r.section && <span className="truncate text-[12px] text-ink-3">{r.section}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-ink-3">
                  {Math.round(r.score * 100)}% <ArrowUpRight size={11} />
                </span>
              </div>
              {r.url && <div className="truncate pt-0.5 text-[11.5px] text-accent/80">{r.url}</div>}
              <p className="pt-1 text-[13px] leading-relaxed text-ink-2">{r.snippet}</p>
            </button>
          ))}
          {searchedOnce.current && results.length === 0 && busy === null && !error && (
            <p className="py-8 text-center text-[13px] text-ink-3">No matches in the knowledge base.</p>
          )}
        </div>

        {rateInfo && <p className="pt-4 text-[11px] text-ink-3">{rateInfo}</p>}
      </div>
    </div>
  );
}

/** Render answer text with clickable source URLs (opens externally). */
function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <button
            key={i}
            onClick={() => void openExternalUrl(part.replace(/[.,)]+$/, ""))}
            className={cn("break-all text-accent underline decoration-accent/40 hover:decoration-accent")}
          >
            {part}
          </button>
        ) : (
          <span key={i}>{part.replace(/\*\*/g, "")}</span>
        )
      )}
    </p>
  );
}
