import { useMemo, useState, type CSSProperties } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMutation } from "convex/react";
import { Database, FileText } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { PageRow } from "./PageRow";

type Page = Doc<"pages">;

// Indentation step per depth level — must match PageRow's paddingLeft formula
// (4 + depth * 14) so the drag projection lines up with what's rendered.
const INDENT = 14;

interface FlatNode {
  page: Page;
  depth: number;
  parentId: string | undefined;
  hasChildren: boolean;
}

/** Depth-first flatten of the visible tree (collapsed subtrees are skipped). */
function flattenTree(
  roots: Page[],
  childrenOf: Map<string, Page[]>,
  expanded: Record<string, boolean>
): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: Page[], depth: number, parentId: string | undefined) => {
    for (const page of nodes) {
      const kids = childrenOf.get(page._id) ?? [];
      out.push({ page, depth, parentId, hasChildren: kids.length > 0 });
      if (kids.length > 0 && expanded[page._id]) walk(kids, depth + 1, page._id);
    }
  };
  walk(roots, 0, undefined);
  return out;
}

/** Ids of every descendant of `rootId` (contiguous deeper nodes in DFS order). */
function descendantIds(flat: FlatNode[], rootId: string): Set<string> {
  const out = new Set<string>();
  const i = flat.findIndex((n) => n.page._id === rootId);
  if (i < 0) return out;
  const rootDepth = flat[i].depth;
  for (let j = i + 1; j < flat.length; j++) {
    if (flat[j].depth <= rootDepth) break;
    out.add(flat[j].page._id);
  }
  return out;
}

/**
 * Where the dragged row would land — depth (clamped to what's legal between its
 * neighbours) and the resulting parentId. Horizontal drag offset chooses depth,
 * which is how you nest. This is the standard dnd-kit sortable-tree projection.
 */
function getProjection(
  items: FlatNode[],
  activeId: string,
  overId: string,
  dragOffset: number,
  indent: number
): { depth: number; parentId: string | undefined } {
  const overIndex = items.findIndex((n) => n.page._id === overId);
  const activeIndex = items.findIndex((n) => n.page._id === activeId);
  if (overIndex < 0 || activeIndex < 0) return { depth: 0, parentId: undefined };
  const activeItem = items[activeIndex];
  const newItems = arrayMove(items, activeIndex, overIndex);
  const prev = newItems[overIndex - 1];
  const next = newItems[overIndex + 1];

  const projectedDepth = activeItem.depth + Math.round(dragOffset / indent);
  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.max(minDepth, Math.min(projectedDepth, maxDepth));

  const parentId = (() => {
    if (depth === 0 || !prev) return undefined;
    if (depth === prev.depth) return prev.parentId;
    if (depth > prev.depth) return prev.page._id;
    return newItems
      .slice(0, overIndex)
      .reverse()
      .find((n) => n.depth === depth)?.parentId;
  })();

  return { depth, parentId };
}

// WHAT: The draggable Pages tree. Drag a row to reorder it; drag right to nest
// it under the row above. Reparent + reorder persist via pages.move.
export function PageTree({
  roots,
  childrenOf,
}: {
  roots: Page[];
  childrenOf: Map<string, Page[]>;
}) {
  const expanded = useUI((s) => s.expanded);
  const setExpanded = useUI((s) => s.setExpanded);
  const movePage = useMutation(api.pages.move);

  const flat = useMemo(
    () => flattenTree(roots, childrenOf, expanded),
    [roots, childrenOf, expanded]
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);

  // While dragging, hide the dragged node's descendants so it can't be dropped
  // into its own subtree and the projection math stays correct.
  const visible = useMemo(() => {
    if (!activeId) return flat;
    const buried = descendantIds(flat, activeId);
    return flat.filter((n) => !buried.has(n.page._id));
  }, [flat, activeId]);

  const projected =
    activeId && overId ? getProjection(visible, activeId, overId, offsetLeft, INDENT) : null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const activeNode = activeId ? flat.find((n) => n.page._id === activeId) ?? null : null;

  function resetDrag() {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
  }

  function handleDragEnd({ over }: DragEndEvent) {
    const movedId = activeId;
    const proj = projected;
    const list = visible;
    resetDrag();
    if (!proj || !over || !movedId) return;

    const overIndex = list.findIndex((n) => n.page._id === over.id);
    const activeIndex = list.findIndex((n) => n.page._id === movedId);
    if (overIndex < 0 || activeIndex < 0) return;
    const reordered = arrayMove(list, activeIndex, overIndex);

    // Position among the destination parent's existing children.
    let index = 0;
    for (const n of reordered) {
      if (n.page._id === movedId) break;
      if (n.parentId === proj.parentId) index++;
    }

    void movePage({
      pageId: movedId as Id<"pages">,
      newParentId: proj.parentId as Id<"pages"> | undefined,
      index,
    });
    if (proj.parentId) setExpanded(proj.parentId, true);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={({ active }: DragStartEvent) => {
        setActiveId(String(active.id));
        setOverId(String(active.id));
      }}
      onDragMove={({ delta }: DragMoveEvent) => setOffsetLeft(delta.x)}
      onDragOver={({ over }: DragOverEvent) => setOverId(over ? String(over.id) : null)}
      onDragEnd={handleDragEnd}
      onDragCancel={resetDrag}
    >
      <SortableContext items={visible.map((n) => n.page._id)} strategy={verticalListSortingStrategy}>
        {visible.map((node) => (
          <SortableRow
            key={node.page._id}
            node={node}
            depth={node.page._id === activeId && projected ? projected.depth : node.depth}
          />
        ))}
      </SortableContext>
      <DragOverlay>
        {activeNode ? <DragGhost page={activeNode.page} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableRow({ node, depth }: { node: FlatNode; depth: number }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: node.page._id,
  });
  // Only vertical movement matters in a list; depth (indentation) communicates
  // nesting instead of horizontal translation.
  const style: CSSProperties = {
    transform: transform ? `translate3d(0px, ${transform.y}px, 0)` : undefined,
    transition: transition ?? undefined,
  };
  return (
    <PageRow
      page={node.page}
      depth={depth}
      hasChildren={node.hasChildren}
      drag={{
        setNodeRef,
        style,
        attributes: attributes as unknown as Record<string, unknown>,
        listeners,
        isDragging,
      }}
    />
  );
}

function DragGhost({ page }: { page: Page }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-[13px] text-ink shadow-[var(--shadow-lg)]">
      <span className="w-4 text-center text-[14px] leading-none">
        {page.icon ?? (page.kind === "database" ? <Database size={14} className="inline text-ink-3" /> : <FileText size={14} className="inline text-ink-3" />)}
      </span>
      <span className="truncate">{page.title || "Untitled"}</span>
    </div>
  );
}
