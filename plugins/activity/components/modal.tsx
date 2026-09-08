import { useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { usePortalScopeProps } from "../lib/portal-scope";

export const modalButtonClass =
  "rounded-md px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const modalPrimaryClass =
  "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const modalInputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

// One dialog shell for the plugin: centered on desktop, a full-screen sheet on
// phones. Radix owns focus, Escape, and the backdrop click.
export function Modal({
  open,
  onClose,
  title,
  description,
  compact,
  wide = false,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  compact: boolean;
  /** Two-pane content; ignored on phones. */
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const scope = usePortalScopeProps();
  const body = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          {...scope}
          className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <Dialog.Content
          {...scope}
          data-activity-modal=""
          // Radix would focus the first tabbable element, the Close button.
          // Start in the first field instead when there is one.
          onOpenAutoFocus={(event) => {
            const field = body.current?.querySelector<HTMLElement>(
              "input:not([type=checkbox]), select, textarea",
            );
            if (!field) return;
            event.preventDefault();
            field.focus();
            if (field instanceof HTMLInputElement) field.select();
          }}
          className={`fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-xl outline-none ${
            compact
              ? "inset-0"
              : `left-1/2 top-1/2 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border ${
                  wide ? "w-[min(92vw,720px)]" : "w-[min(92vw,420px)]"
                }`
          }`}
        >
          <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">
                  {title}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="size-4"
              >
                <path d="m4 4 8 8m0-8-8 8" />
              </svg>
            </Dialog.Close>
          </div>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </div>
          {footer && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
