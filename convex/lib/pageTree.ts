import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

// WHAT: whether a page is out of sight: trashed itself, or under a trashed ancestor.
// WHY: trash marks only the page the user trashed, not its subtree. pages.list hides the
// subtree in memory; the scheduler and calendar data use this to skip task databases that
// live under a trashed page. See docs/changes/2026-10-15-scheduler-correctness/.
/**
 * Whether `pageId` is, or contains, the page of a task-source database: trashing, restoring
 * or moving it then changes what the scheduler may plan, so the caller should reflow.
 */
export async function holdsTaskSource(db: QueryCtx["db"], pageId: Id<"pages">): Promise<boolean> {
  const sources = (await db.query("databases").collect()).filter((d) => d.isTaskSource && d.pageId);
  for (const source of sources) {
    const seen = new Set<Id<"pages">>();
    let cursor: Id<"pages"> | undefined = source.pageId;
    while (cursor && !seen.has(cursor)) {
      if (cursor === pageId) return true;
      seen.add(cursor);
      const page: Doc<"pages"> | null = await db.get(cursor);
      cursor = page?.parentId;
    }
  }
  return false;
}

export async function isPageHidden(db: QueryCtx["db"], pageId: Id<"pages">): Promise<boolean> {
  const seen = new Set<Id<"pages">>();
  let cursor: Id<"pages"> | undefined = pageId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const page: Doc<"pages"> | null = await db.get(cursor);
    // A page deleted forever leaves its children reachable, as pages.list does.
    if (!page) return false;
    if (page.trashed) return true;
    cursor = page.parentId;
  }
  return false;
}
