import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  CircleCheck,
  FileText,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { cn, debounce, tzOffsetMin } from "../../lib/utils";
import { fmtDuration } from "../../lib/dates";
import { recorder } from "../../lib/recorder";
import {
  meetingAskMic,
  meetingsAvailable,
  meetingTools,
  type MeetingToolStatus,
} from "../../lib/meetingsBridge";
import { Modal } from "../common/Modal";

const MEETING_TYPES: Array<{ id: string; label: string }> = [
  { id: "general", label: "General" },
  { id: "standup", label: "Standup" },
  { id: "one_on_one", label: "1:1" },
  { id: "client", label: "Client call" },
  { id: "interview", label: "Interview" },
  { id: "brainstorm", label: "Brainstorm" },
];

export function MeetingsView() {
  const meetings = useQuery(api.meetings.list) ?? [];
  const [selectedId, setSelectedId] = useState<Id<"meetings"> | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [tools, setTools] = useState<MeetingToolStatus | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const recStatus = useSyncExternalStore(recorder.subscribe, () => recorder.getState().status);

  useEffect(() => {
    if (!meetingsAvailable()) return;
    void meetingTools().then((r) => {
      if (r.ok) setTools(r.data);
      else setToolsError(r.error);
    });
  }, []);

  if (selectedId) {
    return <MeetingDetail meetingId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const missing: string[] = [];
  if (tools) {
    if (!tools.ffmpeg) missing.push("ffmpeg (`brew install ffmpeg`)");
    if (!tools.whisper) missing.push("whisper.cpp (`brew install whisper-cpp`)");
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-10 pb-24 pt-12">
        <div className="flex items-center gap-3 pb-1">
          <h1 className="flex-1 text-[28px] font-extrabold tracking-tight">Meetings</h1>
          <button
            disabled={!meetingsAvailable() || recStatus !== "idle" || missing.length > 0}
            onClick={() => setStartOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13.5px] font-semibold text-white hover:bg-accent-2 disabled:opacity-50"
          >
            <Mic size={15} /> Record
          </button>
        </div>
        <p className="pb-6 text-[13px] text-ink-2">
          Record → transcribe (whisper.cpp) → summarize (your local Ollama). Nothing leaves this Mac.
        </p>

        {!meetingsAvailable() && (
          <Banner>Meeting notes run in the desktop app — start it with <code>npm run dev</code>.</Banner>
        )}
        {toolsError && <Banner>{toolsError}</Banner>}
        {missing.length > 0 && (
          <Banner>
            Missing tools: {missing.join(" · ")} — then reopen this page.
          </Banner>
        )}
        {recStatus !== "idle" && (
          <Banner tone="accent">Recording in progress — use the widget in the corner to pause or stop.</Banner>
        )}

        {meetings.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-20 text-ink-3">
            <Mic size={28} />
            <p className="text-[14px]">No meetings yet. Hit Record when one starts.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {meetings.map((m) => (
              <button
                key={m._id}
                onClick={() => setSelectedId(m._id)}
                className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-hov"
              >
                <span className="text-[18px]">🎙️</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{m.title}</span>
                  <span className="block text-[12px] text-ink-3">
                    {format(m.startedAt, "EEE, MMM d · h:mm a")}
                    {m.durationSec ? ` · ${fmtDuration(Math.max(1, Math.round(m.durationSec / 60)))}` : ""}
                    {m.meetingType && m.meetingType !== "general"
                      ? ` · ${MEETING_TYPES.find((t) => t.id === m.meetingType)?.label ?? m.meetingType}`
                      : ""}
                  </span>
                </span>
                <StatusChip meeting={m} />
              </button>
            ))}
          </div>
        )}
      </div>
      {startOpen && <StartMeetingModal onClose={() => setStartOpen(false)} />}
    </div>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone?: "accent" }) {
  return (
    <div
      className={cn(
        "mb-4 rounded-lg border px-3 py-2 text-[13px]",
        tone === "accent"
          ? "border-accent/40 bg-accent-soft text-ink"
          : "border-border bg-hov text-ink-2"
      )}
    >
      {children}
    </div>
  );
}

function StatusChip({ meeting }: { meeting: Doc<"meetings"> }) {
  const s = meeting.status;
  if (s === "done") {
    return (
      <span className="flex items-center gap-1 text-[12px] font-medium text-[var(--pal-green)]">
        <CircleCheck size={13} /> Ready
      </span>
    );
  }
  if (s === "error") {
    return (
      <span className="flex items-center gap-1 text-[12px] font-medium text-[var(--pal-red)]">
        <AlertTriangle size={13} /> Failed
      </span>
    );
  }
  if (s === "recording") {
    return (
      <span className="flex items-center gap-1 text-[12px] font-medium text-[var(--pal-red)]">
        <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--pal-red)]" /> Recording
      </span>
    );
  }
  const label =
    s === "uploading"
      ? "Saving audio"
      : s === "transcribing"
        ? `Transcribing${meeting.progress ? ` ${meeting.progress}%` : "…"}`
        : "Summarizing…";
  return (
    <span className="flex items-center gap-1.5 text-[12px] font-medium text-accent">
      <Loader2 size={13} className="animate-spin" /> {label}
    </span>
  );
}

function StartMeetingModal({ onClose }: { onClose: () => void }) {
  const start = useMutation(api.meetings.start);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todaysEvents =
    useQuery(api.events.listRange, {
      start: dayStart.getTime(),
      end: dayStart.getTime() + 86_400_000,
    }) ?? [];
  const now = Date.now();
  const happeningNow = todaysEvents.find((e) => !e.allDay && e.start <= now && e.end >= now);

  const [title, setTitle] = useState(
    happeningNow?.title ?? `Meeting — ${format(now, "MMM d, h:mm a")}`
  );
  const [meetingType, setMeetingType] = useState("general");
  const [eventId, setEventId] = useState<string>(happeningNow?._id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function begin() {
    setStarting(true);
    setErr(null);
    try {
      const mic = await meetingAskMic();
      if (!mic.ok || !mic.data) {
        setErr("Microphone access denied — System Settings → Privacy & Security → Microphone.");
        return;
      }
      const meetingId = await start({
        title,
        meetingType,
        eventId: eventId ? (eventId as Id<"events">) : undefined,
      });
      await recorder.start({ meetingId, title, meetingType });
      onClose();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Modal onClose={onClose} width="400px" top="18vh" showClose={false}>
      <div className="p-5">
        <h2 className="pb-3 text-[18px] font-bold">Record meeting notes</h2>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void begin()}
          className="mb-3 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[14px] outline-none focus:border-accent"
        />
        <div className="mb-3 flex flex-wrap gap-1">
          {MEETING_TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => setMeetingType(t.id)}
              className={cn(
                "rounded-md border px-2 py-1 text-[12px] font-medium",
                meetingType === t.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-ink-2 hover:bg-hov"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {todaysEvents.length > 0 && (
          <label className="mb-3 flex items-center gap-2 text-[13px]">
            <span className="text-ink-2">Event</span>
            <select
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              className="flex-1 rounded-md border border-border bg-surface px-1.5 py-1 text-[12.5px] outline-none"
            >
              <option value="">Not linked</option>
              {todaysEvents.map((e) => (
                <option key={e._id} value={e._id}>
                  {e.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="pb-3 text-[11.5px] leading-snug text-ink-3">
          Records your microphone. The summary is tailored to the meeting type. For the other side
          of video calls, use speakers (not headphones) or a loopback device.
        </p>
        {err && <p className="pb-2 text-[12.5px] text-[var(--pal-red)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hov">
            Cancel
          </button>
          <button
            disabled={starting}
            onClick={() => void begin()}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-2 disabled:opacity-60"
          >
            <Mic size={14} /> Start recording
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MeetingDetail({ meetingId, onBack }: { meetingId: Id<"meetings">; onBack: () => void }) {
  const meeting = useQuery(api.meetings.get, { meetingId });
  const rename = useMutation(api.meetings.rename);
  const removeMeeting = useMutation(api.meetings.remove);
  const createRow = useMutation(api.rows.create);
  const navigate = useUI((s) => s.navigate);
  const openRow = useUI((s) => s.openRow);
  const dbs = useQuery(api.databases.listAll) ?? [];
  const taskDb = dbs.find((d) => d.isTaskSource);
  const [reprocessing, setReprocessing] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [saveTitle] = useState(() =>
    debounce((id: Id<"meetings">, value: string) => void rename({ meetingId: id, title: value }), 400)
  );

  if (meeting === undefined) {
    return <div className="flex h-full items-center justify-center text-ink-3">Loading…</div>;
  }
  if (meeting === null) {
    onBack();
    return null;
  }

  async function actionToTask(item: string) {
    if (!taskDb) return;
    const rowId = await createRow({
      databaseId: taskDb._id,
      properties: { title: item },
      tzOffsetMin: tzOffsetMin(),
    });
    if (rowId) openRow(rowId);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-10 pb-24 pt-10">
        <button onClick={onBack} className="mb-4 flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink">
          <ArrowLeft size={14} /> Meetings
        </button>

        <div className="flex items-start gap-2">
          <input
            value={title ?? meeting.title}
            onChange={(e) => {
              setTitle(e.target.value);
              saveTitle(meetingId, e.target.value);
            }}
            className="w-full flex-1 bg-transparent text-[26px] font-extrabold tracking-tight outline-none"
          />
          <button
            title="Delete meeting (notes page stays)"
            onClick={() => {
              if (confirm("Delete this meeting and its audio? The notes page stays.")) {
                onBack();
                void removeMeeting({ meetingId });
              }
            }}
            className="mt-1.5 rounded-md p-1.5 text-ink-3 hover:bg-hov hover:text-[var(--pal-red)]"
          >
            <Trash2 size={15} />
          </button>
        </div>
        <p className="pb-4 text-[12.5px] text-ink-3">
          {format(meeting.startedAt, "EEEE, MMM d · h:mm a")}
          {meeting.durationSec ? ` · ${fmtDuration(Math.max(1, Math.round(meeting.durationSec / 60)))}` : ""}
          {meeting.modelUsed ? ` · ${meeting.modelUsed}` : ""}
        </p>

        <div className="flex items-center gap-3 pb-4">
          <StatusChip meeting={meeting} />
          {meeting.status === "error" && meeting.error && (
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--pal-red)]">{meeting.error}</span>
          )}
          {(meeting.status === "error" || meeting.status === "done") && meeting.audioUrl && (
            <button
              disabled={reprocessing}
              onClick={async () => {
                setReprocessing(true);
                try {
                  const { reprocessMeeting } = await import("../../lib/meetingPipeline");
                  await reprocessMeeting(meetingId);
                } finally {
                  setReprocessing(false);
                }
              }}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-ink-2 hover:bg-hov hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={12} className={cn(reprocessing && "animate-spin")} /> Re-run AI
            </button>
          )}
          {meeting.pageId && (
            <button
              onClick={() => navigate({ kind: "page", pageId: meeting.pageId! })}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-ink-2 hover:bg-hov hover:text-ink"
            >
              <FileText size={12} /> Open notes page
            </button>
          )}
        </div>

        {meeting.audioUrl && (
          <audio controls src={meeting.audioUrl} className="mb-5 h-9 w-full" preload="none" />
        )}

        {meeting.summary && (
          <Section title="Summary">
            {meeting.summary.split(/\n+/).map((p, i) => (
              <p key={i} className="pb-2 text-[14px] leading-relaxed">{p}</p>
            ))}
          </Section>
        )}
        {(meeting.keyPoints?.length ?? 0) > 0 && (
          <Section title="Key points">
            <ul className="list-disc space-y-1 pl-5 text-[14px]">
              {meeting.keyPoints!.map((k, i) => <li key={i}>{k}</li>)}
            </ul>
          </Section>
        )}
        {(meeting.decisions?.length ?? 0) > 0 && (
          <Section title="Decisions">
            <ul className="list-disc space-y-1 pl-5 text-[14px]">
              {meeting.decisions!.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </Section>
        )}
        {(meeting.actionItems?.length ?? 0) > 0 && (
          <Section title="Action items">
            {meeting.actionItems!.map((a, i) => (
              <div key={i} className="group flex items-center gap-2 py-1">
                <span className="text-[14px]">▢ {a}</span>
                {taskDb && (
                  <button
                    title="Create task"
                    onClick={() => void actionToTask(a)}
                    className="hidden items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-hov hover:text-accent group-hover:flex"
                  >
                    <Plus size={11} /> task
                  </button>
                )}
              </div>
            ))}
          </Section>
        )}
        {meeting.transcript && (
          <details className="pt-2">
            <summary className="cursor-pointer text-[13px] font-bold uppercase tracking-wide text-ink-2 hover:text-ink">
              Transcript
            </summary>
            <p className="whitespace-pre-wrap pt-2 text-[13px] leading-relaxed text-ink-2">
              {meeting.transcript}
            </p>
          </details>
        )}
        {meeting.eventId && (
          <p className="flex items-center gap-1 pt-4 text-[12px] text-ink-3">
            <ArrowUpRight size={12} /> Linked to a calendar event
          </p>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pb-5">
      <h2 className="border-b border-border pb-1.5 text-[13px] font-bold uppercase tracking-wide text-ink-2">
        {title}
      </h2>
      <div className="pt-2.5">{children}</div>
    </section>
  );
}
