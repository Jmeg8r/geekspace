import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { statusCopy } from "../../../electron/dayRecorderCopy.mjs";
import { setRecorderEnabled } from "../../lib/dayRecorderBridge";
import {
  ONBOARDING,
  UNSUPPORTED,
  addBundleId,
  recorderSupported,
  shotSecError,
} from "../../lib/dayRecorderSettings";
import { isMacLike } from "../../lib/utils";
import { RecorderDot } from "./RecorderIndicator";
import { useRecorderStatus } from "./useRecorderStatus";

// WHAT: the Day Recorder's Settings section (plan PR 3e-2): the switch, the current state
// (which includes the FileVault and Time Machine gates' own copy), the denylist editor and the
// screenshot interval. Turning it on first shows what macOS is about to ask.
// WHY on/off goes through the bridge: it is the renderer's control path (3d-1), which also
// clears a saved pause; the denylist and interval are plain settings, saved directly.

const FIELD = "rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] outline-none focus:border-accent";
const BUTTON =
  "rounded-md border border-border px-2 py-1 text-[12px] text-ink hover:bg-hov focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

export function DayRecorderSettings({ section: Section }: { section: SectionComponent }) {
  const settings = useQuery(api.dayRecorder.getSettings);
  const update = useMutation(api.dayRecorder.updateSettings);
  const { status, error: statusError } = useRecorderStatus();
  const [onboarding, setOnboarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One atomic server change per edit, so no stale copy of the list can undo another edit.
  const addToDenylist = useMutation(api.dayRecorder.addToDenylist);
  const removeFromDenylist = useMutation(api.dayRecorder.removeFromDenylist);

  if (!settings) return null;
  if (!recorderSupported(isMacLike() ? "darwin" : "other", status)) {
    return (
      <Section title="Day Recorder">
        <p className="py-1 text-[12.5px] text-ink">{UNSUPPORTED}</p>
      </Section>
    );
  }
  const copy = status ? statusCopy(status, { shortcut: true }) : null;

  async function enable(on: boolean) {
    setOnboarding(false);
    const r = await setRecorderEnabled(on);
    setError(r.ok ? null : r.error);
  }

  const showError = (err: Error | string) => setError(err instanceof Error ? err.message : err);

  function editDenylist(edit: Promise<null>) {
    edit.then(() => setError(null), showError);
  }

  function saveShotSec(shotSec: number) {
    update({ shotSec }).then(() => setError(null), showError);
  }

  return (
    <Section title="Day Recorder">
      <p className="pb-2 text-[12px] text-ink">
        Records your screen, system audio and mic on this Mac, and keeps it here. Media is deleted after 30 days.
      </p>
      <div className="flex items-center justify-between py-1 text-[13px]">
        <span id="day-recorder-switch-label" className="text-ink">
          Record my day
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          aria-labelledby="day-recorder-switch-label"
          onClick={() => (settings.enabled ? void enable(false) : setOnboarding(true))}
          className={`relative h-5 w-9 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
            settings.enabled ? "border-accent bg-accent" : "border-ink-2 bg-transparent"
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-px h-4 w-4 rounded-full transition-all ${settings.enabled ? "left-[17px] bg-white" : "left-px bg-ink-2"}`}
          />
        </button>
      </div>

      {onboarding && <Onboarding onTurnOn={() => void enable(true)} onCancel={() => setOnboarding(false)} />}

      {settings.enabled && (
        <div role="status" aria-live="polite" className="flex items-start gap-2 py-1 text-[12.5px]">
          {copy && <RecorderDot tone={copy.tone} />}
          <span className="-mt-0.5">
            {copy ? (
              <>
                <span className="font-semibold">{copy.title}.</span> <span className="text-ink">{copy.tooltip}</span>
              </>
            ) : (
              <span className="text-ink">{statusError ?? "Checking…"}</span>
            )}
          </span>
        </div>
      )}

      {error && (
        <p role="alert" className="py-1 text-[12px] text-[color:var(--recorder-error)]">
          {error}
        </p>
      )}

      <Denylist
        list={settings.denylist}
        onAdd={(id) => editDenylist(addToDenylist({ id }))}
        onRemove={(id) => editDenylist(removeFromDenylist({ id }))}
      />
      <ShotInterval value={settings.shotSec} onSave={saveShotSec} />
    </Section>
  );
}

type SectionComponent = (props: { title: string; hint?: string; children: React.ReactNode }) => React.ReactNode;

/** What macOS is about to ask. Not modal: focus moves to it and Tab can still leave (2.4.3). */
function Onboarding({ onTurnOn, onCancel }: { onTurnOn: () => void; onCancel: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => heading.current?.focus(), []);
  return (
    <div role="region" aria-labelledby={titleId} className="my-2 rounded-md border border-border bg-raised p-3 text-[12.5px]">
      <h4 id={titleId} ref={heading} tabIndex={-1} className="pb-1 font-bold outline-none">
        {ONBOARDING.title}
      </h4>
      <p className="pb-1.5 text-ink">{ONBOARDING.intro}</p>
      <ul className="list-disc space-y-1 pb-2 pl-4 text-ink">
        {ONBOARDING.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button type="button" onClick={onTurnOn} className={`${BUTTON} border-accent text-ink`}>
          Turn on
        </button>
        <button type="button" onClick={onCancel} className={BUTTON}>
          Not now
        </button>
      </div>
    </div>
  );
}

function Denylist({ list, onAdd, onRemove }: { list: string[]; onAdd: (id: string) => void; onRemove: (id: string) => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  function add() {
    const r = addBundleId(list, draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setDraft("");
    onAdd(draft.trim());
  }

  return (
    <div className="py-1 text-[13px]">
      <label htmlFor={inputId} className="block pb-1 text-ink">
        Never record these apps
      </label>
      {list.length > 0 && (
        <ul className="pb-1.5">
          {list.map((id) => (
            <li key={id} className="flex items-center justify-between py-0.5 text-[12.5px]">
              <code>{id}</code>
              <button type="button" onClick={() => onRemove(id)} aria-label={`Remove ${id} from the list`} className={BUTTON}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={inputId}
          value={draft}
          placeholder="com.apple.TextEdit"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button type="button" onClick={add} className={BUTTON}>
          Add
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="pt-1 text-[12px] text-[color:var(--recorder-error)]">
          {error}
        </p>
      )}
    </div>
  );
}

function ShotInterval({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const v = Number(draft);
    const why = shotSecError(v);
    setError(why);
    if (!why && v !== value) onSave(v);
  }

  return (
    <div className="py-1 text-[13px]">
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="text-ink">
          Screenshot every
        </label>
        <span className="flex items-center gap-1.5">
          <input
            id={inputId}
            type="number"
            value={draft}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            className={`${FIELD} w-20 text-right`}
          />
          <span className="w-8 text-[12px] text-ink">sec</span>
        </span>
      </div>
      {error && (
        <p id={errorId} role="alert" className="pt-1 text-[12px] text-[color:var(--recorder-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
