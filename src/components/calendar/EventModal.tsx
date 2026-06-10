import { useState } from "react";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { OPTION_COLOR_IDS } from "../../../convex/lib/types";
import { calendarToEpochMs, epochToCalendarMs, fmtCalendarDate } from "../../lib/dates";
import { cn, tzOffsetMin } from "../../lib/utils";
import { swatchClass } from "../../lib/optionColors";
import { integrationsAvailable, macOpenApp } from "../../lib/integrations";
import { Modal } from "../common/Modal";
import { Popover } from "../common/Popover";
import { DatePicker, TimeSelect } from "../common/DatePicker";

export type EventDraft =
  | { mode: "create"; start: number; end: number }
  | { mode: "edit"; event: Doc<"events"> };

// WHAT: Create/edit appointment modal — fixed events are what the auto-scheduler
// plans around, so changes here cascade through the whole schedule.
export function EventModal({ draft, onClose }: { draft: EventDraft; onClose: () => void }) {
  const create = useMutation(api.events.create);
  const update = useMutation(api.events.update);
  const remove = useMutation(api.events.remove);

  const initial = draft.mode === "edit" ? draft.event : null;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [allDay, setAllDay] = useState(initial?.allDay ?? false);
  const [day, setDay] = useState(() =>
    epochToCalendarMs(initial?.start ?? (draft.mode === "create" ? draft.start : Date.now()))
  );
  const [startMin, setStartMin] = useState(() => {
    const s = new Date(initial?.start ?? (draft.mode === "create" ? draft.start : Date.now()));
    return s.getHours() * 60 + s.getMinutes();
  });
  const [endMin, setEndMin] = useState(() => {
    const e = new Date(initial?.end ?? (draft.mode === "create" ? draft.end : Date.now() + 3600_000));
    const m = e.getHours() * 60 + e.getMinutes();
    return m === 0 ? 24 * 60 : m;
  });
  const [color, setColor] = useState(initial?.color ?? "blue");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  // Synced macOS Calendar events are read-only mirrors.
  if (draft.mode === "edit" && draft.event.source) {
    const ev = draft.event;
    return (
      <Modal onClose={onClose} width="380px" top="18vh" showClose={false}>
        <div className="p-5">
          <div className="flex items-center gap-2 pb-1">
            <span className={cn("h-3 w-3 shrink-0 rounded-full", swatchClass(ev.color))} />
            <h2 className="text-[18px] font-bold leading-tight">{ev.title}</h2>
          </div>
          <p className="text-[13px] text-ink-2">
            {ev.allDay
              ? `${format(ev.start, "EEE, MMM d")} · All day`
              : `${format(ev.start, "EEE, MMM d · h:mm a")} – ${format(ev.end, "h:mm a")}`}
          </p>
          {ev.calendarName && (
            <p className="pt-1 text-[12px] text-ink-3">
              {ev.calendarName} · synced from macOS Calendar
            </p>
          )}
          {ev.notes && <p className="pt-2 text-[13px]">{ev.notes}</p>}
          <p className="pt-3 text-[11.5px] leading-snug text-ink-3">
            Read-only here — edit it in Calendar and it syncs back automatically.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            {integrationsAvailable() && (
              <button
                onClick={() => void macOpenApp("Calendar")}
                className="rounded-md border border-border px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hov hover:text-ink"
              >
                Open Calendar
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-2"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  async function save() {
    const start = allDay ? day : calendarToEpochMs(day, startMin);
    const end = allDay ? day + 86_400_000 : calendarToEpochMs(day, Math.max(endMin, startMin + 15));
    const doc = {
      title: title.trim() || "Untitled event",
      start,
      end,
      allDay: allDay || undefined,
      color,
      notes: notes.trim() || undefined,
      tzOffsetMin: tzOffsetMin(),
    };
    if (draft.mode === "create") await create(doc);
    else await update({ eventId: draft.event._id, ...doc });
    onClose();
  }

  return (
    <Modal onClose={onClose} width="400px" top="16vh" showClose={false}>
      <div className="p-5">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder="Event title"
          className="w-full bg-transparent text-[20px] font-bold outline-none placeholder:text-ink-3"
        />

        <div className="mt-4 space-y-2.5">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="w-14 text-ink-2">Date</span>
            <Popover
              trigger={(p) => (
                <button {...p} className="rounded-md border border-border px-2 py-1 hover:bg-hov">
                  {fmtCalendarDate(day)}
                </button>
              )}
            >
              {(close) => (
                <DatePicker
                  value={{ start: day }}
                  close={close}
                  onChange={(v) => v && setDay(v.start)}
                />
              )}
            </Popover>
          </div>

          <label className="flex items-center gap-2 text-[13px]">
            <span className="w-14 text-ink-2">All day</span>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="accent-[var(--accent)]"
            />
          </label>

          {!allDay && (
            <div className="flex items-center gap-2 text-[13px]">
              <span className="w-14 text-ink-2">Time</span>
              <TimeSelect value={startMin} onChange={setStartMin} />
              <span className="text-ink-3">→</span>
              <TimeSelect value={endMin} onChange={setEndMin} />
            </div>
          )}

          <div className="flex items-center gap-2 text-[13px]">
            <span className="w-14 shrink-0 text-ink-2">Color</span>
            <span className="flex flex-wrap gap-1">
              {OPTION_COLOR_IDS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={cn(
                    "h-5 w-5 rounded-full border-2",
                    swatchClass(c),
                    color === c ? "border-ink" : "border-transparent"
                  )}
                />
              ))}
            </span>
          </div>

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes…"
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] outline-none focus:border-accent"
          />
        </div>

        <div className="mt-4 flex items-center gap-2">
          {draft.mode === "edit" && (
            <button
              onClick={() => {
                void remove({ eventId: draft.event._id, tzOffsetMin: tzOffsetMin() });
                onClose();
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[13px] text-[var(--pal-red)] hover:bg-[color-mix(in_srgb,var(--pal-red)_10%,transparent)]"
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
          <span className="flex-1" />
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hov">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            className="rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-2"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
