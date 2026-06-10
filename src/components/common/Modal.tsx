import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

export function Modal({
  onClose,
  children,
  width = "min(680px, 92vw)",
  showClose = true,
  top = "10vh",
}: {
  onClose: () => void;
  children: ReactNode;
  width?: string;
  showClose?: boolean;
  top?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn("fade-in absolute left-1/2 -translate-x-1/2 rounded-xl border border-border bg-surface")}
        style={{ width, top, boxShadow: "var(--shadow-lg)", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
      >
        {showClose && (
          <button
            onClick={onClose}
            className="absolute right-3 top-3 z-10 rounded-md p-1 text-ink-3 hover:bg-hov hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
