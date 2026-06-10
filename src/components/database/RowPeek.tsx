import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PropertyDef } from "../../../convex/lib/types";
import type { RowDoc } from "../../lib/viewLogic";
import { useUI } from "../../state/ui";
import { debounce, tzOffsetMin } from "../../lib/utils";
import { Modal } from "../common/Modal";
import { PROP_ICONS } from "../common/bits";
import { PropertyValueCell } from "./cells";
import { Editor } from "../page/Editor";

// WHAT: Notion-style "open row as page" — properties panel + full block editor.
export function RowPeek() {
  const openRowId = useUI((s) => s.openRowId);
  const openRow = useUI((s) => s.openRow);
  if (!openRowId) return null;
  return <RowPeekInner rowId={openRowId as Id<"rows">} onClose={() => openRow(null)} />;
}

function RowPeekInner({ rowId, onClose }: { rowId: Id<"rows">; onClose: () => void }) {
  const data = useQuery(api.rows.get, { rowId });
  const setContent = useMutation(api.rows.setContent);
  const removeRow = useMutation(api.rows.remove);

  if (data === undefined) {
    return (
      <Modal onClose={onClose}>
        <div className="p-10 text-center text-ink-3">Loading…</div>
      </Modal>
    );
  }
  if (data === null) {
    onClose();
    return null;
  }

  const { row, database, relationTitles } = data;
  const props = database.properties as PropertyDef[];

  return (
    <Modal onClose={onClose} width="min(760px, 94vw)" top="7vh">
      <div className="overflow-y-auto px-10 pb-16 pt-9">
        <div className="flex items-start justify-between gap-3">
          <TitleInput row={row as RowDoc} />
          <button
            title="Delete row"
            onClick={() => {
              if (confirm(`Delete "${row.title || "Untitled"}"?`)) {
                onClose();
                void removeRow({ rowId, tzOffsetMin: tzOffsetMin() });
              }
            }}
            className="mt-1.5 rounded-md p-1.5 text-ink-3 hover:bg-hov hover:text-[var(--pal-red)]"
          >
            <Trash2 size={15} />
          </button>
        </div>

        <div className="mt-3 space-y-0.5 border-b border-border pb-3">
          {props
            .filter((p) => p.type !== "title")
            .map((def) => {
              const Icon = PROP_ICONS[def.type];
              return (
                <div key={def.id} className="flex items-start">
                  <div className="flex w-40 shrink-0 items-center gap-1.5 px-2 py-2 text-[13px] text-ink-2">
                    <Icon size={14} className="text-ink-3" />
                    <span className="truncate">{def.name}</span>
                  </div>
                  <div className="min-w-0 flex-1 rounded-md hover:bg-[color-mix(in_srgb,var(--hover)_50%,transparent)]">
                    <PropertyValueCell
                      def={def}
                      row={row as RowDoc}
                      relationTitles={relationTitles}
                      variant="peek"
                    />
                  </div>
                </div>
              );
            })}
        </div>

        <div className="pt-4">
          <Editor
            key={row._id}
            initialJson={row.content}
            onSave={(json) => void setContent({ rowId, content: json })}
          />
        </div>
      </div>
    </Modal>
  );
}

function TitleInput({ row }: { row: RowDoc }) {
  const update = useMutation(api.rows.updateProperty);
  const [title, setTitle] = useState(row.title);
  const rowRef = useRef(row._id);
  useEffect(() => {
    if (rowRef.current !== row._id) {
      rowRef.current = row._id;
      setTitle(row.title);
    }
  }, [row._id, row.title]);

  const saver = useRef(
    debounce((rowId: Id<"rows">, value: string) => {
      void update({ rowId, propId: "title", value, tzOffsetMin: tzOffsetMin() });
    }, 350)
  );
  useEffect(() => {
    const s = saver.current;
    return () => s.flush();
  }, []);

  return (
    <input
      value={title}
      autoFocus={!row.title}
      placeholder="Untitled"
      onChange={(e) => {
        setTitle(e.target.value);
        saver.current(row._id, e.target.value);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="w-full bg-transparent text-[26px] font-extrabold tracking-tight outline-none placeholder:text-ink-3"
    />
  );
}
