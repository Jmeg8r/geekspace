import { useEffect, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ChevronLeft, ChevronRight, Loader2, Monitor, Mic, Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { tzOffsetMin } from "../../lib/utils";
import { approveDraft, assistantAvailable, requestImage, summarizeDay } from "../../lib/assistantBridge";
import {
  approveLabel,
  dayWindow,
  discardLabel,
  groupActions,
  groupSummary,
  sourceLink,
  timeline,
  undoLabel,
  type ActionGroup,
  type DayRecordRows,
  type Source,
} from "../../lib/dayRecord";

// WHAT: the Day Record (plan PR 6c, spec R12, R13): one day of what the assistant drafted and
// did, with Send, Discard and Undo; the end-of-day summary, made when asked; and the day's
// record, where every line links to the item it came from.

// Long screen text is folded; the whole of it is one click away.
const OCR_PREVIEW_CHARS = 300;
// How many of a day's actions load at first, and with each "Show more".
const ACTIONS_PAGE = 100;
// How often an interrupted send's wait is checked, so its retry button appears on time.
const RETRY_TICK_MS = 15_000;

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function DayRecordView() {
  const [offset, setOffset] = useState(0);
  const { day, from, to } = dayWindow(new Date(), offset);
  const record = useQuery(api.assistant.dayRecord, { from, to });
  const queue = useQuery(api.assistant.reviewQueue, {});
  const summary = useQuery(api.assistant.daySummary, { day });
  const cap = useQuery(api.assistant.capStatus, { day: dayWindow(new Date()).day });
  const title = new Date(from).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-10 pb-24 pt-12">
        <div className="flex items-center gap-2 pb-1">
          <h1 className="flex-1 text-[28px] font-extrabold tracking-tight">Day record</h1>
          <button aria-label="Previous day" onClick={() => setOffset((o) => o - 1)} className="rounded p-1.5 hover:bg-hover">
            <ChevronLeft size={16} />
          </button>
          <button
            disabled={offset === 0}
            onClick={() => setOffset(0)}
            className="rounded px-2 py-1 text-[13px] hover:bg-hover disabled:opacity-50"
          >
            Today
          </button>
          <button
            aria-label="Next day"
            disabled={offset === 0}
            onClick={() => setOffset((o) => o + 1)}
            className="rounded p-1.5 hover:bg-hover disabled:opacity-50"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <p className="pb-6 text-[13px] text-ink-2">
          {title}
          {cap && cap.capUsd !== null && ` · Assistant spent $${cap.spentUsd.toFixed(2)} of $${cap.capUsd.toFixed(2)} today`}
          {cap?.reached && cap.capUsd !== null && " · paused until tomorrow"}
        </p>

        {!assistantAvailable() && (
          <p role="status" className="mb-6 rounded-md border border-border px-3 py-2 text-[13px] text-ink-2">
            Sending drafts, summaries and screens needs the Geekspace desktop app.
          </p>
        )}

        <Drafts queue={queue} />
        {record && <Actions key={day} from={from} to={to} record={record} />}
        {record && <Summary day={day} from={from} to={to} summary={summary} record={record} />}
        <Record record={record} />
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="pb-2 pt-6 text-[15px] font-bold">{children}</h2>;
}

function Alert({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="py-1 text-[12.5px] text-[color:var(--recorder-error)]">
      {text}
    </p>
  );
}

type Queue =
  | {
      _id: Id<"externalDrafts">;
      issueRef: string;
      body: string;
      status: "pending" | "approved" | "sent" | "discarded";
      deliveryUnknown: boolean;
      retryAfter?: number;
    }[]
  | undefined;

/** The clock, ticking, so a wait that ends shows as ended. */
function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/**
 * Linear drafts (spec R12): nothing is sent until Send. A send that was cut off stays listed,
 * and can be sent again once its claim lapses; that send checks Linear first (Codex 6c r2).
 */
function Drafts({ queue }: { queue: Queue }) {
  const discard = useMutation(api.assistant.setDraftStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(RETRY_TICK_MS);
  if (!queue || queue.length === 0) return null;

  async function run(id: string, act: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await act();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="drafts-heading">
      <Heading>
        <span id="drafts-heading">Waiting for your approval</span>
      </Heading>
      <ul className="space-y-3">
        {queue.map((d) => (
          <li key={d._id} className="rounded-md border border-border p-3">
            <p className="pb-1 text-[12.5px] font-semibold text-ink-2">Linear · {d.issueRef}</p>
            <p className="whitespace-pre-wrap text-[13.5px]">{d.body}</p>
            {d.status === "approved" ? (
              <p className="pt-1 text-[12px] text-ink-2">
                {d.retryAfter !== undefined && now < d.retryAfter
                  ? "Sending…"
                  : "This send was interrupted. Sending again checks Linear first, so it won't post twice."}
              </p>
            ) : (
              d.deliveryUnknown && (
                <p className="pt-1 text-[12px] text-ink-2">The last send may have gone through. Sending checks Linear first, so it won't post twice.</p>
              )
            )}
            <div className="flex gap-2 pt-2">
              <button
                disabled={busy !== null || !assistantAvailable() || (d.retryAfter !== undefined && now < d.retryAfter)}
                onClick={() =>
                  void run(d._id, async () => {
                    const r = await approveDraft(d._id);
                    if (!r.ok) throw new Error(r.error);
                  })
                }
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-[13px] font-semibold text-white hover:bg-accent-2 disabled:opacity-50"
              >
                {busy === d._id && <Loader2 size={13} className="animate-spin" />}
                {d.status === "approved" ? `${approveLabel(d)} again` : approveLabel(d)}
              </button>
              <button
                disabled={busy !== null || (d.retryAfter !== undefined && now < d.retryAfter)}
                onClick={() =>
                  void run(d._id, async () => {
                    await discard({ draftId: d._id, status: "discarded" });
                  })
                }
                className="rounded-md px-3 py-1 text-[13px] hover:bg-hover disabled:opacity-50"
              >
                {discardLabel(d)}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <Alert text={error} />
    </section>
  );
}

/**
 * Where a line came from: a link to it in the day's record, or, when it is past the rows the
 * view lists, its own text shown in place (Codex 6c r2: every line links to its source).
 */
function SourceLinkText({ source, record }: { source: Source; record: DayRecordRows }) {
  const link = sourceLink(source, record);
  const [open, setOpen] = useState(false);
  // SAFETY: a source's ids come from dayActions or daySummary, which hold these tables' ids.
  const ids = source as { sourceSegmentId?: Id<"captureSegments">; sourceScreenshotId?: Id<"screenshots"> };
  const found = useQuery(api.assistant.source, !link && open ? ids : "skip");
  if (link) {
    return (
      <a href={`#${link.anchor}`} className="text-[12px] text-ink-2 underline underline-offset-2 hover:text-ink">
        {link.text}
      </a>
    );
  }
  if (!source.sourceSegmentId && !source.sourceScreenshotId) return null;
  return (
    <span className="text-[12px] text-ink-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="underline underline-offset-2 hover:text-ink">
        {open ? "Hide source" : "Show source"}
      </button>
      {open && found === null && <span> · It is no longer in the record.</span>}
      {open && found && (
        <span className="mt-1 block whitespace-pre-wrap rounded bg-hover px-2 py-1">
          {found.kind === "said" ? "Said" : "On screen"} at {time(found.at)}: {found.text}
        </span>
      )}
    </span>
  );
}

/**
 * What the assistant did that day, each commitment with its labelled Undo (spec R11, R13),
 * a page at a time so a long day reaches every one (Codex 6c r2).
 */
function Actions({ from, to, record }: { from: number; to: number; record: DayRecordRows }) {
  const undo = useMutation(api.assistant.undo);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { results, status, loadMore } = usePaginatedQuery(api.assistant.dayActions, { from, to }, { initialNumItems: ACTIONS_PAGE });
  const groups = groupActions(results);

  async function undoGroup(group: ActionGroup) {
    setBusy(group.groupId);
    setError(null);
    try {
      // SAFETY: a group's ids come from dayActions, which returns assistantActions ids.
      await undo({ actionId: group.actions[0]._id as Id<"assistantActions">, tzOffsetMin: tzOffsetMin() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="actions-heading">
      <Heading>
        <span id="actions-heading">What the assistant did</span>
      </Heading>
      {groups.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing yet on this day.</p>
      ) : (
        <ul className="divide-y divide-border">
          {groups.map((g) => (
            <li key={g.groupId} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className={g.undone ? "text-[13.5px] text-ink-3 line-through" : "text-[13.5px]"}>{groupSummary(g)}</p>
                <p className="flex gap-2 text-[12px] text-ink-3">
                  {new Date(g.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  <SourceLinkText source={g.actions[0]} record={record} />
                </p>
              </div>
              {g.undone ? (
                <span className="text-[12.5px] text-ink-3">Undone</span>
              ) : (
                <button
                  disabled={busy !== null}
                  onClick={() => void undoGroup(g)}
                  className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12.5px] hover:bg-hover disabled:opacity-50"
                >
                  {undoLabel(g)}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {status === "CanLoadMore" && (
        <button onClick={() => loadMore(ACTIONS_PAGE)} className="mt-2 text-[12.5px] text-ink-2 underline underline-offset-2">
          Show more of this day's actions
        </button>
      )}
      <Alert text={error} />
    </section>
  );
}

type SummaryDoc =
  | {
      items: { text: string; sourceSegmentId?: string; sourceScreenshotId?: string }[];
      at: number;
      omitted?: { unsourced: number; leftOut: number; truncated: number };
    }
  | null
  | undefined;

/** The end-of-day summary (spec R13), made only when asked; every line links to its source. */
function Summary({ day, from, to, summary, record }: { day: string; from: number; to: number; summary: SummaryDoc; record: DayRecordRows }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read from the saved summary, so it is there whenever the summary is (Codex 6c r2).
  const note = summary?.omitted ? summaryNote(summary.omitted) : null;

  async function make() {
    setBusy(true);
    setError(null);
    const r = await summarizeDay(day, from, to);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.data.ok) setError(r.data.reason);
  }

  return (
    <section aria-labelledby="summary-heading">
      <div className="flex items-center gap-2">
        <Heading>
          <span id="summary-heading">Summary</span>
        </Heading>
        <span className="flex-1" />
        <button
          disabled={busy || !assistantAvailable()}
          onClick={() => void make()}
          className="mt-4 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12.5px] hover:bg-hover disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {summary ? "Summarize this day again" : "Summarize this day"}
        </button>
      </div>
      {summary ? (
        <ul className="list-disc space-y-1 pl-5 text-[13.5px]">
          {summary.items.map((item, i) => (
            <li key={i}>
              {item.text} <SourceLinkText source={item} record={record} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-ink-3">
          No summary yet. Summarizing sends this day's transcripts and screen text to Anthropic, within the daily cap.
        </p>
      )}
      {note && (
        <p role="status" className="pt-1 text-[12px] text-ink-2">
          {note}
        </p>
      )}
      <Alert text={error} />
    </section>
  );
}

/** What a summary could not cover, said plainly; null when it covered everything. */
function summaryNote({ unsourced, leftOut, truncated }: { unsourced: number; leftOut: number; truncated: number }): string | null {
  const parts = [];
  if (leftOut) parts.push(`${leftOut} of the day's items didn't fit within the cap and aren't in it`);
  if (truncated) parts.push(`${truncated} long item(s) were only partly read`);
  if (unsourced) parts.push(`${unsourced} line(s) Claude couldn't tie to the record were left out`);
  return parts.length ? `This summary is partial: ${parts.join("; ")}.` : null;
}

/** The day as captured: what was said and what was on screen, oldest first. */
function Record({ record }: { record: DayRecordRows | undefined }) {
  if (!record) return <p className="pt-6 text-[13px] text-ink-3">Loading the day…</p>;
  const entries = timeline(record);
  return (
    <section aria-labelledby="record-heading">
      <Heading>
        <span id="record-heading">Record</span>
      </Heading>
      {entries.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing was captured on this day.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((e) => (
            <li key={e.anchor} id={e.anchor} className="scroll-mt-4 rounded-md px-2 py-1.5 target:bg-hover">
              {e.kind === "transcript" ? <Said row={e.row} /> : <Screen row={e.row} />}
            </li>
          ))}
        </ol>
      )}
      {(record.more.transcripts || record.more.screenshots) && (
        <p className="pt-2 text-[12px] text-ink-3">This day has more than the view shows; only its first 500 transcripts and screens are listed.</p>
      )}
    </section>
  );
}


function Said({ row }: { row: DayRecordRows["transcripts"][number] }) {
  return (
    <div className="flex gap-2">
      <Mic size={14} className="mt-0.5 shrink-0 text-ink-3" aria-label="Said" />
      <div className="min-w-0">
        <p className="text-[12px] text-ink-3">{time(row.start)}</p>
        <p className="whitespace-pre-wrap text-[13.5px]">{row.text}</p>
      </div>
    </div>
  );
}

function Screen({ row }: { row: DayRecordRows["screenshots"][number] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const long = row.ocrText.length > OCR_PREVIEW_CHARS;

  async function read() {
    setBusy(true);
    setNote(null);
    const r = await requestImage(row._id);
    setBusy(false);
    if (!r.ok) setNote(r.error);
    else if (!r.data.ok) setNote(r.data.reason);
    else setNote(r.data.actions === 0 ? "Read; nothing to add." : `Read; ${r.data.actions} action(s) added above.`);
  }

  return (
    <div className="flex gap-2">
      <Monitor size={14} className="mt-0.5 shrink-0 text-ink-3" aria-label="On screen" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-ink-3">
          {time(row.takenAt)}
          {row.appBundleId && ` · ${row.appBundleId}`}
          {row.purged && " · image deleted after 30 days; its text is kept"}
        </p>
        <p className="whitespace-pre-wrap text-[13px] text-ink-2">{open || !long ? row.ocrText : `${row.ocrText.slice(0, OCR_PREVIEW_CHARS)}…`}</p>
        <div className="flex gap-3 pt-1">
          {long && (
            <button onClick={() => setOpen((o) => !o)} className="text-[12px] text-ink-2 underline underline-offset-2">
              {open ? "Show less" : "Show all of this screen's text"}
            </button>
          )}
          {!row.purged && (
            <button
              disabled={busy || !assistantAvailable()}
              onClick={() => void read()}
              className="flex items-center gap-1 text-[12px] text-ink-2 underline underline-offset-2 disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              Send this screen's image to Claude
            </button>
          )}
        </div>
        {note && (
          <p role="status" className="pt-1 text-[12px] text-ink-2">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
