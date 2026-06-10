import { useEffect, useMemo, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { PartialBlock } from "@blocknote/core";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { uploadFile } from "../../lib/uploadFile";
import { debounce } from "../../lib/utils";
import { useIsDark } from "../../state/theme";

// WHAT: BlockNote editor wrapper. ALWAYS mount with key={documentId} — initial
// content is parsed once and the editor owns the document while mounted.
export function Editor({
  initialJson,
  onSave,
  autoFocus,
}: {
  initialJson?: string;
  onSave: (json: string) => void;
  autoFocus?: boolean;
}) {
  const isDark = useIsDark();

  const initialContent = useMemo<PartialBlock[] | undefined>(() => {
    if (!initialJson) return undefined;
    try {
      const parsed = JSON.parse(initialJson) as PartialBlock[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
    } catch {
      return undefined;
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
  const saverRef = useRef(debounce((json: string) => onSaveRef.current(json), 600));
  useEffect(() => {
    const saver = saverRef.current;
    return () => saver.flush();
  }, []);

  return (
    <BlockNoteView
      editor={editor}
      theme={isDark ? "dark" : "light"}
      autoFocus={autoFocus}
      className="bn-host"
      onChange={() => saverRef.current(JSON.stringify(editor.document))}
    />
  );
}
