import type { DatabaseReader } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// WHAT: Look a page up by an id string that may not be a `pages` id.
// WHY: the renderer persists `nav.pageId` across launches, so after a deployment reset
// or a data-dir change it can hold an id from another table, or a malformed string.
// With `v.id("pages")` Convex rejects that before the handler runs, `useQuery` throws
// during render, and with no error boundary the whole window goes blank (#41).
// `db.get` alone is not enough: it resolves an id from ANY table, so relaxing the
// validator to `v.string()` would hand an `events` document back as a page.
// `normalizeId` checks the table and returns null for anything that is not a pages id.
export async function getPageByAnyId(
  db: Pick<DatabaseReader, "normalizeId" | "get">,
  pageId: string
): Promise<Doc<"pages"> | null> {
  const id = db.normalizeId("pages", pageId);
  return id === null ? null : db.get(id);
}
