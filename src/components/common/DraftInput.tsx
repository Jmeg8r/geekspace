import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { debounce, type Debounced } from "../../lib/utils";

// WHAT: a text input that edits a local draft and saves it on a short pause, on blur and on
// unmount, instead of writing to the server on every keystroke.
// WHY: inputs bound straight to server state dropped characters and jumped the caret when
// a round trip lagged, and each keystroke rewrote a whole property list or view.
// Rules: the draft is the user's while they type in it. An outside change is shown when the
// input is not focused, or on blur if nothing was typed during that focus. Whatever was typed
// is saved after a pause, even if it matches the server: a repeated save is harmless, and
// skipping one could leave an earlier in-flight save as the last word.
// See docs/changes/2026-10-15-database-ui/.

const SAVE_PAUSE_MS = 400;

type DraftInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
  /** Every local change, before it is saved (for siblings that save the same record). */
  onDraftChange?: (value: string) => void;
};

export function DraftInput({ value, onCommit, onDraftChange, onBlur, onFocus, ...rest }: DraftInputProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // The newest server value, including changes that arrived while focused.
  const server = useRef(value);
  // Whether anything was typed during the current focus.
  const typedThisFocus = useRef(false);
  const commitRef = useRef(onCommit);
  const saver = useRef<Debounced<[string]> | null>(null);

  useEffect(() => {
    commitRef.current = onCommit;
  });

  useEffect(() => {
    server.current = value;
    if (!focused.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    const pending = debounce((next: string) => commitRef.current(next), SAVE_PAUSE_MS);
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
        typedThisFocus.current = true;
        setDraft(e.target.value);
        onDraftChange?.(e.target.value);
        saver.current?.(e.target.value);
      }}
      onFocus={(e) => {
        focused.current = true;
        typedThisFocus.current = false;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        saver.current?.flush();
        // Typed something: the draft stands (its save may still be in flight), and the
        // server copy catches up through the effect above. Typed nothing: show the server.
        if (!typedThisFocus.current) setDraft(server.current);
        onBlur?.(e);
      }}
    />
  );
}
