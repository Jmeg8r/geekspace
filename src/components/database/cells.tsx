import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { Check, ExternalLink, Plus, Search } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  DateValue,
  PropertyDef,
  SelectOption,
  StatusGroup,
} from "../../../convex/lib/types";
import { makeId } from "../../../convex/lib/types";
import type { RowDoc } from "../../lib/viewLogic";
import { fmtDateValue, fmtDuration } from "../../lib/dates";
import { chipClass, nextOptionColor } from "../../lib/optionColors";
import { cn, debounce, tzOffsetMin } from "../../lib/utils";
import { Popover } from "../common/Popover";
import { DatePicker } from "../common/DatePicker";
import { Chip, ProgressBar } from "../common/bits";

// WHAT: Inline editors for every property type. Used by table cells ("cell")
// and the row peek panel ("peek").

export interface CellProps {
  def: PropertyDef;
  row: RowDoc;
  relationTitles: Record<string, string>;
  variant: "cell" | "peek";
}

const cellBase =
  "flex min-h-[34px] w-full items-center px-2 py-1 text-left text-[13px] leading-snug";

export function PropertyValueCell(props: CellProps) {
  switch (props.def.type) {
    case "title":
    case "text":
      return <TextCell {...props} />;
    case "number":
      return <NumberCell {...props} />;
    case "select":
    case "multiSelect":
    case "status":
      return <SelectCell {...props} />;
    case "date":
      return <DateCell {...props} />;
    case "checkbox":
      return <CheckboxCell {...props} />;
    case "url":
      return <UrlCell {...props} />;
    case "relation":
      return <RelationCell {...props} />;
    case "rollup":
      return <RollupCell {...props} />;
    case "createdTime":
      return <span className={cn(cellBase, "text-ink-2")}>{format(props.row._creationTime, "MMM d, yyyy h:mm a")}</span>;
    case "updatedTime":
      return <span className={cn(cellBase, "text-ink-2")}>{format(props.row.updatedAt, "MMM d, yyyy h:mm a")}</span>;
    default:
      return <span className={cellBase} />;
  }
}

/** Draft-while-editing input: server value wins when not focused. */
function useDraft(serverValue: string) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    value: draft ?? serverValue,
    setDraft,
    clearDraft: () => setDraft(null),
  };
}

function TextCell({ def, row, variant }: CellProps) {
  const update = useMutation(api.rows.updateProperty);
  const server =
    def.type === "title" ? (row.title ?? "") : ((row.properties?.[def.id] as string) ?? "");
  const { value, setDraft, clearDraft } = useDraft(server);
  const saver = useRef(
    debounce((rowId: Id<"rows">, propId: string, v: string) => {
      void update({ rowId, propId, value: v, tzOffsetMin: tzOffsetMin() });
    }, 350)
  );
  useEffect(() => {
    const s = saver.current;
    return () => s.flush();
  }, []);

  return (
    <input
      value={value}
      placeholder={def.type === "title" ? "Untitled" : ""}
      onChange={(e) => {
        setDraft(e.target.value);
        saver.current(row._id, def.id, e.target.value);
      }}
      onBlur={() => {
        saver.current.flush();
        clearDraft();
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={cn(
        cellBase,
        "bg-transparent outline-none placeholder:text-ink-3",
        def.type === "title" && variant === "cell" && "font-medium"
      )}
    />
  );
}

function formatNumber(n: number, fmt?: string): string {
  switch (fmt) {
    case "minutes": return fmtDuration(n);
    case "percent": return `${n}%`;
    case "dollar": return `$${n.toLocaleString()}`;
    default: return String(n);
  }
}

function NumberCell({ def, row }: CellProps) {
  const update = useMutation(api.rows.updateProperty);
  const server = row.properties?.[def.id];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    void update({
      rowId: row._id,
      propId: def.id,
      value: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      tzOffsetMin: tzOffsetMin(),
    });
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className={cn(cellBase, "bg-transparent outline-none")}
      />
    );
  }
  const n = typeof server === "number" ? server : null;
  return (
    <button
      onClick={() => {
        setDraft(n === null ? "" : String(n));
        setEditing(true);
      }}
      className={cn(cellBase, "tabular-nums hover:bg-hov")}
    >
      {n === null ? (
        <span className="text-ink-3">—</span>
      ) : def.numberFormat === "progress" ? (
        <ProgressBar value={n} />
      ) : (
        formatNumber(n, def.numberFormat)
      )}
    </button>
  );
}

const STATUS_GROUPS: Array<{ id: StatusGroup; label: string }> = [
  { id: "todo", label: "To-do" },
  { id: "inprogress", label: "In progress" },
  { id: "complete", label: "Complete" },
];

function SelectCell({ def, row }: CellProps) {
  const updateRow = useMutation(api.rows.updateProperty);
  const updateProp = useMutation(api.databases.updateProperty);
  const [q, setQ] = useState("");
  const multi = def.type === "multiSelect";
  const raw = row.properties?.[def.id];
  const selectedIds: string[] = multi
    ? Array.isArray(raw) ? (raw as string[]) : []
    : typeof raw === "string" && raw ? [raw] : [];
  const options = def.options ?? [];
  const selected = selectedIds
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is SelectOption => Boolean(o));

  function setValue(ids: string[]) {
    void updateRow({
      rowId: row._id,
      propId: def.id,
      value: multi ? ids : (ids[0] ?? undefined),
      tzOffsetMin: tzOffsetMin(),
    });
  }

  async function createOption(name: string): Promise<void> {
    const option: SelectOption = {
      id: makeId(),
      name,
      color: nextOptionColor(options.map((o) => o.color)),
      ...(def.type === "status" ? { group: "todo" as StatusGroup } : {}),
    };
    await updateProp({
      databaseId: row.databaseId,
      propId: def.id,
      options: [...options, option],
    });
    setValue(multi ? [...selectedIds, option.id] : [option.id]);
  }

  const filtered = options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()));
  const exact = options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());

  function renderOptions(close: () => void) {
    const choose = (id: string) => {
      if (multi) {
        setValue(
          selectedIds.includes(id)
            ? selectedIds.filter((x) => x !== id)
            : [...selectedIds, id]
        );
      } else {
        setValue(selectedIds[0] === id ? [] : [id]);
        close();
      }
    };
    const optionRow = (o: SelectOption) => (
      <button
        key={o.id}
        onClick={() => choose(o.id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hov"
      >
        <span className={chipClass(o.color)}>
          <span>{o.name}</span>
        </span>
        <span className="flex-1" />
        {selectedIds.includes(o.id) && <Check size={14} className="text-accent" />}
      </button>
    );

    return (
      <div className="w-64 p-1.5">
        <div className="mb-1 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
          <Search size={13} className="text-ink-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={multi ? "Search or create…" : "Search…"}
            className="w-full bg-transparent text-[13px] outline-none"
          />
        </div>
        <div className="max-h-60 overflow-auto">
          {def.type === "status"
            ? STATUS_GROUPS.map((g) => {
                const inGroup = filtered.filter((o) => o.group === g.id);
                if (inGroup.length === 0) return null;
                return (
                  <div key={g.id}>
                    <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                      {g.label}
                    </div>
                    {inGroup.map(optionRow)}
                  </div>
                );
              })
            : filtered.map(optionRow)}
          {q.trim() && !exact && (
            <button
              onClick={() => {
                void createOption(q.trim());
                setQ("");
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hov"
            >
              <Plus size={13} className="text-ink-2" />
              Create <Chip color="gray" name={q.trim()} />
            </button>
          )}
          {filtered.length === 0 && !q.trim() && (
            <div className="px-2 py-2 text-[12px] text-ink-3">No options yet — type to create one</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <Popover
      onOpenChange={(open) => !open && setQ("")}
      trigger={(props) => (
        <button {...props} className={cn(cellBase, "flex-wrap gap-1 hover:bg-hov")}>
          {selected.length === 0 ? (
            <span className="text-ink-3">—</span>
          ) : (
            selected.map((o) => <Chip key={o.id} color={o.color} name={o.name} />)
          )}
        </button>
      )}
    >
      {renderOptions}
    </Popover>
  );
}

function DateCell({ def, row }: CellProps) {
  const update = useMutation(api.rows.updateProperty);
  const dv = row.properties?.[def.id] as DateValue | undefined;
  return (
    <Popover
      trigger={(props) => (
        <button {...props} className={cn(cellBase, "hover:bg-hov")}>
          {dv ? fmtDateValue(dv) : <span className="text-ink-3">—</span>}
        </button>
      )}
    >
      {(close) => (
        <DatePicker
          value={dv}
          close={close}
          onChange={(v) =>
            void update({ rowId: row._id, propId: def.id, value: v, tzOffsetMin: tzOffsetMin() })
          }
        />
      )}
    </Popover>
  );
}

function CheckboxCell({ def, row }: CellProps) {
  const update = useMutation(api.rows.updateProperty);
  const checked = row.properties?.[def.id] === true;
  return (
    <label className={cn(cellBase, "cursor-pointer")}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) =>
          void update({
            rowId: row._id,
            propId: def.id,
            value: e.target.checked,
            tzOffsetMin: tzOffsetMin(),
          })
        }
        className="h-4 w-4 accent-[var(--accent)]"
      />
    </label>
  );
}

function UrlCell({ def, row }: CellProps) {
  const update = useMutation(api.rows.updateProperty);
  const server = (row.properties?.[def.id] as string) ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    const commit = () => {
      void update({
        rowId: row._id,
        propId: def.id,
        value: draft.trim() || undefined,
        tzOffsetMin: tzOffsetMin(),
      });
      setEditing(false);
    };
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        placeholder="https://"
        className={cn(cellBase, "bg-transparent outline-none")}
      />
    );
  }
  return (
    <span className={cn(cellBase, "group/url gap-1")}>
      <button
        onClick={() => {
          setDraft(server);
          setEditing(true);
        }}
        className="min-w-0 flex-1 truncate text-left hover:bg-hov"
      >
        {server ? (
          <span className="text-accent underline decoration-accent/40">{server}</span>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </button>
      {server && (
        <a
          href={server.startsWith("http") ? server : `https://${server}`}
          target="_blank"
          rel="noreferrer"
          className="rounded p-0.5 text-ink-3 opacity-0 hover:bg-hov hover:text-ink group-hover/url:opacity-100"
        >
          <ExternalLink size={13} />
        </a>
      )}
    </span>
  );
}

function RelationCell({ def, row, relationTitles }: CellProps) {
  const update = useMutation(api.rows.updateProperty);
  const ids = Array.isArray(row.properties?.[def.id])
    ? (row.properties[def.id] as string[])
    : [];

  if (!def.relation) return <span className={cellBase} />;
  const targetDb = def.relation.databaseId as Id<"databases">;

  return (
    <Popover
      className="w-72"
      trigger={(props) => (
        <button {...props} className={cn(cellBase, "flex-wrap gap-1 hover:bg-hov")}>
          {ids.length === 0 ? (
            <span className="text-ink-3">—</span>
          ) : (
            ids.map((id) => (
              <span key={id} className="rounded bg-hov px-1.5 py-0.5 text-[12px] underline decoration-[var(--ink-3)] underline-offset-2">
                {relationTitles[id] ?? "Untitled"}
              </span>
            ))
          )}
        </button>
      )}
    >
      {() => (
        <RelationPicker
          targetDatabaseId={targetDb}
          excludeRowId={row.databaseId === targetDb ? row._id : undefined}
          selected={ids}
          onChange={(next) =>
            void update({ rowId: row._id, propId: def.id, value: next, tzOffsetMin: tzOffsetMin() })
          }
        />
      )}
    </Popover>
  );
}

export function RelationPicker({
  targetDatabaseId,
  selected,
  onChange,
  excludeRowId,
}: {
  targetDatabaseId: Id<"databases">;
  selected: string[];
  onChange: (ids: string[]) => void;
  excludeRowId?: string;
}) {
  const data = useQuery(api.rows.list, { databaseId: targetDatabaseId });
  const [q, setQ] = useState("");
  const rows = (data?.rows ?? [])
    .filter((r) => r._id !== excludeRowId)
    .filter((r) => (r.title || "Untitled").toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="p-1.5">
      <div className="mb-1 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
        <Search size={13} className="text-ink-3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search rows…"
          className="w-full bg-transparent text-[13px] outline-none"
        />
      </div>
      <div className="max-h-60 overflow-auto">
        {rows.map((r) => {
          const isSel = selected.includes(r._id);
          return (
            <button
              key={r._id}
              onClick={() =>
                onChange(isSel ? selected.filter((x) => x !== r._id) : [...selected, r._id])
              }
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hov"
            >
              <span className="flex-1 truncate">{r.title || "Untitled"}</span>
              {isSel && <Check size={14} className="text-accent" />}
            </button>
          );
        })}
        {rows.length === 0 && (
          <div className="px-2 py-3 text-center text-[12px] text-ink-3">
            {data === undefined ? "Loading…" : "No rows found"}
          </div>
        )}
      </div>
    </div>
  );
}

function RollupCell({ def, row }: CellProps) {
  const value = row.computed?.[def.id];
  const configured = def.rollup && def.rollup.relationPropId && def.rollup.targetPropId;
  return (
    <span className={cn(cellBase, "tabular-nums text-ink-2")}>
      {!configured ? (
        <span className="text-[12px] text-ink-3">Configure in property menu</span>
      ) : value === null || value === undefined ? (
        <span className="text-ink-3">—</span>
      ) : def.numberFormat === "progress" || def.rollup?.aggregate === "percentComplete" ? (
        <ProgressBar value={value} />
      ) : (
        formatNumber(value, def.numberFormat)
      )}
    </span>
  );
}
