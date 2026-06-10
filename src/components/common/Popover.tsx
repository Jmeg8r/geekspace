import { useState, type ReactNode } from "react";
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  type Placement,
} from "@floating-ui/react";
import { cn } from "../../lib/utils";

interface PopoverProps {
  /** Render the trigger element; spread `props` onto it. */
  trigger: (props: Record<string, unknown>, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: Placement;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

// WHAT: The one popover primitive used everywhere (cell editors, menus, pickers).
export function Popover({ trigger, children, placement = "bottom-start", className, onOpenChange }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const handleOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: handleOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

  return (
    <>
      {trigger({ ref: refs.setReference, ...getReferenceProps() }, open)}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 70 }}
            {...getFloatingProps()}
            className={cn(
              "fade-in min-w-44 max-h-[70vh] overflow-auto rounded-lg border border-border bg-raised",
              className
            )}
          >
            <div style={{ boxShadow: "var(--shadow-lg)" }} className="rounded-lg">
              {children(() => handleOpen(false))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
