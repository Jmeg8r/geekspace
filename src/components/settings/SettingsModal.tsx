import { useMutation, useQuery } from "convex/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { cn, tzOffsetMin } from "../../lib/utils";
import { minOfDayLabel } from "../../lib/dates";
import { useUI } from "../../state/ui";
import { Modal } from "../common/Modal";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// WHAT: Workspace settings — theme + the scheduling knobs that drive the engine.
export function SettingsModal() {
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const settings = useQuery(api.settings.get);
  const update = useMutation(api.settings.update);

  if (!settings) return null;

  function patch(p: Record<string, number | string | number[]>) {
    void update({ ...p, tzOffsetMin: tzOffsetMin() });
  }

  const themes = [
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
    { id: "system", label: "System", icon: Monitor },
  ];

  return (
    <Modal onClose={() => setSettingsOpen(false)} width="480px" top="10vh">
      <div className="overflow-y-auto p-6">
        <h2 className="pb-4 text-[20px] font-extrabold tracking-tight">Settings</h2>

        <Section title="Appearance">
          <div className="flex gap-1.5">
            {themes.map((t) => (
              <button
                key={t.id}
                onClick={() => patch({ theme: t.id })}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 rounded-lg border px-3 py-2.5 text-[12.5px] font-medium",
                  settings.theme === t.id
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border text-ink-2 hover:bg-hov"
                )}
              >
                <t.icon size={16} />
                {t.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Working hours" hint="The auto-scheduler only places task blocks inside these windows.">
          <div className="flex gap-1">
            {DAY_LABELS.map((label, day) => {
              const on = settings.workDays.includes(day);
              return (
                <button
                  key={day}
                  onClick={() =>
                    patch({
                      workDays: on
                        ? settings.workDays.filter((d: number) => d !== day)
                        : [...settings.workDays, day].sort(),
                    })
                  }
                  className={cn(
                    "flex-1 rounded-md border py-1.5 text-[12px] font-semibold",
                    on
                      ? "border-accent bg-accent text-white"
                      : "border-border text-ink-3 hover:bg-hov"
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 pt-2 text-[13px]">
            <MinSelect
              value={settings.dayStartMin}
              max={settings.dayEndMin - 60}
              onChange={(v) => patch({ dayStartMin: v })}
            />
            <span className="text-ink-3">to</span>
            <MinSelect
              value={settings.dayEndMin}
              min={settings.dayStartMin + 60}
              onChange={(v) => patch({ dayEndMin: v })}
            />
          </div>
        </Section>

        <Section title="Auto-scheduling" hint="How the engine slices your tasks into calendar blocks.">
          <NumberRow
            label="Smallest block"
            value={settings.minChunkMin}
            suffix="min"
            onChange={(v) => patch({ minChunkMin: Math.max(15, Math.min(v, settings.maxChunkMin)) })}
          />
          <NumberRow
            label="Largest block"
            value={settings.maxChunkMin}
            suffix="min"
            onChange={(v) => patch({ maxChunkMin: Math.max(settings.minChunkMin, Math.min(v, 480)) })}
          />
          <NumberRow
            label="Buffer between items"
            value={settings.bufferMin}
            suffix="min"
            onChange={(v) => patch({ bufferMin: Math.max(0, Math.min(v, 60)) })}
          />
          <NumberRow
            label="Planning horizon"
            value={settings.horizonDays}
            suffix="days"
            onChange={(v) => patch({ horizonDays: Math.max(3, Math.min(v, 60)) })}
          />
        </Section>

        <p className="pt-2 text-[11.5px] leading-relaxed text-ink-3">
          Geekspace · an As The Geek Learns build · data lives in your local Convex deployment.
        </p>
      </div>
    </Modal>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pb-5">
      <h3 className="pb-0.5 text-[13px] font-bold">{title}</h3>
      {hint && <p className="pb-2 text-[12px] text-ink-3">{hint}</p>}
      {!hint && <div className="pb-2" />}
      {children}
    </div>
  );
}

function MinSelect({
  value,
  onChange,
  min = 0,
  max = 24 * 60,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const options: number[] = [];
  for (let m = 0; m <= 24 * 60; m += 30) {
    if (m >= min && m <= max) options.push(m);
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-md border border-border bg-surface px-2 py-1 text-[13px] outline-none"
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {minOfDayLabel(m)}
        </option>
      ))}
    </select>
  );
}

function NumberRow({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between py-1 text-[13px]">
      <span className="text-ink-2">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-right text-[13px] outline-none focus:border-accent"
        />
        <span className="w-8 text-[12px] text-ink-3">{suffix}</span>
      </span>
    </label>
  );
}
