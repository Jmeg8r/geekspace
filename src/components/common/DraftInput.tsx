import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { debounce, type Debounced } from "../../lib/utils";

// WHAT: a text input that edits a local draft and saves it on a short pause, on blur and on
// unmount, instead of writing to the server on every keystroke.
// WHY: inputs bound straight to server state dropped characters and jumped the caret when
// a round trip lagged, and each keystroke rewrote a whole property list or view.
// See docs/changes/2026-10-15-database-ui/.

const SAVE_PAUSE_MS = 400;

type DraftInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
};

export function DraftInput({ value, onCommit, onBlur, onFocus, ...rest }: DraftInputProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const commitRef = useRef(onCommit);
  const lastSent = useRef(value);
  const saver = useRef<Debounced<[string]> | null>(null);

  useEffect(() => {
    commitRef.current = onCommit;
  });

  // Take outside changes (another window, the agent) only while the user is not typing.
  useEffect(() => {
    if (focused.current) return;
    lastSent.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const pending = debounce((next: string) => {
      if (next === lastSent.current) return;
      lastSent.current = next;
      commitRef.current(next);
    }, SAVE_PAUSE_MS);
    saver.current = pending;
    return () => {
      pending.flush();
      saver.current = null;
    };
  }, []);

  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        saver.current?.(e.target.value);
      }}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        saver.current?.flush();
        onBlur?.(e);
      }}
    />
  );
}
