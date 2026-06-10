import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useMutation } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type {
  DateValue,
  PropertyDef,
  SelectOption,
} from "../../../convex/lib/types";
import type { RowDoc } from "../../lib/viewLogic";
import { fmtDateValue } from "../../lib/dates";
import { cn, tzOffsetMin } from "../../lib/utils";
import { useUI } from "../../state/ui";
import { Chip, ProgressBar } from "../common/bits";
import type { ViewProps } from "./DatabaseContainer";

const NONE = "__none__";

export function BoardView({ db, view, rows, relationTitles }: ViewProps) {
  const props = db.properties as PropertyDef[];
  const groupProp =
    props.find((p) => p.id === view.groupByPropId) ??
    props.find((p) => p.type === "status") ??
    props.find((p) => p.type === "select");
  const updateRow = useMutation(api.rows.updateProperty);
  const createRow = useMutation(api.rows.create);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const columns = useMemo(() => {
    if (!groupProp?.options) return [];
    const opts = [...groupProp.options];
    if (groupProp.type === "status") {
      const order = { todo: 0, inprogress: 1, complete: 2 } as Record<string, number>;
      opts.sort((a, b) => (order[a.group ?? "todo"] ?? 0) - (order[b.group ?? "todo"] ?? 0));
    }
    return [
      { id: NONE, name: `No ${groupProp.name}`, color: "gray" } as SelectOption,
      ...opts,
    ];
  }, [groupProp]);

  if (!groupProp?.options) {
    return (
      <div className="px-8 py-10 text-[13px] text-ink-3">
        Add a <b>status</b> or <b>select</b> property to group this board.
      </div>
    );
  }

  const rowsByColumn = new Map<string, RowDoc[]>(columns.map((c) => [c.id, []]));
  for (const row of rows) {
    const v = row.properties?.[groupProp.id];
    const key = typeof v === "string" && rowsByColumn.has(v) ? v : NONE;
    rowsByColumn.get(key)!.push(row);
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const rowId = e.active.id as string;
    const colId = e.over?.id as string | undefined;
    if (!colId) return;
    void updateRow({
      rowId: rowId as RowDoc["_id"],
      propId: groupProp!.id,
      value: colId === NONE ? undefined : colId,
      tzOffsetMin: tzOffsetMin(),
    });
  }

  const activeRow = activeId ? rows.find((r) => r._id === activeId) : null;

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setActiveId(e.active.id as string)} onDragEnd={onDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto px-8 py-4">
        {columns.map((col) => {
          const colRows = rowsByColumn.get(col.id) ?? [];
          if (col.id === NONE && colRows.length === 0) return null;
          return (
            <BoardColumn key={col.id} option={col} count={colRows.length}>
              {colRows.map((row) => (
                <BoardCard key={row._id} row={row} db={db} groupPropId={groupProp!.id} relationTitles={relationTitles} />
              ))}
              <button
                onClick={() =>
                  void createRow({
                    databaseId: db._id,
                    properties: col.id === NONE ? {} : { [groupProp!.id]: col.id },
                    tzOffsetMin: tzOffsetMin(),
                  })
                }
                className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[13px] text-ink-3 hover:bg-hov hover:text-ink-2"
              >
                <Plus size={13} /> New
              </button>
            </BoardColumn>
          );
        })}
      </div>
      <DragOverlay>
        {activeRow && (
          <div className="w-64 rotate-2 cursor-grabbing">
            <CardBody row={activeRow} db={db} groupPropId={groupProp.id} relationTitles={relationTitles} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  option,
  count,
  children,
}: {
  option: SelectOption;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: option.id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-fit max-h-full w-64 shrink-0 flex-col gap-1.5 rounded-lg p-2",
        isOver ? "bg-accent-soft" : "bg-[color-mix(in_srgb,var(--hover)_60%,transparent)]"
      )}
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <Chip color={option.color} name={option.name} />
        <span className="text-[12px] text-ink-3">{count}</span>
      </div>
      <div className="flex flex-col gap-1.5 overflow-y-auto">{children}</div>
    </div>
  );
}

function BoardCard({
  row,
  db,
  groupPropId,
  relationTitles,
}: {
  row: RowDoc;
  db: ViewProps["db"];
  groupPropId: string;
  relationTitles: Record<string, string>;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row._id });
  const openRow = useUI((s) => s.openRow);
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => !isDragging && openRow(row._id)}
      className={cn("cursor-pointer", isDragging && "opacity-30")}
    >
      <CardBody row={row} db={db} groupPropId={groupPropId} relationTitles={relationTitles} />
    </div>
  );
}

function CardBody({
  row,
  db,
  groupPropId,
  relationTitles,
}: {
  row: RowDoc;
  db: ViewProps["db"];
  groupPropId: string;
  relationTitles: Record<string, string>;
}) {
  const props = (db.properties as PropertyDef[]).filter(
    (p) => p.id !== groupPropId && p.type !== "title"
  );
  const snippets: React.ReactNode[] = [];
  for (const def of props) {
    if (snippets.length >= 3) break;
    const v = row.properties?.[def.id];
    if (def.type === "select" || def.type === "status") {
      const o = def.options?.find((x) => x.id === v);
      if (o) snippets.push(<Chip key={def.id} color={o.color} name={o.name} />);
    } else if (def.type === "multiSelect" && Array.isArray(v) && v.length) {
      snippets.push(
        <span key={def.id} className="flex flex-wrap gap-1">
          {(v as string[]).slice(0, 3).map((id) => {
            const o = def.options?.find((x) => x.id === id);
            return o ? <Chip key={id} color={o.color} name={o.name} /> : null;
          })}
        </span>
      );
    } else if (def.type === "date" && v) {
      snippets.push(
        <span key={def.id} className="text-[12px] text-ink-2">
          {fmtDateValue(v as DateValue)}
        </span>
      );
    } else if (def.type === "rollup" && (def.numberFormat === "progress" || def.rollup?.aggregate === "percentComplete")) {
      const n = row.computed?.[def.id];
      if (typeof n === "number") snippets.push(<ProgressBar key={def.id} value={n} />);
    } else if (def.type === "relation" && Array.isArray(v) && v.length) {
      snippets.push(
        <span key={def.id} className="truncate text-[12px] text-ink-2">
          {(v as string[]).map((id) => relationTitles[id] ?? "Untitled").join(", ")}
        </span>
      );
    }
  }

  return (
    <div
      className="rounded-lg border border-border bg-surface px-2.5 py-2 hover:border-ink-3"
      style={{ boxShadow: "var(--shadow)" }}
    >
      <div className="pb-1 text-[13px] font-medium leading-snug">
        {row.title || <span className="text-ink-3">Untitled</span>}
      </div>
      <div className="flex flex-col gap-1">{snippets}</div>
    </div>
  );
}
