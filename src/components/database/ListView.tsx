import { FileText, Plus } from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { DateValue, PropertyDef } from "../../../convex/lib/types";
import { fmtDateValue } from "../../lib/dates";
import { tzOffsetMin } from "../../lib/utils";
import { useUI } from "../../state/ui";
import { Chip } from "../common/bits";
import type { ViewProps } from "./DatabaseContainer";

export function ListView({ db, view, rows }: ViewProps) {
  const props = (db.properties as PropertyDef[]).filter(
    (p) => !(view.hiddenPropIds ?? []).includes(p.id)
  );
  const openRow = useUI((s) => s.openRow);
  const createRow = useMutation(api.rows.create);

  const statusProp = props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select");
  const dateProp = props.find((p) => p.type === "date");

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-3">
      {rows.map((row) => {
        const statusVal = statusProp ? row.properties?.[statusProp.id] : undefined;
        const option = statusProp?.options?.find((o) => o.id === statusVal);
        const dv = dateProp ? (row.properties?.[dateProp.id] as DateValue | undefined) : undefined;
        return (
          <button
            key={row._id}
            onClick={() => openRow(row._id)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hov"
          >
            <FileText size={14} className="shrink-0 text-ink-3" />
            <span className="flex-1 truncate text-[13.5px] font-medium">
              {row.title || <span className="font-normal text-ink-3">Untitled</span>}
            </span>
            {dv && <span className="shrink-0 text-[12px] text-ink-2">{fmtDateValue(dv)}</span>}
            {option && <Chip color={option.color} name={option.name} />}
          </button>
        );
      })}
      <button
        onClick={() => void createRow({ databaseId: db._id, tzOffsetMin: tzOffsetMin() })}
        className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-ink-3 hover:bg-hov hover:text-ink-2"
      >
        <Plus size={14} /> New row
      </button>
    </div>
  );
}
