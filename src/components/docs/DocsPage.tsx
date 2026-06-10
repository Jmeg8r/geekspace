import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import {
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Loader2,
  Paperclip,
  Upload,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PropertyDef } from "../../../convex/lib/types";
import { convex } from "../../lib/convex";
import { cn } from "../../lib/utils";
import { DocViewer, type DocItem } from "./DocViewer";

// WHAT: Docs library — drag files in, preview them in-app, optionally link
// them to a project. Notion's "files & media", local-first.

function mimeIcon(mime: string) {
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime === "application/pdf") return FileText;
  if (/json|javascript|typescript|xml|x-sh|python/.test(mime)) return FileCode;
  return Paperclip;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function guessMime(file: File): string {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown", txt: "text/plain", json: "application/json",
    js: "text/javascript", ts: "text/typescript", py: "text/x-python",
    sh: "application/x-sh", yml: "text/yaml", yaml: "text/yaml",
    log: "text/plain", csv: "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}

export function DocsPage() {
  const [projectFilter, setProjectFilter] = useState<string>("");
  const docs =
    useQuery(
      api.docs.list,
      projectFilter ? { projectRowId: projectFilter as Id<"rows"> } : {}
    ) ?? [];
  const allDbs = useQuery(api.databases.listAll) ?? [];
  const addDoc = useMutation(api.docs.add);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [viewing, setViewing] = useState<DocItem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The projects database (relation target of the task source) for link options.
  const projectsDb = useMemo(() => {
    for (const d of allDbs) {
      if (!d.isTaskSource) continue;
      const rel = (d.properties as PropertyDef[]).find(
        (p) => p.type === "relation" && p.relation?.syncedPropId && p.relation.databaseId !== d._id
      );
      const target = allDbs.find((x) => x._id === rel?.relation?.databaseId);
      if (target && !target.sprintConfig) return target;
    }
    return undefined;
  }, [allDbs]);
  const projectRows = useQuery(
    api.rows.list,
    projectsDb ? { databaseId: projectsDb._id } : "skip"
  );

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const mime = guessMime(file);
        const uploadUrl = await convex.mutation(api.files.generateUploadUrl, {});
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": mime },
          body: file,
        });
        if (!res.ok) throw new Error(`upload ${res.status}`);
        const { storageId } = (await res.json()) as { storageId: string };
        await addDoc({
          name: file.name,
          storageId: storageId as Id<"_storage">,
          mime,
          size: file.size,
          projectRowId: projectFilter ? (projectFilter as Id<"rows">) : undefined,
        });
      } catch (err) {
        console.error("doc upload failed", err);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  return (
    <div
      className="relative h-full overflow-y-auto"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto w-full max-w-4xl px-10 pb-24 pt-12">
        <div className="flex items-center gap-3 pb-1">
          <h1 className="flex flex-1 items-center gap-2 text-[28px] font-extrabold tracking-tight">
            <Folder size={24} className="text-accent" /> Docs
          </h1>
          {projectRows && projectRows.rows.length > 0 && (
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] outline-none"
            >
              <option value="">All files</option>
              {projectRows.rows.map((r) => (
                <option key={r._id} value={r._id}>
                  {r.title || "Untitled"}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13.5px] font-semibold text-white hover:bg-accent-2"
          >
            {uploading > 0 ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <p className="pb-6 text-[13px] text-ink-2">
          Drop files anywhere on this page. PDFs, images, audio, video, markdown, and code preview
          in-app{projectFilter ? " — uploads link to the selected project" : ""}.
        </p>

        {docs.length === 0 && uploading === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed py-20 text-ink-3",
              dragOver ? "border-accent bg-accent-soft" : "border-border"
            )}
          >
            <Upload size={26} />
            <p className="text-[14px]">Drop files here, or hit Upload</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {docs.map((d) => {
              const Icon = mimeIcon(d.mime);
              const project = projectRows?.rows.find((r) => r._id === d.projectRowId);
              return (
                <button
                  key={d._id}
                  onClick={() => setViewing(d as DocItem)}
                  className="group flex flex-col rounded-lg border border-border bg-surface p-3 text-left hover:border-accent"
                  style={{ boxShadow: "var(--shadow)" }}
                >
                  {d.mime.startsWith("image/") && d.url ? (
                    <div className="mb-2 h-24 w-full overflow-hidden rounded-md bg-hov">
                      <img src={d.url} alt="" className="h-full w-full object-cover" />
                    </div>
                  ) : (
                    <div className="mb-2 flex h-24 w-full items-center justify-center rounded-md bg-hov">
                      <Icon size={28} className="text-ink-3 group-hover:text-accent" />
                    </div>
                  )}
                  <span className="truncate text-[12.5px] font-medium">{d.name}</span>
                  <span className="pt-0.5 text-[11px] text-ink-3">
                    {fmtSize(d.size)} · {format(d._creationTime, "MMM d")}
                  </span>
                  {project && (
                    <span className="truncate pt-0.5 text-[10.5px] text-accent/80">
                      {project.title}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-4 border-dashed border-accent bg-accent-soft/60">
          <p className="rounded-xl bg-raised px-5 py-3 text-[16px] font-bold" style={{ boxShadow: "var(--shadow-lg)" }}>
            Drop to upload
          </p>
        </div>
      )}

      {viewing && (
        <DocViewer
          doc={viewing}
          projectRows={projectRows?.rows ?? []}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
