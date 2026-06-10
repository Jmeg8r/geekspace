import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, LayoutTemplate, Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { tzOffsetMin } from "../../lib/utils";
import { fmtCalendarDate, todayCalendarMs } from "../../lib/dates";
import { Modal } from "../common/Modal";
import { Popover } from "../common/Popover";
import { DatePicker } from "../common/DatePicker";

// WHAT: "New from template" — pick a template, name the project, choose a
// start date; tasks land with offset due dates and auto-schedule immediately.
export function TemplatesModal({ onClose }: { onClose: () => void }) {
  const templates = useQuery(api.templates.list) ?? [];
  const instantiate = useMutation(api.templates.instantiate);
  const navigate = useUI((s) => s.navigate);
  const openRow = useUI((s) => s.openRow);
  const [selected, setSelected] = useState<(typeof templates)[number] | null>(null);
  const [title, setTitle] = useState("");
  const [startDay, setStartDay] = useState(todayCalendarMs());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!selected || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await instantiate({
        templateId: selected.templateId as Id<"templates">,
        title: title.trim(),
        startDay,
        tzOffsetMin: tzOffsetMin(),
      });
      onClose();
      if (result.projectsPageId) navigate({ kind: "page", pageId: result.projectsPageId });
      openRow(result.projectRowId);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width="480px" top="14vh">
      <div className="p-5">
        <h2 className="flex items-center gap-2 pb-3 text-[18px] font-bold">
          <LayoutTemplate size={17} className="text-accent" />
          {selected ? (
            <>
              <button onClick={() => setSelected(null)} className="rounded p-0.5 text-ink-3 hover:bg-hov">
                <ArrowLeft size={15} />
              </button>
              {selected.icon} {selected.name}
            </>
          ) : (
            "New from template"
          )}
        </h2>

        {!selected && (
          <div className="grid grid-cols-1 gap-2">
            {templates.map((t) => (
              <button
                key={t.templateId}
                onClick={() => {
                  setSelected(t);
                  setTitle("");
                }}
                className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-accent hover:bg-hov"
              >
                <span className="text-[22px] leading-none">{t.icon ?? "📦"}</span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{t.name}</span>
                  <span className="block pt-0.5 text-[12px] leading-snug text-ink-2">
                    {t.description}
                  </span>
                  <span className="block pt-1 text-[11px] text-ink-3">
                    {t.taskCount} tasks{t.seeded ? " · built-in" : " · yours"}
                  </span>
                </span>
              </button>
            ))}
            {templates.length === 0 && (
              <p className="py-6 text-center text-[13px] text-ink-3">
                No templates yet — open a project and “Save as template”.
              </p>
            )}
          </div>
        )}

        {selected && (
          <div className="space-y-3">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              placeholder="Project name…"
              className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[14px] outline-none focus:border-accent"
            />
            <div className="flex items-center gap-2 text-[13px]">
              <span className="text-ink-2">Start date</span>
              <Popover
                trigger={(p) => (
                  <button {...p} className="rounded-md border border-border px-2 py-1 hover:bg-hov">
                    {fmtCalendarDate(startDay)}
                  </button>
                )}
              >
                {(close) => (
                  <DatePicker
                    value={{ start: startDay }}
                    close={close}
                    onChange={(value) => value && setStartDay(value.start)}
                  />
                )}
              </Popover>
              <span className="text-[11.5px] text-ink-3">due dates offset from here</span>
            </div>
            {error && <p className="text-[12.5px] text-[var(--pal-red)]">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="rounded-md px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hov">
                Cancel
              </button>
              <button
                disabled={!title.trim() || busy}
                onClick={() => void create()}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-2 disabled:opacity-50"
              >
                {busy && <Loader2 size={13} className="animate-spin" />} Create project
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
