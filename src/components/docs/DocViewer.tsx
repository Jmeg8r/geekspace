import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { Eye, Loader2, Trash2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { RowDoc } from "../../lib/viewLogic";
import { cn } from "../../lib/utils";

export type DocItem = Doc<"docs"> & { url: string | null };

interface QuickLookBridge {
  quickLook(url: string, name: string): Promise<{ ok: boolean; error?: string }>;
}
const quickLookBridge = () =>
  (window as { geekspace?: { docs?: QuickLookBridge } }).geekspace?.docs;

// WHAT: Slide-over viewer — native rendering for the common types, Quick Look
// for everything else.
export function DocViewer({
  doc,
  projectRows,
  onClose,
}: {
  doc: DocItem;
  projectRows: RowDoc[];
  onClose: () => void;
}) {
  const removeDoc = useMutation(api.docs.remove);
  const setProject = useMutation(api.docs.setProject);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const m = doc.mime;
  const isText =
    m.startsWith("text/") || /json|yaml|xml|javascript|typescript|x-sh|x-python|csv/.test(m);

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="fade-in flex h-full w-[min(720px,92vw)] flex-col border-l border-border bg-surface"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-bold">{doc.name}</div>
            <div className="text-[11.5px] text-ink-3">{doc.mime}</div>
          </div>
          <select
            value={doc.projectRowId ?? ""}
            onChange={(e) =>
              void setProject({
                docId: doc._id,
                projectRowId: e.target.value ? (e.target.value as Id<"rows">) : undefined,
              })
            }
            className="max-w-44 rounded-md border border-border bg-surface px-1.5 py-1 text-[12px] outline-none"
            title="Link to a project"
          >
            <option value="">No project</option>
            {projectRows.map((r) => (
              <option key={r._id} value={r._id}>
                {r.title || "Untitled"}
              </option>
            ))}
          </select>
          {quickLookBridge() && doc.url && (
            <button
              title="Open with the default macOS app"
              onClick={() => void quickLookBridge()!.quickLook(doc.url!, doc.name)}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-ink-2 hover:bg-hov hover:text-ink"
            >
              <Eye size={13} /> Open
            </button>
          )}
          <button
            title="Delete file"
            onClick={() => {
              if (confirm(`Delete "${doc.name}"? The file is removed from storage.`)) {
                onClose();
                void removeDoc({ docId: doc._id });
              }
            }}
            className="rounded-md p-1.5 text-ink-3 hover:bg-hov hover:text-[var(--pal-red)]"
          >
            <Trash2 size={14} />
          </button>
          <button onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-hov hover:text-ink">
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-bg">
          {!doc.url ? (
            <Empty>File URL unavailable</Empty>
          ) : m.startsWith("image/") ? (
            <div className="flex min-h-full items-center justify-center p-6">
              <img src={doc.url} alt={doc.name} className="max-h-full max-w-full rounded-lg" />
            </div>
          ) : m === "application/pdf" ? (
            <embed src={doc.url} type="application/pdf" className="h-full w-full" />
          ) : m.startsWith("video/") ? (
            <div className="flex min-h-full items-center justify-center p-6">
              <video src={doc.url} controls className="max-h-full max-w-full rounded-lg" />
            </div>
          ) : m.startsWith("audio/") ? (
            <div className="flex min-h-full items-center justify-center p-6">
              <audio src={doc.url} controls className="w-full max-w-md" />
            </div>
          ) : isText ? (
            <TextPreview url={doc.url} markdown={m === "text/markdown"} />
          ) : (
            <Empty>
              No in-app preview for this type — use <b>Open</b> to view it in its native app.
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-ink-3">
      <p>{children}</p>
    </div>
  );
}

function TextPreview({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => !cancelled && setText(t.slice(0, 200_000)))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) return <Empty>Couldn't load file contents</Empty>;
  if (text === null)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={18} className="animate-spin text-ink-3" />
      </div>
    );
  return markdown ? (
    <MdLite text={text} />
  ) : (
    <pre className="whitespace-pre-wrap break-words p-6 font-mono text-[12.5px] leading-relaxed">
      {text}
    </pre>
  );
}

/** Tiny markdown renderer — headings, lists, code fences, bold; links shown as text. */
function MdLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        out.push(
          <pre key={`c${i}`} className="my-2 overflow-x-auto rounded-md bg-hov p-3 font-mono text-[12px]">
            {codeBuf.join("\n")}
          </pre>
        );
        codeBuf = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) {
      codeBuf.push(line);
      return;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const strip = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
    if (h) {
      const level = h[1].length;
      out.push(
        <div
          key={i}
          className={cn(
            "font-bold",
            level === 1 ? "pt-4 text-[22px]" : level === 2 ? "pt-3 text-[17px]" : "pt-2 text-[14.5px]"
          )}
        >
          {strip(h[2])}
        </div>
      );
    } else if (/^\s*[-*]\s+/.test(line)) {
      out.push(
        <div key={i} className="flex gap-2 pl-2 text-[13.5px] leading-relaxed">
          <span className="text-ink-3">•</span>
          <span>{strip(line.replace(/^\s*[-*]\s+/, ""))}</span>
        </div>
      );
    } else if (line.trim() === "") {
      out.push(<div key={i} className="h-2" />);
    } else {
      out.push(
        <p key={i} className="text-[13.5px] leading-relaxed">
          {strip(line)}
        </p>
      );
    }
  });
  return <div className="mx-auto max-w-2xl p-6">{out}</div>;
}
