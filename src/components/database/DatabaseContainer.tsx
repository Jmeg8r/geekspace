import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowUpDown,
  CalendarClock,
  ChevronDown,
  EyeOff,
  Filter,
  Flag,
  Plus,
  Settings,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type {
  FilterConfig,
  FilterRule,
  PropertyDef,
  SortRule,
  ViewType,
} from "../../../convex/lib/types";
import { OPTION_COLOR_IDS } from "../../../convex/lib/types";
import { applyView, opsForType, type RowDoc } from "../../lib/viewLogic";
import { cn, tzOffsetMin } from "../../lib/utils";
import { swatchClass } from "../../lib/optionColors";
import { useUI } from "../../state/ui";
import { Popover } from "../common/Popover";
import { MenuItem, MenuLabel, MenuList, MenuSeparator } from "../common/Menu";
import { VIEW_ICONS } from "../common/bits";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { ListView } from "./ListView";
import { DbCalendarView } from "./DbCalendarView";
import { TimelineView } from "./TimelineView";

export interface ViewProps {
  db: Doc<"databases">;
  view: Doc<"views">;
  rows: RowDoc[];
  relationTitles: Record<string, string>;
}

const VIEW_TYPES: ViewType[] = ["table", "board", "list", "calendar", "timeline"];

export function DatabaseContainer({ databaseId }: { databaseId: Id<"databases"> }) {
  const db = useQuery(api.databases.get, { databaseId });
  const views = useQuery(api.views.list, { databaseId });
  const data = useQuery(api.rows.list, { databaseId });
  const createView = useMutation(api.views.create);
  const removeView = useMutation(api.views.remove);
  const updateView = useMutation(api.views.update);
  const createRow = useMutation(api.rows.create);
  const viewByDb = useUI((s) => s.viewByDb);
  const setViewForDb = useUI((s) => s.setViewForDb);

  const activeView = useMemo(() => {
    if (!views || views.length === 0) return undefined;
    return views.find((v) => v._id === viewByDb[databaseId]) ?? views[0];
  }, [views, viewByDb, databaseId]);

  const props = (db?.properties ?? []) as PropertyDef[];
  const viewRows = useMemo(() => {
    if (!data || !activeView) return [];
    return applyView(
      data.rows as RowDoc[],
      props,
      activeView.filters as FilterConfig | undefined,
      activeView.sorts as SortRule[] | undefined
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, activeView, db]);

  if (!db || !views || !data) {
    return <div className="px-8 py-10 text-ink-3">Loading database…</div>;
  }
  if (!activeView) return null;

  const filterCount = (activeView.filters as FilterConfig | undefined)?.rules.length ?? 0;
  const sortCount = (activeView.sorts as SortRule[] | undefined)?.length ?? 0;

  const viewProps: ViewProps = {
    db,
    view: activeView,
    rows: viewRows,
    relationTitles: data.relationTitles,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* View tabs + toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-8">
        <div className="flex flex-1 items-center gap-0.5 overflow-x-auto">
          {views.map((v) => {
            const Icon = VIEW_ICONS[(v.type as ViewType)] ?? VIEW_ICONS.table;
            const active = v._id === activeView._id;
            return (
              <Popover
                key={v._id}
                trigger={(props2) => (
                  <button
                    {...props2}
                    onClick={() => setViewForDb(databaseId, v._id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      (props2 as { onClick?: (e: unknown) => void }).onClick?.(e);
                    }}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-2 text-[13px] font-medium",
                      active
                        ? "border-accent text-ink"
                        : "border-transparent text-ink-2 hover:text-ink"
                    )}
                  >
                    <Icon size={14} />
                    {v.name}
                    {active && <ChevronDown size={12} className="text-ink-3" />}
                  </button>
                )}
              >
                {(close) =>
                  v._id === activeView._id ? (
                    <MenuList className="w-48">
                      <MenuItem
                        label="Rename view"
                        onClick={() => {
                          close();
                          const name = prompt("View name", v.name);
                          if (name) void updateView({ viewId: v._id, name });
                        }}
                      />
                      {views.length > 1 && (
                        <MenuItem
                          icon={Trash2}
                          label="Delete view"
                          danger
                          onClick={() => {
                            close();
                            void removeView({ viewId: v._id });
                            setViewForDb(databaseId, "");
                          }}
                        />
                      )}
                    </MenuList>
                  ) : (
                    <span />
                  )
                }
              </Popover>
            );
          })}
          <Popover
            trigger={(props2) => (
              <button {...props2} className="shrink-0 rounded-md p-1.5 text-ink-3 hover:bg-hov hover:text-ink" title="Add view">
                <Plus size={15} />
              </button>
            )}
          >
            {(close) => (
              <MenuList className="w-44">
                <MenuLabel>New view</MenuLabel>
                {VIEW_TYPES.map((t) => (
                  <MenuItem
                    key={t}
                    icon={VIEW_ICONS[t]}
                    label={t[0].toUpperCase() + t.slice(1)}
                    onClick={async () => {
                      close();
                      const id = await createView({ databaseId, type: t });
                      if (id) setViewForDb(databaseId, id);
                    }}
                  />
                ))}
              </MenuList>
            )}
          </Popover>
        </div>

        <FilterMenu db={db} view={activeView} count={filterCount} />
        <SortMenu db={db} view={activeView} count={sortCount} />
        <PropsMenu db={db} view={activeView} />
        <DbConfigMenu db={db} />
        {db.sprintConfig && <CompleteSprintButton databaseId={db._id} />}
        <button
          onClick={() => void createRow({ databaseId, tzOffsetMin: tzOffsetMin() })}
          className="ml-1 flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-accent-2"
        >
          <Plus size={14} /> New
        </button>
      </div>

      {/* Active view */}
      <div className="min-h-0 flex-1 overflow-auto">
        {activeView.type === "table" && <TableView {...viewProps} />}
        {activeView.type === "board" && <BoardView {...viewProps} />}
        {activeView.type === "list" && <ListView {...viewProps} />}
        {activeView.type === "calendar" && <DbCalendarView {...viewProps} />}
        {activeView.type === "timeline" && <TimelineView {...viewProps} />}
      </div>
    </div>
  );
}

function CompleteSprintButton({ databaseId }: { databaseId: Id<"databases"> }) {
  const completeSprint = useMutation(api.pm.completeSprint);
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        if (!confirm("Complete the current sprint? Open tasks roll into the next one.")) return;
        setBusy(true);
        try {
          const res = await completeSprint({ sprintsDbId: databaseId });
          if (typeof res === "string" && !res.startsWith("completed")) alert(res);
        } finally {
          setBusy(false);
        }
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[13px] text-ink-2 hover:bg-hov hover:text-ink disabled:opacity-50"
      title="Close the current sprint and roll open tasks forward"
    >
      <Flag size={13} /> Complete sprint
    </button>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  count,
  ...rest
}: {
  icon: typeof Filter;
  label: string;
  count?: number;
} & Record<string, unknown>) {
  return (
    <button
      {...rest}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[13px]",
        count ? "text-accent" : "text-ink-2 hover:bg-hov hover:text-ink"
      )}
    >
      <Icon size={14} />
      {label}
      {count ? <span className="text-[11px]">({count})</span> : null}
    </button>
  );
}

function FilterMenu({ db, view, count }: { db: Doc<"databases">; view: Doc<"views">; count: number }) {
  const updateView = useMutation(api.views.update);
  const props = db.properties as PropertyDef[];
  const filters = (view.filters as FilterConfig | undefined) ?? { conjunction: "and", rules: [] };

  function save(next: FilterConfig) {
    void updateView({ viewId: view._id, filters: next });
  }

  return (
    <Popover
      className="w-[380px]"
      trigger={(p) => <ToolbarButton {...p} icon={Filter} label="Filter" count={count} />}
    >
      {() => (
        <div className="space-y-1.5 p-2.5">
          {filters.rules.length > 1 && (
            <div className="flex items-center gap-1 text-[12px] text-ink-2">
              Match
              <select
                value={filters.conjunction}
                onChange={(e) => save({ ...filters, conjunction: e.target.value as "and" | "or" })}
                className="rounded border border-border bg-surface px-1 py-0.5 outline-none"
              >
                <option value="and">all (and)</option>
                <option value="or">any (or)</option>
              </select>
              rules
            </div>
          )}
          {filters.rules.map((rule, i) => (
            <FilterRuleRow
              key={i}
              rule={rule}
              props={props}
              onChange={(next) =>
                save({ ...filters, rules: filters.rules.map((r, j) => (j === i ? next : r)) })
              }
              onRemove={() => save({ ...filters, rules: filters.rules.filter((_, j) => j !== i) })}
            />
          ))}
          <button
            onClick={() => {
              const prop = props.find((p) => p.type !== "rollup") ?? props[0];
              const firstOp = opsForType(prop.type)[0]?.op ?? "isNotEmpty";
              save({ ...filters, rules: [...filters.rules, { propId: prop.id, op: firstOp }] });
            }}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-ink-2 hover:bg-hov"
          >
            <Plus size={13} /> Add filter
          </button>
        </div>
      )}
    </Popover>
  );
}

function FilterRuleRow({
  rule,
  props,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  props: PropertyDef[];
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
}) {
  const def = props.find((p) => p.id === rule.propId);
  const ops = def ? opsForType(def.type) : [];
  const needsValue = !["isEmpty", "isNotEmpty", "checked", "unchecked"].includes(rule.op);

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={rule.propId}
        onChange={(e) => {
          const nextDef = props.find((p) => p.id === e.target.value);
          const firstOp = nextDef ? (opsForType(nextDef.type)[0]?.op ?? "isNotEmpty") : rule.op;
          onChange({ propId: e.target.value, op: firstOp, value: undefined });
        }}
        className="w-28 rounded border border-border bg-surface px-1 py-1 text-[12px] outline-none"
      >
        {props.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <select
        value={rule.op}
        onChange={(e) => onChange({ ...rule, op: e.target.value as FilterRule["op"] })}
        className="w-32 rounded border border-border bg-surface px-1 py-1 text-[12px] outline-none"
      >
        {ops.map((o) => (
          <option key={o.op} value={o.op}>{o.label}</option>
        ))}
      </select>
      {needsValue && def && (
        <FilterValueInput def={def} value={rule.value} onChange={(v) => onChange({ ...rule, value: v })} />
      )}
      <button onClick={onRemove} className="rounded p-1 text-ink-3 hover:bg-hov hover:text-ink">
        <X size={13} />
      </button>
    </div>
  );
}

function FilterValueInput({
  def,
  value,
  onChange,
}: {
  def: PropertyDef;
  value: string | number | undefined;
  onChange: (v: string | number | undefined) => void;
}) {
  if (def.type === "relation" && def.relation) {
    return <RelationValueSelect def={def} value={value} onChange={onChange} />;
  }
  if (def.type === "select" || def.type === "status" || def.type === "multiSelect") {
    return (
      <select
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="flex-1 rounded border border-border bg-surface px-1 py-1 text-[12px] outline-none"
      >
        <option value="">Choose…</option>
        {(def.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    );
  }
  if (def.type === "number" || def.type === "rollup") {
    return (
      <input
        type="number"
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="w-20 flex-1 rounded border border-border bg-surface px-1.5 py-1 text-[12px] outline-none"
      />
    );
  }
  if (def.type === "date") {
    const iso =
      typeof value === "number" ? new Date(value).toISOString().slice(0, 10) : "";
    return (
      <input
        type="date"
        value={iso}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v ? Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) : undefined);
        }}
        className="flex-1 rounded border border-border bg-surface px-1.5 py-1 text-[12px] outline-none"
      />
    );
  }
  return (
    <input
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value"
      className="flex-1 rounded border border-border bg-surface px-1.5 py-1 text-[12px] outline-none"
    />
  );
}

function RelationValueSelect({
  def,
  value,
  onChange,
}: {
  def: PropertyDef;
  value: string | number | undefined;
  onChange: (v: string | number | undefined) => void;
}) {
  const data = useQuery(api.rows.list, {
    databaseId: def.relation!.databaseId as Id<"databases">,
  });
  return (
    <select
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="flex-1 rounded border border-border bg-surface px-1 py-1 text-[12px] outline-none"
    >
      <option value="">Choose…</option>
      {(data?.rows ?? []).map((r) => (
        <option key={r._id} value={r._id}>
          {r.title || "Untitled"}
        </option>
      ))}
    </select>
  );
}

function SortMenu({ db, view, count }: { db: Doc<"databases">; view: Doc<"views">; count: number }) {
  const updateView = useMutation(api.views.update);
  const props = db.properties as PropertyDef[];
  const sorts = (view.sorts as SortRule[] | undefined) ?? [];
  const save = (next: SortRule[]) => void updateView({ viewId: view._id, sorts: next });

  return (
    <Popover
      className="w-72"
      trigger={(p) => <ToolbarButton {...p} icon={ArrowUpDown} label="Sort" count={count} />}
    >
      {() => (
        <div className="space-y-1.5 p-2.5">
          {sorts.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <select
                value={s.propId}
                onChange={(e) => save(sorts.map((x, j) => (j === i ? { ...x, propId: e.target.value } : x)))}
                className="flex-1 rounded border border-border bg-surface px-1 py-1 text-[12px] outline-none"
              >
                {props.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                onClick={() => save(sorts.map((x, j) => (j === i ? { ...x, dir: x.dir === "asc" ? "desc" : "asc" } : x)))}
                className="w-24 rounded border border-border bg-surface px-1.5 py-1 text-[12px] hover:bg-hov"
              >
                {s.dir === "asc" ? "Ascending" : "Descending"}
              </button>
              <button onClick={() => save(sorts.filter((_, j) => j !== i))} className="rounded p-1 text-ink-3 hover:bg-hov">
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            onClick={() => save([...sorts, { propId: props[0].id, dir: "asc" }])}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-ink-2 hover:bg-hov"
          >
            <Plus size={13} /> Add sort
          </button>
        </div>
      )}
    </Popover>
  );
}

function PropsMenu({ db, view }: { db: Doc<"databases">; view: Doc<"views"> }) {
  const updateView = useMutation(api.views.update);
  const props = db.properties as PropertyDef[];
  const hidden = new Set(view.hiddenPropIds ?? []);

  return (
    <Popover
      className="w-56"
      trigger={(p) => <ToolbarButton {...p} icon={EyeOff} label="Properties" />}
    >
      {() => (
        <MenuList>
          <MenuLabel>Shown in this view</MenuLabel>
          {props.map((prop) => (
            <label
              key={prop.id}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-hov"
            >
              <input
                type="checkbox"
                checked={!hidden.has(prop.id)}
                disabled={prop.type === "title"}
                onChange={(e) => {
                  const next = new Set(hidden);
                  if (e.target.checked) next.delete(prop.id);
                  else next.add(prop.id);
                  void updateView({ viewId: view._id, hiddenPropIds: [...next] });
                }}
                className="accent-[var(--accent)]"
              />
              <span className="truncate">{prop.name}</span>
            </label>
          ))}
        </MenuList>
      )}
    </Popover>
  );
}

function DbConfigMenu({ db }: { db: Doc<"databases"> }) {
  const setCalendarConfig = useMutation(api.databases.setCalendarConfig);
  const setTaskSource = useMutation(api.databases.setTaskSource);
  const props = db.properties as PropertyDef[];
  const dateProps = props.filter((p) => p.type === "date");

  // Auto-detect a task mapping from the schema.
  const detected = useMemo(() => {
    const status = props.find((p) => p.type === "status");
    const date = props.find((p) => p.type === "date");
    const estimate = props.find((p) => p.type === "number");
    const priority = props.find((p) => p.type === "select");
    return status && date && estimate && priority
      ? {
          statusPropId: status.id,
          datePropId: date.id,
          estimatePropId: estimate.id,
          priorityPropId: priority.id,
        }
      : null;
  }, [props]);

  const [pending, setPending] = useState(false);

  return (
    <Popover
      className="w-72"
      trigger={(p) => <ToolbarButton {...p} icon={Settings} label="" />}
    >
      {() => (
        <div className="p-2.5">
          <div className="flex items-center gap-1.5 pb-1.5 text-[12px] font-semibold text-ink-2">
            <CalendarClock size={13} /> Calendar
          </div>
          <label className="flex items-center justify-between py-1 text-[13px]">
            <span>Show on calendar</span>
            <input
              type="checkbox"
              checked={db.showOnCalendar ?? false}
              onChange={(e) =>
                void setCalendarConfig({
                  databaseId: db._id,
                  showOnCalendar: e.target.checked,
                  calendarDatePropId: db.calendarDatePropId ?? dateProps[0]?.id,
                })
              }
              className="accent-[var(--accent)]"
            />
          </label>
          {(db.showOnCalendar ?? false) && dateProps.length > 0 && (
            <label className="flex items-center justify-between py-1 text-[13px]">
              <span className="text-ink-2">Date property</span>
              <select
                value={db.calendarDatePropId ?? dateProps[0]?.id}
                onChange={(e) =>
                  void setCalendarConfig({ databaseId: db._id, calendarDatePropId: e.target.value })
                }
                className="rounded border border-border bg-surface px-1 py-0.5 text-[12px] outline-none"
              >
                {dateProps.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex items-center gap-1 py-1">
            <span className="text-[13px]">Color</span>
            <span className="flex-1" />
            {OPTION_COLOR_IDS.map((c) => (
              <button
                key={c}
                onClick={() => void setCalendarConfig({ databaseId: db._id, color: c })}
                className={cn(
                  "h-4 w-4 rounded-full border-2",
                  swatchClass(c),
                  db.color === c ? "border-ink" : "border-transparent"
                )}
                title={c}
              />
            ))}
          </div>

          <MenuSeparator />
          <div className="flex items-center gap-1.5 pb-1.5 pt-1 text-[12px] font-semibold text-ink-2">
            <Zap size={13} /> Auto-scheduling
          </div>
          <label className="flex items-center justify-between py-1 text-[13px]">
            <span>Use as task source</span>
            <input
              type="checkbox"
              checked={db.isTaskSource ?? false}
              disabled={(!detected && !db.isTaskSource) || pending}
              onChange={async (e) => {
                setPending(true);
                try {
                  await setTaskSource({
                    databaseId: db._id,
                    isTaskSource: e.target.checked,
                    taskConfig: e.target.checked ? (db.taskConfig ?? detected ?? undefined) : undefined,
                    tzOffsetMin: tzOffsetMin(),
                  });
                } finally {
                  setPending(false);
                }
              }}
              className="accent-[var(--accent)]"
            />
          </label>
          <p className="pt-0.5 text-[11px] leading-snug text-ink-3">
            {detected || db.isTaskSource
              ? "Tasks with an estimate + due date get auto-scheduled time blocks on your calendar."
              : "Needs status, date, number (estimate), and select (priority) properties."}
          </p>
        </div>
      )}
    </Popover>
  );
}
