import { useState, type CSSProperties } from "react";
import { useMutation } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  MoreHorizontal,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { cn } from "../../lib/utils";
import { Popover } from "../common/Popover";
import { MenuItem, MenuList, MenuSeparator } from "../common/Menu";

type Page = Doc<"pages">;

/** dnd-kit bits passed in when this row is rendered inside the sortable tree. */
export interface RowDragProps {
  setNodeRef: (el: HTMLElement | null) => void;
  style: CSSProperties;
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown> | undefined;
  isDragging: boolean;
}

// WHAT: One sidebar page row — icon, title, expand chevron, and the hover
// actions (favorite / trash / add-inside). Shared by the Favorites list (flat)
// and the draggable Pages tree.
export function PageRow({
  page,
  depth,
  flat,
  hasChildren,
  drag,
}: {
  page: Page;
  depth: number;
  flat?: boolean;
  hasChildren?: boolean;
  drag?: RowDragProps;
}) {
  const nav = useUI((s) => s.nav);
  const navigate = useUI((s) => s.navigate);
  const expanded = useUI((s) => s.expanded[page._id] ?? false);
  const toggleExpanded = useUI((s) => s.toggleExpanded);
  const setExpanded = useUI((s) => s.setExpanded);
  const createPage = useMutation(api.pages.create);
  const toggleFavorite = useMutation(api.pages.toggleFavorite);
  const trash = useMutation(api.pages.trash);

  // WHY: while a row's action menu is open, keep the actions laid out (not
  // display:none on un-hover). Otherwise the trigger collapses to a zero-size
  // box and floating-ui re-pins the open menu to the viewport corner.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const actionsOpen = optionsOpen || addOpen;

  const active = nav.kind === "page" && nav.pageId === page._id;
  const isDragging = drag?.isDragging ?? false;

  async function addChild(kind: "doc" | "database") {
    const pageId = await createPage({ kind, parentId: page._id });
    setExpanded(page._id, true);
    if (pageId) navigate({ kind: "page", pageId });
  }

  return (
    <div
      ref={drag?.setNodeRef}
      data-page-id={page._id}
      style={{ ...drag?.style, paddingLeft: 4 + depth * 14 }}
      {...drag?.attributes}
      {...drag?.listeners}
      className={cn(
        "group flex w-full cursor-pointer items-center rounded-md py-1 pr-1 text-[13px]",
        active ? "bg-act font-medium text-ink" : "text-ink-2 hover:bg-hov hover:text-ink",
        actionsOpen && !active && "bg-hov text-ink",
        isDragging && "opacity-50"
      )}
      onClick={() => {
        if (!isDragging) navigate({ kind: "page", pageId: page._id });
      }}
    >
      {flat ? (
        <span className="w-1.5" />
      ) : hasChildren ? (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(page._id);
          }}
          className="mr-0.5 rounded p-0.5 text-ink-3 hover:bg-act"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      ) : (
        <span className="mr-0.5 inline-block w-[18px]" />
      )}
      <span className="mr-1.5 w-4 text-center text-[14px] leading-none">
        {page.icon ?? (page.kind === "database" ? <Database size={14} className="inline text-ink-3" /> : <FileText size={14} className="inline text-ink-3" />)}
      </span>
      <span className="flex-1 truncate">{page.title || "Untitled"}</span>

      {!flat && (
        <span
          className={cn("items-center gap-0.5", actionsOpen ? "flex" : "hidden group-hover:flex")}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Popover
            onOpenChange={setOptionsOpen}
            trigger={(props) => (
              <button {...props} className="rounded p-0.5 text-ink-3 hover:bg-act hover:text-ink" title="Options">
                <MoreHorizontal size={14} />
              </button>
            )}
          >
            {(close) => (
              <MenuList>
                <MenuItem
                  icon={Star}
                  label={page.favorite ? "Remove from favorites" : "Add to favorites"}
                  onClick={() => {
                    close();
                    void toggleFavorite({ pageId: page._id });
                  }}
                />
                <MenuSeparator />
                <MenuItem
                  icon={Trash2}
                  label="Move to trash"
                  danger
                  onClick={() => {
                    close();
                    void trash({ pageId: page._id });
                    if (active) navigate({ kind: "home" });
                  }}
                />
              </MenuList>
            )}
          </Popover>
          <Popover
            onOpenChange={setAddOpen}
            trigger={(props) => (
              <button {...props} className="rounded p-0.5 text-ink-3 hover:bg-act hover:text-ink" title="Add page inside">
                <Plus size={14} />
              </button>
            )}
          >
            {(close) => (
              <MenuList>
                <MenuItem icon={FileText} label="New page" onClick={() => { close(); void addChild("doc"); }} />
                <MenuItem icon={Database} label="New database" onClick={() => { close(); void addChild("database"); }} />
              </MenuList>
            )}
          </Popover>
        </span>
      )}
    </div>
  );
}
