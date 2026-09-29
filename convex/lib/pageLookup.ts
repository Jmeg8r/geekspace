import type { DatabaseReader } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export async function getPageByAnyId(
  db: Pick<DatabaseReader, "normalizeId" | "get">,
  pageId: string
): Promise<Doc<"pages"> | null> {
  return db.get(pageId as Id<"pages">);
}
