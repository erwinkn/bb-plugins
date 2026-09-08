import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { collectDiagnostics, diagnosticsLines, formatDiagnostics } from "../lib/diagnostics";
import type { QuoteMatch } from "../lib/quote-anchor";

interface DiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plan panel root; the document is looked up inside it when the dialog opens. */
  root: HTMLElement | null;
  anchors: Record<string, QuoteMatch>;
}

/**
 * A copyable report of the highlight and selection state on this device, for
 * the phone and WebView cases where nothing else can be inspected.
 */
export function DiagnosticsDialog({ open, onOpenChange, root, anchors }: DiagnosticsDialogProps) {
  const diagnostics = useMemo(
    () => (open ? collectDiagnostics(root?.querySelector<HTMLElement>(".plans-document") ?? null, anchors) : null),
    [open, root, anchors],
  );
  const copy = async () => {
    if (diagnostics === null) return;
    try {
      await navigator.clipboard.writeText(formatDiagnostics(diagnostics));
      toast.success("Copied diagnostics");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Diagnostics</DialogTitle>
          <DialogDescription>Highlight and selection support on this device. Paste the copy into the thread when something does not show.</DialogDescription>
        </DialogHeader>
        {diagnostics ? (
          <dl className="space-y-2 text-sm">
            {diagnosticsLines(diagnostics).map((line) => (
              <div key={line.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3">
                <dt className="text-muted-foreground">{line.label}</dt>
                <dd className={cn("min-w-0 break-words", line.problem && "text-destructive")}>
                  {line.value}
                  {line.problem ? <p className="mt-0.5 text-xs">{line.problem}</p> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void copy()}>
            <Icon name="Copy" className="size-4" aria-hidden />
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
