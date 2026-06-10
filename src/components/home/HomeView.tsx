import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { AlertTriangle, ArrowRight, CalendarDays, Clock, Lock, Zap } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { SchedulerWarning } from "../../../convex/lib/scheduler";
import { useUI } from "../../state/ui";
import { cn, tzOffsetMin } from "../../lib/utils";
import { fmtDuration, fmtTime, fmtDateValue, todayCalendarMs, epochToCalendarMs } from "../../lib/dates";
import { Chip } from "../common/bits";

const DAY_MS = 86_400_000;

export function HomeView() {
  const navigate = useUI((s) => s.navigate);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-10 pb-24 pt-14">
        <p className="text-[13px] font-medium text-ink-2">{format(new Date(), "EEEE, MMMM d")}</p>
        <h1 className="pb-8 text-[32px] font-extrabold tracking-tight">{greeting}, James</h1>

        <WarningsBanner />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <section>
            <SectionHeader
              icon={<CalendarDays size={14} />}
              title="Today"
              action={{ label: "Open calendar", onClick: () => navigate({ kind: "calendar" }) }}
            />
            <TodayAgenda />
          </section>
          <section>
            <SectionHeader icon={<Zap size={14} />} title="My Tasks" />
            <MyTasks />
          </section>
        </div>

        <section className="pt-10">
          <SectionHeader icon={<Clock size={14} />} title="Recently edited" />
          <RecentPages />
        </section>
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border pb-2">
      <span className="text-ink-3">{icon}</span>
      <h2 className="text-[13px] font-bold uppercase tracking-wide text-ink-2">{title}</h2>
      <span className="flex-1" />
      {action && (
        <button
          onClick={action.onClick}
          className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-accent"
        >
          {action.label} <ArrowRight size={11} />
        </button>
      )}
    </div>
  );
}

function WarningsBanner() {
  const state = useQuery(api.scheduling.getWarnings);
  const openRow = useUI((s) => s.openRow);
  const warnings = ((state?.warnings ?? []) as SchedulerWarning[]);
  if (warnings.length === 0) return null;
  return (
    <div className="mb-8 rounded-lg border border-[color-mix(in_srgb,var(--pal-red)_35%,transparent)] bg-[color-mix(in_srgb,var(--pal-red)_7%,transparent)] p-3">
      <div className="flex items-center gap-1.5 pb-1 text-[13px] font-semibold text-[var(--pal-red)]">
        <AlertTriangle size={14} /> Schedule needs attention
      </div>
      {warnings.slice(0, 3).map((w) => (
        <button
          key={w.taskId}
          onClick={() => openRow(w.taskId)}
          className="block w-full truncate text-left text-[13px] text-ink-2 hover:text-ink"
        >
          • <span className="font-medium">{w.title}</span>{" "}
          {w.reason === "no_capacity"
            ? `— ${fmtDuration(w.unscheduledMin)} can't fit in the next two weeks`
            : "— will finish past its due date"}
        </button>
      ))}
    </div>
  );
}

function TodayAgenda() {
  const dayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const events = useQuery(api.events.listRange, { start: dayStart, end: dayStart + DAY_MS }) ?? [];
  const blocks = useQuery(api.timeBlocks.listRange, { start: dayStart, end: dayStart + DAY_MS }) ?? [];
  const openRow = useUI((s) => s.openRow);
  const now = Date.now();

  const agenda = [
    ...events.map((e) => ({
      key: e._id,
      start: e.start,
      end: e.end,
      title: e.title,
      color: e.color ?? "blue",
      kind: "event" as const,
      allDay: e.allDay ?? false,
      locked: false,
      onClick: undefined as (() => void) | undefined,
    })),
    ...blocks.map((b) => ({
      key: b._id,
      start: b.start,
      end: b.end,
      title: b.taskTitle,
      color: b.color,
      kind: "block" as const,
      allDay: false,
      locked: b.locked,
      onClick: () => openRow(b.taskRowId),
    })),
  ].sort((a, b) => Number(a.allDay ? 0 : a.start) - Number(b.allDay ? 0 : b.start) || a.start - b.start);

  if (agenda.length === 0) {
    return <p className="py-4 text-[13px] text-ink-3">Nothing on the calendar today. Enjoy the focus time.</p>;
  }

  return (
    <div className="divide-y divide-border">
      {agenda.map((item) => (
        <button
          key={item.key}
          onClick={item.onClick}
          disabled={!item.onClick}
          className={cn(
            "flex w-full items-center gap-3 py-2 text-left",
            item.onClick && "hover:bg-hov",
            item.end < now && "opacity-50"
          )}
        >
          <span className={cn("h-8 w-1 shrink-0 rounded-full", `swatch-${item.color}`)} />
          <span className="w-36 shrink-0 whitespace-nowrap text-[12px] tabular-nums text-ink-2">
            {item.allDay ? "All day" : `${fmtTime(item.start)} – ${fmtTime(item.end)}`}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{item.title}</span>
          {item.kind === "block" &&
            (item.locked ? (
              <Lock size={12} className="shrink-0 text-ink-3" />
            ) : (
              <Zap size={12} className="shrink-0 text-accent" />
            ))}
        </button>
      ))}
    </div>
  );
}

function MyTasks() {
  const tasks = useQuery(api.calendarData.myTasks) ?? [];
  const updateRow = useMutation(api.rows.updateProperty);
  const openRow = useUI((s) => s.openRow);
  const today = todayCalendarMs();

  const groups = useMemo(() => {
    const overdue: typeof tasks = [];
    const dueToday: typeof tasks = [];
    const upcoming: typeof tasks = [];
    const noDate: typeof tasks = [];
    for (const t of tasks) {
      if (!t.due) noDate.push(t);
      else {
        const day = t.due.includeTime ? epochToCalendarMs(t.due.end ?? t.due.start) : (t.due.end ?? t.due.start);
        if (day < today) overdue.push(t);
        else if (day === today) dueToday.push(t);
        else upcoming.push(t);
      }
    }
    const byDue = (a: (typeof tasks)[number], b: (typeof tasks)[number]) =>
      (a.due?.start ?? 0) - (b.due?.start ?? 0);
    overdue.sort(byDue);
    upcoming.sort(byDue);
    return [
      { label: "Overdue", items: overdue, danger: true },
      { label: "Today", items: dueToday },
      { label: "Upcoming", items: upcoming.slice(0, 6) },
      { label: "No date", items: noDate.slice(0, 4) },
    ].filter((g) => g.items.length > 0);
  }, [tasks, today]);

  if (tasks.length === 0) {
    return <p className="py-4 text-[13px] text-ink-3">All clear — no open tasks.</p>;
  }

  return (
    <div>
      {groups.map((g) => (
        <div key={g.label} className="pt-2.5">
          <div
            className={cn(
              "pb-1 text-[11px] font-semibold uppercase tracking-wide",
              g.danger ? "text-[var(--pal-red)]" : "text-ink-3"
            )}
          >
            {g.label} · {g.items.length}
          </div>
          {g.items.map((t) => (
            <div key={t.rowId} className="group flex items-center gap-2.5 rounded-md px-1 py-1 hover:bg-hov">
              <input
                type="checkbox"
                checked={false}
                disabled={!t.completeOptionId}
                onChange={() => {
                  if (t.completeOptionId) {
                    void updateRow({
                      rowId: t.rowId as never,
                      propId: t.statusPropId,
                      value: t.completeOptionId,
                      tzOffsetMin: tzOffsetMin(),
                    });
                  }
                }}
                className="h-4 w-4 shrink-0 cursor-pointer rounded accent-[var(--accent)]"
                title="Mark done"
              />
              <button
                onClick={() => openRow(t.rowId)}
                className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium"
              >
                {t.title}
              </button>
              {t.estimateMin ? (
                <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">{fmtDuration(t.estimateMin)}</span>
              ) : (
                <span className="shrink-0 text-[11px] text-[var(--pal-yellow)]" title="No estimate — won't be auto-scheduled">
                  no est.
                </span>
              )}
              {t.due && (
                <span className={cn("shrink-0 text-[11.5px]", g.danger ? "text-[var(--pal-red)]" : "text-ink-2")}>
                  {fmtDateValue(t.due)}
                </span>
              )}
              {t.priorityName && <Chip color={t.priorityColor} name={t.priorityName} />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RecentPages() {
  const pages = useQuery(api.pages.list) ?? [];
  const navigate = useUI((s) => s.navigate);
  const recent = [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);

  return (
    <div className="grid grid-cols-2 gap-2 pt-3 sm:grid-cols-4">
      {recent.map((p) => (
        <button
          key={p._id}
          onClick={() => navigate({ kind: "page", pageId: p._id })}
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 text-left hover:border-ink-3"
          style={{ boxShadow: "var(--shadow)" }}
        >
          <span className="text-[20px] leading-none">{p.icon ?? (p.kind === "database" ? "🗄️" : "📄")}</span>
          <span className="truncate text-[13px] font-medium">{p.title || "Untitled"}</span>
          <span className="text-[11px] text-ink-3">{format(p.updatedAt, "MMM d")}</span>
        </button>
      ))}
    </div>
  );
}
