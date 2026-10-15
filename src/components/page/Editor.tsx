import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { PartialBlock } from "@blocknote/core";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { uploadFile } from "../../lib/uploadFile";
import { debounce } from "../../lib/utils";
import { createSaveQueue } from "../../lib/saveQueue";
import { acknowledgeDraft, discardDraft, readDraft, retainDraft } from "../../lib/editorDraft";
import { decideIncoming } from "../../lib/incomingContent";
import { useIsDark } from "../../state/theme";

// WHAT: BlockNote editor wrapper. Mount with key={documentId}. Saves go through a
// serialising queue; every edit is also kept as a local recovery draft until that exact
// value is saved; a change to the document made elsewhere is shown, or asked about when
// it meets unsaved edits; stored content that cannot be read opens read-only.
// See docs/changes/2026-10-15-editor-saves/.

const SAVE_DEBOUNCE_MS = 600;
// A save still outstanding after this long is shown as waiting: while the backend is
// unreachable the Convex client queues the mutation instead of rejecting it.
const SLOW_SAVE_MS = 3000;
const EMPTY_DOCUMENT: PartialBlock[] = [{ type: "paragraph" }];

type Parsed = { ok: true; blocks: PartialBlock[] | undefined } | { ok: false };

function parseDocument(json: string | undefined): Parsed {
  if (!json) return { ok: true, blocks: undefined };
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return { ok: false };
    // SAFETY: only the top-level array shape is checked here; BlockNote validates each
    // block when it loads them, and this is the format the editor itself saved.
    return { ok: true, blocks: parsed.length > 0 ? (parsed as PartialBlock[]) : undefined };
  } catch {
    return { ok: false };
  }
}

function localDrafts(): Storage | null {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn("Editor recovery drafts are unavailable: browser storage is blocked", error);
    return null;
  }
}

type EditorProps = {
  documentId: string;
  /** The live server copy of the document (BlockNote JSON). */
  content: string | undefined;
  onSave: (json: string) => Promise<null>;
  autoFocus?: boolean;
};

export function Editor(props: EditorProps) {
  const [start] = useState(() => {
    const storage = localDrafts();
    let draft: string | null = null;
    try {
      draft = storage ? readDraft(storage, props.documentId) : null;
    } catch (error) {
      console.warn(`Could not read the recovery draft for ${props.documentId}`, error);
    }
    if (draft !== null && draft !== (props.content ?? "")) {
      const parsedDraft = parseDocument(draft);
      if (parsedDraft.ok) return { readable: true as const, blocks: parsedDraft.blocks, draft };
      console.warn(`Ignoring an unreadable recovery draft for ${props.documentId}`);
    }
    const parsed = parseDocument(props.content);
    if (!parsed.ok) return { readable: false as const };
    return { readable: true as const, blocks: parsed.blocks, draft: null };
  });

  if (!start.readable) return <UnreadableDocument original={props.content ?? ""} />;
  return <EditableDocument {...props} initialBlocks={start.blocks} restoredDraft={start.draft} />;
}

function EditableDocument({
  documentId,
  content,
  onSave,
  autoFocus,
  initialBlocks,
  restoredDraft,
}: EditorProps & { initialBlocks: PartialBlock[] | undefined; restoredDraft: string | null }) {
  const isDark = useIsDark();
  const editor = useCreateBlockNote({ initialContent: initialBlocks, uploadFile });

  // The last server value this editor loaded, saved or chose to override.
  const lastSynced = useRef(content);
  // The value currently being sent, so its echo from the server is recognised.
  const inFlight = useRef<string | undefined>(undefined);
  // The newest local edit, and whether it has not reached the server yet.
  const latestLocal = useRef<string | undefined>(restoredDraft ?? undefined);
  const dirty = useRef(restoredDraft !== null);
  // A document this editor set itself: `applying` covers the onChange BlockNote fires
  // synchronously inside replaceBlocks, `programmatic` any that arrive afterwards with
  // the same serialisation. Neither is a user edit.
  const applying = useRef(false);
  const programmatic = useRef<string | null>(null);
  // While a conflict is open, edits are kept locally but not sent.
  const paused = useRef(false);
  const contentRef = useRef(content);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [bar, setBar] = useState<
    | null
    | { kind: "restored" }
    | { kind: "conflict"; incoming: string | undefined; readable: boolean }
  >(restoredDraft !== null ? { kind: "restored" } : null);

  const onSaveRef = useRef(onSave);
  // Latest props for callbacks that outlive this render (the save queue, notice buttons).
  useLayoutEffect(() => {
    contentRef.current = content;
    onSaveRef.current = onSave;
  });
  // Created on first use from an event or effect, never during render.
  const queueRef = useRef<ReturnType<typeof createSaveQueue> | null>(null);
  const queue = () =>
    (queueRef.current ??= createSaveQueue(async (json) => {
      inFlight.current = json;
      const slow = setTimeout(() => setWaiting(true), SLOW_SAVE_MS);
      try {
        await onSaveRef.current(json);
      } finally {
        clearTimeout(slow);
        setWaiting(false);
        inFlight.current = undefined;
      }
      lastSynced.current = json;
      if (latestLocal.current === json) dirty.current = false;
      const storage = localDrafts();
      try {
        if (storage) acknowledgeDraft(storage, documentId, json);
      } catch (error) {
        console.warn(`Could not clear the recovery draft for ${documentId}`, error);
      }
    }, setSaveError));
  const saver = useRef(debounce((json: string) => queue().enqueue(json), SAVE_DEBOUNCE_MS));

  useEffect(() => {
    const pending = saver.current;
    // Drafts already hold every edit, so leaving only needs to push the last one out; a
    // close prompt here would block quitting the Electron window without a dialog.
    const leave = () => pending.flush();
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      pending.flush();
    };
  }, []);

  function setDocument(blocks: PartialBlock[] | undefined) {
    applying.current = true;
    try {
      editor.replaceBlocks(editor.document, blocks ?? EMPTY_DOCUMENT);
    } finally {
      applying.current = false;
    }
    programmatic.current = JSON.stringify(editor.document);
  }

  function applyServer(value: string | undefined): boolean {
    const parsed = parseDocument(value);
    if (!parsed.ok) return false;
    setDocument(parsed.blocks);
    lastSynced.current = value;
    latestLocal.current = undefined;
    dirty.current = false;
    const storage = localDrafts();
    try {
      if (storage) discardDraft(storage, documentId);
    } catch (error) {
      console.warn(`Could not clear the recovery draft for ${documentId}`, error);
    }
    return true;
  }

  useEffect(() => {
    if (content === inFlight.current) {
      lastSynced.current = content;
      return;
    }
    const action = decideIncoming({
      incoming: content,
      lastSynced: lastSynced.current,
      dirty: dirty.current || paused.current,
    });
    if (action === "ignore") return;
    if (action === "apply" && applyServer(content)) return;
    // Unsaved edits meet a change made elsewhere (or that change cannot be read): stop
    // sending until the user decides, so neither version is overwritten silently.
    paused.current = true;
    saver.current.cancel();
    setBar({ kind: "conflict", incoming: content, readable: parseDocument(content).ok });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the server copy only
  }, [content]);

  function keepMine() {
    paused.current = false;
    lastSynced.current = contentRef.current;
    const json = JSON.stringify(editor.document);
    latestLocal.current = json;
    dirty.current = true;
    queue().enqueue(json);
    setBar(null);
  }

  function loadLatest(incoming: string | undefined) {
    paused.current = false;
    if (!applyServer(incoming)) return;
    // A save of the old text may still be in flight; write the loaded version after it.
    if (queue().hasUnsaved() && incoming !== undefined) queue().enqueue(incoming);
    setBar(null);
  }

  return (
    <>
      {bar?.kind === "restored" && (
        <Notice tone="info">
          Restored edits that were not saved last time.
          <NoticeButton
            onClick={() => {
              saver.current(JSON.stringify(editor.document));
              saver.current.flush();
              setBar(null);
            }}
          >
            Keep them
          </NoticeButton>
          <NoticeButton
            onClick={() => {
              if (applyServer(contentRef.current)) setBar(null);
            }}
          >
            Discard
          </NoticeButton>
        </Notice>
      )}
      {bar?.kind === "conflict" && (
        <Notice tone="warn">
          {bar.readable
            ? "This page was changed somewhere else while you had unsaved edits."
            : "This page was changed somewhere else to content that cannot be opened."}
          {bar.readable && (
            <NoticeButton onClick={() => loadLatest(bar.incoming)}>Load latest</NoticeButton>
          )}
          <NoticeButton onClick={keepMine}>Keep mine</NoticeButton>
        </Notice>
      )}
      {saveError ? (
        <Notice tone="error">
          Not saved: {saveError}. Your edits are kept on this device.
          <NoticeButton onClick={() => void queue().flush()}>Retry</NoticeButton>
        </Notice>
      ) : (
        waiting && <Notice tone="info">Not saved yet. Waiting for the backend to answer…</Notice>
      )}
      <BlockNoteView
        editor={editor}
        theme={isDark ? "dark" : "light"}
        autoFocus={autoFocus}
        className="bn-host"
        onChange={() => {
          if (applying.current) return;
          const json = JSON.stringify(editor.document);
          if (json === programmatic.current) return;
          programmatic.current = null;
          latestLocal.current = json;
          dirty.current = true;
          const storage = localDrafts();
          try {
            if (storage) retainDraft(storage, documentId, json);
          } catch (error) {
            setSaveError(`could not keep a recovery copy (${String(error)})`);
          }
          setBar((current) => (current?.kind === "restored" ? null : current));
          if (!paused.current) saver.current(json);
        }}
      />
    </>
  );
}

function UnreadableDocument({ original }: { original: string }) {
  return (
    <div role="alert" className="mt-4 rounded-lg border border-border p-4 text-[13px]">
      <p className="font-medium">This page's stored content could not be opened.</p>
      <p className="pt-1 text-ink-2">
        It is shown read-only so nothing overwrites it. Copy anything you need from below.
      </p>
      <textarea
        aria-label="Stored page content"
        readOnly
        value={original}
        className="mt-3 h-48 w-full rounded-md bg-hov p-2 font-mono text-[12px]"
      />
    </div>
  );
}

const NOTICE_TONES = {
  info: "border-border text-ink-2",
  warn: "border-[var(--pal-yellow)] text-ink",
  error: "border-[var(--pal-red)] text-[var(--pal-red)]",
} as const;

function Notice({ tone, children }: { tone: keyof typeof NOTICE_TONES; children: ReactNode }) {
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      className={`mb-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[13px] ${NOTICE_TONES[tone]}`}
    >
      {children}
    </div>
  );
}

function NoticeButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-md px-2 py-0.5 font-medium underline hover:bg-hov">
      {children}
    </button>
  );
}
