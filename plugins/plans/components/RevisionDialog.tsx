import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import type { Plan, PlanVersion } from "../contract";
import { SAMPLE_PLAN_REVISION } from "../lib/sample-plan";

interface RevisionDialogProps {
  plan: Plan;
  latest: PlanVersion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (markdown: string) => Promise<void>;
}

/**
 * Adds a version by pasting Markdown. For a sample plan the field starts with
 * a prepared revision so the diff view has something to show; for a real plan
 * it starts from the latest text so a paste replaces it wholesale.
 */
export function RevisionDialog({ plan, latest, open, onOpenChange, onSubmit }: RevisionDialogProps) {
  const [markdown, setMarkdown] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMarkdown(plan.sample && latest.number === 1 ? SAMPLE_PLAN_REVISION : latest.markdown);
    setError(null);
  }, [open, plan.sample, latest]);

  const unchanged = markdown.trim() === latest.markdown.trim();
  const canSubmit = markdown.trim() !== "" && !unchanged && !isSubmitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(markdown);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isSubmitting && onOpenChange(next)}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{plan.sample ? "Add a revision" : "Import a revision"}</DialogTitle>
          <DialogDescription>
            {plan.sample
              ? "Edit the text below and save it as the next version. A prepared revision is filled in."
              : `Paste the agent's revised plan. It becomes v${latest.number + 1}.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="min-h-0 flex-1 px-5 py-4">
            <Textarea
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              aria-label="Revised plan Markdown"
              spellCheck={false}
              disabled={isSubmitting}
              className="h-[45vh] min-h-[12rem] resize-none font-mono text-xs leading-5"
            />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : unchanged ? (
              <p className="mt-2 text-xs text-muted-foreground">The text matches v{latest.number}.</p>
            ) : null}
          </div>
          <DialogFooter className="border-t border-border px-5 py-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? <Icon name="Loading" className="size-4 animate-spin" aria-hidden /> : null}
              Save as v{latest.number + 1}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
