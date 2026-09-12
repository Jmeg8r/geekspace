import { draftKey, retainDraft, acknowledgeDraft } from "../../lib/editorDraft";
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { PartialBlock } from "@blocknote/core";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { uploadFile } from "../../lib/uploadFile";
import { createSaveQueue } from "../../lib/saveQueue";
import { debounce } from "../../lib/utils";
import { useIsDark } from "../../state/theme";

// WHAT: BlockNote editor wrapper. ALWAYS mount with key={documentId} — initial
// content is parsed once and the editor owns the document while mounted.
function EditableDocument({
  initialJson,
  documentId,
  onSave,
  autoFocus,
}: {
  initialJson?: string;
  documentId: string;
  onSave: (json: string) => Promise<void>;
  autoFocus?: boolean;
}) {
  const isDark = useIsDark();

  const initialContent = useMemo<PartialBlock[] | undefined>(() => {
    if (!initialJson) return undefined;
    try {
      const parsed = JSON.parse(initialJson) as PartialBlock[];
      if (!Array.isArray(parsed))
        throw new Error("Document must contain a block array");
      return parsed.length > 0 ? parsed : undefined;
    } catch {
      throw new Error("Stored document JSON could not be read");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = useCreateBlockNote({
    initialContent,
    uploadFile,
  });

  // WHY: refs keep the debounced saver stable while always calling fresh onSave;
  // flush on unmount so quick navigation never drops keystrokes.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [queue] = useState(() =>
    createSaveQueue(async (json) => {
      await onSaveRef.current(json);
      acknowledgeDraft(localStorage, documentId, json);
    }, setSaveError),
  );
  const saverRef = useRef(debounce((json: string) => queue.enqueue(json), 600));
  useEffect(() => {
    const saver = saverRef.current;
    const warn = (event: BeforeUnloadEvent) => {
      saver.flush();
      if (queue.hasUnsaved()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      saver.flush();
    };
  }, [queue]);

  return (
    <>
      {saveError && (
        <div role="alert" className="p-2 text-[var(--pal-red)]">
          Save failed. Keep this page open.{" "}
          <button onClick={() => void queue.flush()}>Retry save</button>
          <div>{saveError}</div>
        </div>
      )}
      <BlockNoteView
        editor={editor}
        theme={isDark ? "dark" : "light"}
        autoFocus={autoFocus}
        className="bn-host"
        onChange={() => {
          const json = JSON.stringify(editor.document);
          try {
            retainDraft(localStorage, documentId, json);
          } catch (error) {
            setSaveError(`Could not retain a recovery draft: ${String(error)}`);
          }
          saverRef.current(json);
        }}
      />
    </>
  );
}

class DocumentBoundary extends Component<
  { original?: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("Could not open stored document", error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="p-4">
        <p>
          This document could not be opened. Its stored content has been
          preserved.
        </p>
        <textarea
          aria-label="Original document content"
          readOnly
          value={this.props.original ?? ""}
          className="mt-3 h-48 w-full font-mono text-xs"
        />
      </div>
    );
  }
}
export function Editor(props: {
  documentId: string;
  initialJson?: string;
  onSave: (json: string) => Promise<void>;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(draftKey(props.documentId));
    } catch (error) {
      console.warn("Could not read editor recovery draft", error);
      return null;
    }
  });
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<string | undefined>();
  if (draft !== null && draft !== props.initialJson)
    return (
      <div className="p-4">
        <p role="alert">
          Unsaved edits were found for this document. Review them before
          choosing which version to keep.
        </p>
        <textarea
          aria-label="Unsaved document content"
          value={draft}
          readOnly
          className="my-3 h-48 w-full font-mono text-xs"
        />
        <button
          onClick={async () => {
            try {
              await props.onSave(draft);
              acknowledgeDraft(localStorage, props.documentId, draft);
              setRecovered(draft);
              setDraft(null);
            } catch (error) {
              setRecoveryError(String(error));
            }
          }}
        >
          Recover unsaved edits
        </button>
        <button
          className="ml-4"
          onClick={() => {
            try {
              localStorage.removeItem(draftKey(props.documentId));
              setDraft(null);
            } catch (error) {
              setRecoveryError(String(error));
            }
          }}
        >
          Keep saved version
        </button>
        {recoveryError && <p role="alert">{recoveryError}</p>}
      </div>
    );
  return (
    <DocumentBoundary original={recovered ?? props.initialJson}>
      <EditableDocument
        {...props}
        initialJson={recovered ?? props.initialJson}
      />
    </DocumentBoundary>
  );
}
