import { convex } from "./convex";
import { api } from "../../convex/_generated/api";

// WHAT: BlockNote uploadFile handler → Convex file storage.
export async function uploadFile(file: File): Promise<string> {
  const uploadUrl = await convex.mutation(api.files.generateUploadUrl, {});
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  const { storageId } = (await res.json()) as { storageId: string };
  const url = await convex.query(api.files.getUrl, {
    storageId: storageId as never,
  });
  if (!url) throw new Error("Could not resolve uploaded file URL");
  return url;
}
