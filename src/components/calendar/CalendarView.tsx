import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { addDays, addMonths } from "date-fns";
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { SchedulerWarning } from "../../../convex/lib/scheduler";
import { useUI } from "../../state/ui";
import { cn, tzOffsetMin } from "../../lib/utils";
import { fmtDuration } from "../../lib/dates";
import { Popover } from "../common/Popover";
import { WeekGrid, type CreateDraft } from "./WeekGrid";
import { MonthGrid, monthTitle } from "./MonthGrid";
import { EventModal, type EventDraft } from "./EventModal";

// WHAT: The calendar page — week planner + month overview, schedule warnings,
// and manual reflow. This is where the auto-scheduling engine becomes visible.
export function CalendarView() {
  const calMode = useUI((s) => s.calMode);
  const setCalMode = useUI((s) => s.setCalMode);
  const calAnchor = useUI((s) => s.calAnchor);
  const setCalAnchor = useUI((s) => s.setCalAnchor);
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null);
  const reflow = useMutation(api.scheduling.reflowNow);
  const [reflowing, setReflowing] = useState(false);

  function shift(dir: 1 | -1) {
    setCalAnchor(
      calMode === "week"
        ? addDays(calAnchor, dir * 7).getTime()
        : addMonths(calAnchor, dir).getTime()
    );
  }

  // Keyboard: T today, J/K periods (Notion Calendar muscle memory).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "t") setCalAnchor(Date.now());
      if (e.key === "j") shift(1);
      if (e.key === "k") shift(-1);
      if (e.key === "w") setCalMode("week");
      if (e.key === "m") setCalMode("month");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calMode, calAnchor]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-6 pb-3 pt-5">
        <h1 className="text-[20px] font-extrabold tracking-tight">{monthTitle(calAnchor)}</h1>
        <span className="flex-1" />
        <WarningsButton />
        <button
          onClick={async () => {
            setReflowing(true);
            try {
              await reflow({ tzOffsetMin: tzOffsetMin() });
            } finally {
              setTimeout(() => setReflowing(false), 400);
            }
          }}
          title="Recompute the auto-schedule"
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[13px] text-ink-2 hover:bg-hov hover:text-ink"
        >
          <RefreshCw size={13} className={cn(reflowing && "animate-spin")} /> Reflow
        </button>
        <div className="flex overflow-hidden rounded-md border border-border text-[13px]">
          {(["week", "month"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setCalMode(m)}
              className={cn(
                "px-2.5 py-1 font-medium capitalize",
                calMode === m ? "bg-accent text-white" : "text-ink-2 hover:bg-hov"
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={() => setCalAnchor(Date.now())}
          className="rounded-md border border-border px-2.5 py-1 text-[13px] text-ink-2 hover:bg-hov hover:text-ink"
        >
          Today
        </button>
        <div className="flex">
          <button onClick={() => shift(-1)} className="rounded-md p-1.5 text-ink-2 hover:bg-hov">
            <ChevronLeft size={16} />
          </button>
          <button onClick={() => shift(1)} className="rounded-md p-1.5 text-ink-2 hover:bg-hov">
            <ChevronRight size={16} />
          </button>
        </div>
        <button
          onClick={() => {
            const base = new Date();
            base.setHours(base.getHours() + 1, 0, 0, 0);
            setEventDraft({ mode: "create", start: base.getTime(), end: base.getTime() + 3600_000 });
          }}
          className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-accent-2"
        >
          <Plus size={14} /> Event
        </button>
      </div>

      {calMode === "week" ? (
        <WeekGrid
          anchor={calAnchor}
          onCreateEvent={(d: CreateDraft) => setEventDraft({ mode: "create", ...d })}
          onEditEvent={(event) => setEventDraft({ mode: "edit", event })}
        />
      ) : (
        <MonthGrid anchor={calAnchor} />
      )}

      {eventDraft && <EventModal draft={eventDraft} onClose={() => setEventDraft(null)} />}
    </div>
  );
}

function WarningsButton() {
  const state = useQuery(api.scheduling.getWarnings);
  const myTasks = useQuery(api.calendarData.myTasks) ?? [];
  const openRow = useUI((s) => s.openRow);
  const warnings = ((state?.warnings ?? []) as SchedulerWarning[]);
  const needsEstimate = myTasks.filter((t) => !t.estimateMin);
  const total = warnings.length + needsEstimate.length;
  if (total === 0) return null;

  return (
    <Popover
      className="w-80"
      placement="bottom-end"
      trigger={(p) => (
        <button
          {...p}
          className="flex items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--pal-red)_40%,transparent)] bg-[color-mix(in_srgb,var(--pal-red)_8%,transparent)] px-2.5 py-1 text-[13px] font-medium text-[var(--pal-red)]"
        >
          <AlertTriangle size={13} /> {total} need{total === 1 ? "s" : ""} attention
        </button>
      )}
    >
      {(close) => (
        <div className="p-2">
          {warnings.length > 0 && (
            <>
              <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Schedule warnings
              </div>
              {warnings.map((w) => (
                <button
                  key={w.taskId}
                  onClick={() => {
                    close();
                    openRow(w.taskId);
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hov"
                >
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--pal-red)]" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{w.title}</span>
                    <span className="block text-[12px] text-ink-2">
                      {w.reason === "no_capacity"
                        ? `${fmtDuration(w.unscheduledMin)} won't fit before the horizon`
                        : "Scheduled past its due date"}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}
          {needsEstimate.length > 0 && (
            <>
              <div className="px-1 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Needs an estimate
              </div>
              {needsEstimate.map((t) => (
                <button
                  key={t.rowId}
                  onClick={() => {
                    close();
                    openRow(t.rowId);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hov"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{t.title}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">add estimate →</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </Popover>
  );
}
