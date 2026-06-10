import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowUpRight, EyeOff, Plus, Trash2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type {
  PropertyDef,
  PropertyType,
  RollupAggregate,
  SelectOption,
  StatusGroup,
} from "../../../convex/lib/types";
import { makeId, OPTION_COLOR_IDS } from "../../../convex/lib/types";
import { useUI } from "../../state/ui";
import { cn, tzOffsetMin } from "../../lib/utils";
import { nextOptionColor, swatchClass } from "../../lib/optionColors";
import { Popover } from "../common/Popover";
import { MenuItem, MenuLabel, MenuList, MenuSeparator } from "../common/Menu";
import { PROP_ICONS, PROP_TYPE_LABELS } from "../common/bits";
import { PropertyValueCell } from "./cells";
import type { ViewProps } from "./DatabaseContainer";

const COL_W = 170;
const TITLE_W = 300;

export function TableView({ db, view, rows, relationTitles }: ViewProps) {
  const props = (db.properties as PropertyDef[]).filter(
    (p) => !(view.hiddenPropIds ?? []).includes(p.id)
  );
  const createRow = useMutation(api.rows.create);
  const removeRow = useMutation(api.rows.remove);
  const openRow = useUI((s) => s.openRow);

  const gridWidth = props.reduce((acc, p) => acc + (p.type === "title" ? TITLE_W : COL_W), 0) + 44;

  return (
    <div className="px-8 pb-24 pt-2">
      <div style={{ minWidth: gridWidth }}>
        {/* Header */}
        <div className="flex border-b border-border">
          {props.map((def) => (
            <PropertyHeader key={def.id} def={def} db={db} viewId={view._id} />
          ))}
          <AddPropertyButton db={db} />
        </div>

        {/* Rows */}
        {rows.map((row) => (
          <div key={row._id} className="group/row flex border-b border-border hover:bg-[color-mix(in_srgb,var(--hover)_50%,transparent)]">
            {props.map((def, i) => (
              <div
                key={def.id}
                className={cn("relative shrink-0 border-r border-border/60", i === props.length - 1 && "border-r-0")}
                style={{ width: def.type === "title" ? TITLE_W : COL_W }}
              >
                <PropertyValueCell def={def} row={row} relationTitles={relationTitles} variant="cell" />
                {def.type === "title" && (
                  <button
                    onClick={() => openRow(row._id)}
                    className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-md border border-border bg-raised px-1.5 py-0.5 text-[11px] font-medium text-ink-2 hover:text-ink group-hover/row:flex"
                    style={{ boxShadow: "var(--shadow)" }}
                  >
                    <ArrowUpRight size={12} /> Open
                  </button>
                )}
              </div>
            ))}
            <button
              title="Delete row"
              onClick={() => {
                if (confirm(`Delete "${row.title || "Untitled"}"?`))
                  void removeRow({ rowId: row._id, tzOffsetMin: tzOffsetMin() });
              }}
              className="hidden w-8 items-center justify-center text-ink-3 hover:text-[var(--pal-red)] group-hover/row:flex"
            >
              <X size={13} />
            </button>
          </div>
        ))}

        {/* New row */}
        <button
          onClick={() => void createRow({ databaseId: db._id, tzOffsetMin: tzOffsetMin() })}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[13px] text-ink-3 hover:bg-hov hover:text-ink-2"
        >
          <Plus size={14} /> New row
        </button>
        <div className="px-2 pt-1.5 text-[12px] text-ink-3">
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </div>
      </div>
    </div>
  );
}

function PropertyHeader({ def, db, viewId }: { def: PropertyDef; db: Doc<"databases">; viewId: Doc<"views">["_id"] }) {
  const Icon = PROP_ICONS[def.type];
  return (
    <Popover
      className="w-72"
      trigger={(p) => (
        <button
          {...p}
          className="flex shrink-0 items-center gap-1.5 px-2 py-1.5 text-left text-[12px] font-medium text-ink-2 hover:bg-hov"
          style={{ width: def.type === "title" ? TITLE_W : COL_W }}
        >
          <Icon size={13} className="shrink-0 text-ink-3" />
          <span className="truncate">{def.name}</span>
        </button>
      )}
    >
      {(close) => <PropertyMenu def={def} db={db} viewId={viewId} close={close} />}
    </Popover>
  );
}

function PropertyMenu({
  def,
  db,
  viewId,
  close,
}: {
  def: PropertyDef;
  db: Doc<"databases">;
  viewId: Doc<"views">["_id"];
  close: () => void;
}) {
  const updateProperty = useMutation(api.databases.updateProperty);
  const removeProperty = useMutation(api.databases.removeProperty);
  const updateView = useMutation(api.views.update);
  const view = useQuery(api.views.list, { databaseId: db._id })?.find((v) => v._id === viewId);
  const [name, setName] = useState(def.name);
  const props = db.properties as PropertyDef[];

  const commitName = () => {
    if (name.trim() && name !== def.name)
      void updateProperty({ databaseId: db._id, propId: def.id, name: name.trim() });
  };

  return (
    <div className="p-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="mb-1.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[13px] outline-none focus:border-accent"
      />
      <div className="px-1 pb-1.5 text-[11px] text-ink-3">{PROP_TYPE_LABELS[def.type]}</div>

      {(def.type === "select" || def.type === "multiSelect" || def.type === "status") && (
        <OptionsEditor def={def} db={db} />
      )}

      {def.type === "number" && (
        <label className="flex items-center justify-between px-1 py-1 text-[13px]">
          <span className="text-ink-2">Format</span>
          <select
            value={def.numberFormat ?? "plain"}
            onChange={(e) =>
              void updateProperty({ databaseId: db._id, propId: def.id, numberFormat: e.target.value })
            }
            className="rounded border border-border bg-surface px-1 py-0.5 text-[12px] outline-none"
          >
            <option value="plain">Plain</option>
            <option value="minutes">Minutes (1h 30m)</option>
            <option value="percent">Percent</option>
            <option value="dollar">Dollar</option>
            <option value="progress">Progress bar</option>
          </select>
        </label>
      )}

      {def.type === "rollup" && <RollupConfig def={def} db={db} />}

      {def.type !== "title" && (
        <>
          <MenuSeparator />
          <MenuList className="p-0">
            <MenuItem
              icon={EyeOff}
              label="Hide in view"
              onClick={() => {
                close();
                const hidden = new Set(view?.hiddenPropIds ?? []);
                hidden.add(def.id);
                void updateView({ viewId, hiddenPropIds: [...hidden] });
              }}
            />
            <MenuItem
              icon={Trash2}
              label="Delete property"
              danger
              onClick={() => {
                if (confirm(`Delete property "${def.name}" and its values?`)) {
                  close();
                  void removeProperty({ databaseId: db._id, propId: def.id });
                }
              }}
            />
          </MenuList>
        </>
      )}
      {def.type === "rollup" && props.filter((p) => p.type === "relation").length === 0 && (
        <p className="px-1 pt-1 text-[11px] text-ink-3">Add a relation property first.</p>
      )}
    </div>
  );
}

function OptionsEditor({ def, db }: { def: PropertyDef; db: Doc<"databases"> }) {
  const updateProperty = useMutation(api.databases.updateProperty);
  const [newName, setNewName] = useState("");
  const options = def.options ?? [];

  function save(next: SelectOption[]) {
    void updateProperty({ databaseId: db._id, propId: def.id, options: next });
  }

  function cycleColor(o: SelectOption) {
    const i = OPTION_COLOR_IDS.indexOf(o.color as (typeof OPTION_COLOR_IDS)[number]);
    const next = OPTION_COLOR_IDS[(i + 1) % OPTION_COLOR_IDS.length];
    save(options.map((x) => (x.id === o.id ? { ...x, color: next } : x)));
  }

  return (
    <div className="space-y-0.5 px-1 pb-1">
      <div className="pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Options</div>
      {options.map((o) => (
        <div key={o.id} className="flex items-center gap-1.5">
          <button
            title="Click to change color"
            onClick={() => cycleColor(o)}
            className={cn("h-3.5 w-3.5 shrink-0 rounded-full", swatchClass(o.color))}
          />
          <input
            value={o.name}
            onChange={(e) =>
              save(options.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))
            }
            className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-[13px] outline-none hover:bg-hov focus:bg-hov"
          />
          {def.type === "status" && (
            <select
              value={o.group ?? "todo"}
              onChange={(e) =>
                save(options.map((x) => (x.id === o.id ? { ...x, group: e.target.value as StatusGroup } : x)))
              }
              className="rounded border border-border bg-surface px-0.5 py-0.5 text-[11px] outline-none"
            >
              <option value="todo">To-do</option>
              <option value="inprogress">In progress</option>
              <option value="complete">Complete</option>
            </select>
          )}
          <button
            onClick={() => save(options.filter((x) => x.id !== o.id))}
            className="rounded p-0.5 text-ink-3 hover:bg-hov hover:text-ink"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1 pt-0.5">
        <Plus size={13} className="text-ink-3" />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim()) {
              save([
                ...options,
                {
                  id: makeId(),
                  name: newName.trim(),
                  color: nextOptionColor(options.map((o) => o.color)),
                  ...(def.type === "status" ? { group: "todo" as StatusGroup } : {}),
                },
              ]);
              setNewName("");
            }
          }}
          placeholder="Add option…"
          className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-[13px] outline-none placeholder:text-ink-3"
        />
      </div>
    </div>
  );
}

function RollupConfig({ def, db }: { def: PropertyDef; db: Doc<"databases"> }) {
  const updateProperty = useMutation(api.databases.updateProperty);
  const props = db.properties as PropertyDef[];
  const relationProps = props.filter((p) => p.type === "relation");
  const cfg = def.rollup ?? { relationPropId: "", targetPropId: "", aggregate: "count" as RollupAggregate };
  const relProp = relationProps.find((p) => p.id === cfg.relationPropId);
  const targetDb = useQuery(
    api.databases.get,
    relProp?.relation ? { databaseId: relProp.relation.databaseId as Doc<"databases">["_id"] } : "skip"
  );
  const targetProps = ((targetDb?.properties ?? []) as PropertyDef[]).filter(
    (p) => p.type !== "rollup" && p.type !== "relation"
  );

  function save(patch: Partial<typeof cfg>) {
    void updateProperty({ databaseId: db._id, propId: def.id, rollup: { ...cfg, ...patch } });
  }

  const aggregates: Array<{ id: RollupAggregate; label: string }> = [
    { id: "count", label: "Count all" },
    { id: "countValues", label: "Count values" },
    { id: "sum", label: "Sum" },
    { id: "average", label: "Average" },
    { id: "min", label: "Min" },
    { id: "max", label: "Max" },
    { id: "percentComplete", label: "% Complete (status)" },
  ];

  return (
    <div className="space-y-1 px-1 pb-1">
      <label className="flex items-center justify-between text-[13px]">
        <span className="text-ink-2">Relation</span>
        <select
          value={cfg.relationPropId}
          onChange={(e) => save({ relationPropId: e.target.value, targetPropId: "" })}
          className="w-36 rounded border border-border bg-surface px-1 py-0.5 text-[12px] outline-none"
        >
          <option value="">Choose…</option>
          {relationProps.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between text-[13px]">
        <span className="text-ink-2">Property</span>
        <select
          value={cfg.targetPropId}
          onChange={(e) => save({ targetPropId: e.target.value })}
          className="w-36 rounded border border-border bg-surface px-1 py-0.5 text-[12px] outline-none"
        >
          <option value="">Choose…</option>
          {targetProps.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between text-[13px]">
        <span className="text-ink-2">Calculate</span>
        <select
          value={cfg.aggregate}
          onChange={(e) => save({ aggregate: e.target.value as RollupAggregate })}
          className="w-36 rounded border border-border bg-surface px-1 py-0.5 text-[12px] outline-none"
        >
          {aggregates.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function AddPropertyButton({ db }: { db: Doc<"databases"> }) {
  const addProperty = useMutation(api.databases.addProperty);
  const allDbs = useQuery(api.databases.listAll) ?? [];
  const [mode, setMode] = useState<"types" | "relationTarget">("types");

  const types: PropertyType[] = [
    "text", "number", "select", "multiSelect", "status", "date",
    "checkbox", "url", "relation", "rollup", "createdTime", "updatedTime",
  ];

  return (
    <Popover
      className="w-56"
      onOpenChange={(open) => !open && setMode("types")}
      trigger={(p) => (
        <button {...p} className="flex w-9 shrink-0 items-center justify-center py-1.5 text-ink-3 hover:bg-hov hover:text-ink" title="Add property">
          <Plus size={14} />
        </button>
      )}
    >
      {(close) =>
        mode === "types" ? (
          <MenuList>
            <MenuLabel>Property type</MenuLabel>
            {types.map((t) => (
              <MenuItem
                key={t}
                icon={PROP_ICONS[t]}
                label={PROP_TYPE_LABELS[t]}
                onClick={() => {
                  if (t === "relation") {
                    setMode("relationTarget");
                  } else {
                    close();
                    void addProperty({ databaseId: db._id, type: t });
                  }
                }}
              />
            ))}
          </MenuList>
        ) : (
          <MenuList>
            <MenuLabel>Link to database</MenuLabel>
            {allDbs.map((target) => (
              <MenuItem
                key={target._id}
                label={target.name || "Untitled"}
                onClick={() => {
                  close();
                  void addProperty({
                    databaseId: db._id,
                    type: "relation",
                    targetDatabaseId: target._id,
                  });
                }}
              />
            ))}
          </MenuList>
        )
      }
    </Popover>
  );
}
