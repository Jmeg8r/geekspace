import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { CalendarDays, Mail, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { cn, tzOffsetMin } from "../../lib/utils";
import { minOfDayLabel } from "../../lib/dates";
import { integrationsAvailable, macListCalendars } from "../../lib/integrations";
import { syncMacCalendar } from "../../lib/macSync";
import {
  meetingEnsureModel,
  meetingOllama,
  meetingsAvailable,
  meetingTools,
  type MeetingToolStatus,
} from "../../lib/meetingsBridge";
import { useUI } from "../../state/ui";
import { Modal } from "../common/Modal";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// WHAT: Workspace settings — theme + the scheduling knobs that drive the engine.
export function SettingsModal() {
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const settings = useQuery(api.settings.get);
  const update = useMutation(api.settings.update);

  if (!settings) return null;

  function patch(p: Record<string, number | string | number[] | string[] | boolean>) {
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

        {integrationsAvailable() && (
          <IntegrationsSection
            macCalendarSync={settings.macCalendarSync ?? false}
            macCalendarNames={settings.macCalendarNames ?? []}
            mailWidget={settings.mailWidget ?? false}
            patch={patch}
          />
        )}

        {meetingsAvailable() && (
          <MeetingAiSection
            ollamaUrl={settings.ollamaUrl ?? ""}
            ollamaModel={settings.ollamaModel ?? ""}
            patch={patch}
          />
        )}

        <p className="pt-2 text-[11.5px] leading-relaxed text-ink-3">
          Geekspace · an As The Geek Learns build · data lives in your local Convex deployment.
        </p>
      </div>
    </Modal>
  );
}

function IntegrationsSection({
  macCalendarSync,
  macCalendarNames,
  mailWidget,
  patch,
}: {
  macCalendarSync: boolean;
  macCalendarNames: string[];
  mailWidget: boolean;
  patch: (p: Record<string, boolean | string[]>) => void;
}) {
  const [calendars, setCalendars] = useState<string[] | null>(null);
  const [calError, setCalError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const macSyncStatus = useUI((s) => s.macSyncStatus);
  const setMacSyncStatus = useUI((s) => s.setMacSyncStatus);

  useEffect(() => {
    if (!macCalendarSync || calendars !== null) return;
    void macListCalendars().then((r) => {
      if (r.ok) setCalendars(r.data);
      else setCalError(r.error);
    });
  }, [macCalendarSync, calendars]);

  return (
    <Section
      title="macOS integrations"
      hint="Synced appointments become fixed busy time the auto-scheduler plans around. The first sync asks for Automation permission."
    >
      <label className="flex items-center justify-between py-1 text-[13px]">
        <span className="flex items-center gap-1.5">
          <CalendarDays size={14} className="text-ink-2" /> Sync macOS Calendar
        </span>
        <input
          type="checkbox"
          checked={macCalendarSync}
          onChange={(e) => patch({ macCalendarSync: e.target.checked })}
          className="accent-[var(--accent)]"
        />
      </label>

      {macCalendarSync && (
        <div className="ml-5 space-y-1 py-1">
          {calError && <p className="text-[12px] text-[var(--pal-red)]">{calError}</p>}
          {calendars === null && !calError && (
            <p className="text-[12px] text-ink-3">Loading calendars…</p>
          )}
          {calendars?.map((name) => {
            const checked =
              macCalendarNames.length === 0 || macCalendarNames.includes(name);
            return (
              <label key={name} className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const base =
                      macCalendarNames.length === 0 ? calendars : macCalendarNames;
                    const next = e.target.checked
                      ? [...base.filter((n) => n !== name), name]
                      : base.filter((n) => n !== name);
                    patch({ macCalendarNames: next });
                  }}
                  className="accent-[var(--accent)]"
                />
                <span className="truncate">{name}</span>
              </label>
            );
          })}
          <div className="flex items-center gap-2 pt-1">
            <button
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                try {
                  const res = await syncMacCalendar(macCalendarNames);
                  setMacSyncStatus({ at: Date.now(), ok: res.ok, message: res.message });
                } finally {
                  setSyncing(false);
                }
              }}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-ink-2 hover:bg-hov hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={12} className={cn(syncing && "animate-spin")} /> Sync now
            </button>
            {macSyncStatus && (
              <span
                className={cn(
                  "text-[11.5px]",
                  macSyncStatus.ok ? "text-ink-3" : "text-[var(--pal-red)]"
                )}
              >
                {macSyncStatus.ok ? "✓" : "✕"} {macSyncStatus.message} ·{" "}
                {format(macSyncStatus.at, "h:mm a")}
              </span>
            )}
          </div>
        </div>
      )}

      <label className="flex items-center justify-between py-1 text-[13px]">
        <span className="flex items-center gap-1.5">
          <Mail size={14} className="text-ink-2" /> Mail inbox on Home
        </span>
        <input
          type="checkbox"
          checked={mailWidget}
          onChange={(e) => patch({ mailWidget: e.target.checked })}
          className="accent-[var(--accent)]"
        />
      </label>
    </Section>
  );
}

function MeetingAiSection({
  ollamaUrl,
  ollamaModel,
  patch,
}: {
  ollamaUrl: string;
  ollamaModel: string;
  patch: (p: Record<string, string>) => void;
}) {
  const [tools, setTools] = useState<MeetingToolStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState(ollamaUrl);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    void meetingTools().then((r) => r.ok && setTools(r.data));
    void meetingOllama(ollamaUrl || undefined).then((r) => {
      if (r.ok && r.data.ok) {
        setModels(r.data.models);
        setOllamaError(null);
      } else {
        setOllamaError(r.ok ? (r.data.error ?? "Ollama not reachable") : r.error);
      }
    });
  }, [ollamaUrl]);

  const Status = ({ ok, label }: { ok: boolean; label: string }) => (
    <span className="flex items-center gap-1.5 text-[12.5px]">
      <span className={cn("font-bold", ok ? "text-[var(--pal-green)]" : "text-[var(--pal-red)]")}>
        {ok ? "✓" : "✕"}
      </span>
      {label}
    </span>
  );

  return (
    <Section
      title="AI meeting notes"
      hint="Recording is transcribed by whisper.cpp and summarized by your local Ollama — fully offline."
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 pb-2">
        <Status ok={tools?.ffmpeg ?? false} label="ffmpeg" />
        <Status ok={tools?.whisper ?? false} label="whisper.cpp" />
        <span className="flex items-center gap-1.5">
          <Status ok={tools?.model ?? false} label="speech model" />
          {tools && !tools.model && (
            <button
              disabled={downloading}
              onClick={async () => {
                setDownloading(true);
                try {
                  await meetingEnsureModel();
                  const r = await meetingTools();
                  if (r.ok) setTools(r.data);
                } finally {
                  setDownloading(false);
                }
              }}
              className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-hov disabled:opacity-50"
            >
              {downloading ? "Downloading…" : "Download (142 MB)"}
            </button>
          )}
        </span>
        <Status ok={!ollamaError} label="Ollama" />
      </div>
      {ollamaError && <p className="pb-2 text-[12px] text-[var(--pal-red)]">{ollamaError}</p>}

      <label className="flex items-center justify-between py-1 text-[13px]">
        <span className="text-ink-2">Summarizer model</span>
        <select
          value={ollamaModel}
          onChange={(e) => patch({ ollamaModel: e.target.value })}
          className="max-w-56 rounded-md border border-border bg-surface px-1.5 py-1 text-[12.5px] outline-none"
        >
          <option value="">Auto (prefer gemma)</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between py-1 text-[13px]">
        <span className="text-ink-2">Ollama URL</span>
        <input
          value={urlDraft}
          placeholder="http://127.0.0.1:11434"
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={() => {
            if (urlDraft !== ollamaUrl) patch({ ollamaUrl: urlDraft.trim() });
          }}
          className="w-56 rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] outline-none focus:border-accent"
        />
      </label>
    </Section>
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
