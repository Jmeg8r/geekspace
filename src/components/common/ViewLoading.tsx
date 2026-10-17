import { Loader2 } from "lucide-react";

/** Shown while a lazily loaded view or the editor arrives (a local read, usually a frame or two). */
export function ViewLoading() {
  return (
    <div className="flex h-full min-h-24 items-center justify-center text-ink-3" role="status" aria-label="Loading">
      <Loader2 size={18} className="animate-spin" />
    </div>
  );
}
