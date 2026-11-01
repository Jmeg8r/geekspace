import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { clearApiKey, hasApiKey, saveApiKey } from "../../lib/assistantBridge";
import { format } from "date-fns";

// WHAT: the Day Recorder assistant's Settings (plan PR 6a, spec R8, F4, F6): the API key
// (write-only), the daily cap, and how often it reads. It runs only with a key and a cap.
// WHY the note about what is sent: transcript and screen text leave the Mac for Anthropic's
// API (F6); images go only when asked for. Saying so is part of the switch.

const FIELD = "rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] outline-none focus:border-accent";
const BUTTON =
  "rounded-md border border-border px-2 py-1 text-[12px] text-ink hover:bg-hov focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

type SectionComponent = (props: { title: string; hint?: string; children: React.ReactNode }) => React.ReactNode;

export function AssistantSettings({ section: Section }: { section: SectionComponent }) {
  const settings = useQuery(api.dayRecorder.getSettings);
  const update = useMutation(api.dayRecorder.updateSettings);
  // The local day, the same key the main process records usage under.
  const cap = useQuery(api.assistant.capStatus, { day: format(new Date(), "yyyy-MM-dd") });
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyId = useId();

  useEffect(() => {
    void hasApiKey().then((r) => (r.ok ? setKeySaved(r.data) : setError(r.error)));
  }, []);

  if (!settings) return null;

  async function saveKey() {
    const r = await saveApiKey(draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setDraft("");
    setError(null);
    setKeySaved(true);
  }

  async function removeKey() {
    const r = await clearApiKey();
    if (r.ok) setKeySaved(false);
    else setError(r.error);
  }

  function saveNumber(patch: { dailyCapUsd?: number; batchMin?: number }) {
    update(patch).then(
      () => setError(null),
      (err: Error | string) => setError(err instanceof Error ? err.message : err)
    );
  }

  return (
    <Section title="Assistant">
      <p className="pb-2 text-[12px] text-ink">
        Reads your day's transcripts and screen text with Claude to add tasks and block time. That text is sent to
        Anthropic's API; images only when you ask. It runs only with a key and a daily cap.
      </p>

      <div className="py-1 text-[13px]">
        <label htmlFor={keyId} className="block pb-1 text-ink">
          Anthropic API key{" "}
          <span className="text-ink">{keySaved === null ? "" : keySaved ? "(saved)" : "(none yet)"}</span>
        </label>
        <div className="flex gap-2">
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            value={draft}
            placeholder={keySaved ? "Replace the saved key" : "sk-ant-…"}
            onChange={(e) => setDraft(e.target.value)}
            className={`${FIELD} min-w-0 flex-1`}
          />
          <button type="button" disabled={!draft.trim()} onClick={() => void saveKey()} className={BUTTON}>
            Save
          </button>
          {keySaved && (
            <button type="button" onClick={() => void removeKey()} className={BUTTON}>
              Remove
            </button>
          )}
        </div>
      </div>

      <NumberField
        label="Daily cap"
        unit="$"
        value={settings.dailyCapUsd ?? undefined}
        placeholder="not set"
        onSave={(v) => saveNumber({ dailyCapUsd: v })}
      />
      <NumberField label="Read every" unit="min" value={settings.batchMin} onSave={(v) => saveNumber({ batchMin: v })} />

      {cap && cap.capUsd !== null && (
        <p role="status" className="py-1 text-[12.5px] text-ink">
          Spent today: ${cap.spentUsd.toFixed(2)} of ${cap.capUsd.toFixed(2)}
          {cap.reached ? ". Paused until tomorrow." : "."}
        </p>
      )}

      {error && (
        <p role="alert" className="py-1 text-[12px] text-[color:var(--recorder-error)]">
          {error}
        </p>
      )}
    </Section>
  );
}

function NumberField({
  label,
  unit,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  unit: string;
  value: number | undefined;
  placeholder?: string;
  onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const id = useId();
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  return (
    <div className="flex items-center justify-between py-1 text-[13px]">
      <label htmlFor={id} className="text-ink">
        {label}
      </label>
      <span className="flex items-center gap-1.5">
        <input
          id={id}
          type="number"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = Number(draft);
            if (draft.trim() !== "" && v !== value) onSave(v);
          }}
          className={`${FIELD} w-20 text-right`}
        />
        <span className="w-8 text-[12px] text-ink">{unit}</span>
      </span>
    </div>
  );
}
