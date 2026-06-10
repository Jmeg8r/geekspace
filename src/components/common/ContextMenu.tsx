import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { MenuItem, MenuList, MenuSeparator } from "./Menu";

export interface CtxItem {
  icon?: LucideIcon;
  label: string;
  danger?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

interface CtxState {
  x: number;
  y: number;
  items: CtxItem[];
}

// WHAT: Right-click context menu — one global instance per usage site.
export function useContextMenu() {
  const [menu, setMenu] = useState<CtxState | null>(null);
  const open = (e: ReactMouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const close = () => setMenu(null);
  return { menu, open, close };
}

export function ContextMenuOverlay({
  menu,
  onClose,
}: {
  menu: CtxState | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, onClose]);

  if (!menu) return null;
  const width = 200;
  const x = Math.min(menu.x, window.innerWidth - width - 8);
  const estHeight = menu.items.length * 32 + 12;
  const y = Math.min(menu.y, window.innerHeight - estHeight - 8);

  return createPortal(
    <div className="fixed inset-0 z-[80]" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="fade-in absolute rounded-lg border border-border bg-raised"
        style={{ left: x, top: y, width, boxShadow: "var(--shadow-lg)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MenuList>
          {menu.items.map((item, i) =>
            item.separator ? (
              <MenuSeparator key={i} />
            ) : (
              <MenuItem
                key={i}
                icon={item.icon}
                label={item.label}
                danger={item.danger}
                onClick={() => {
                  onClose();
                  item.onClick?.();
                }}
              />
            )
          )}
        </MenuList>
      </div>
    </div>,
    document.body
  );
}
