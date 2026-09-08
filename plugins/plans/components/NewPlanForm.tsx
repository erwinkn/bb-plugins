import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Plan } from "../contract";
import { usePlansApi } from "../hooks/usePlansApi";
import { describeError } from "../lib/errors";

interface NewPlanFormProps {
  /** A thread the plan is bound to; the field is fixed when supplied. */
  threadId: string;
  onCreated: (plan: Plan) => void;
  onCancel?: () => void;
  className?: string;
}

function guessTitle(markdown: string): string {
  const heading = markdown.match(/^\s*#\s+(.+?)\s*$/m);
  return heading?.[1]?.trim() ?? "";
}

/** Creates a plan from pasted Markdown, linked to the agent thread it came from. */
export function NewPlanForm({ threadId, onCreated, onCancel, className }: NewPlanFormProps) {
  const api = usePlansApi();
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveTitle = title.trim() || guessTitle(markdown);
  const canSubmit = effectiveTitle !== "" && threadId !== "" && markdown.trim() !== "" && !isSubmitting;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const plan = await api.call("create", {
        title: effectiveTitle,
        markdown,
        threadId: threadId,
      });
      onCreated(plan);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cn("h-full min-h-0 overflow-y-auto", className)}>
      <form onSubmit={submit} className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-5 md:px-6">
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="icon" className="-ml-2 size-8" aria-label="Back" onClick={onCancel}>
              <Icon name="ChevronLeft" aria-hidden />
            </Button>
          ) : null}
          <div>
            <h1 className="text-base font-semibold text-foreground">New plan</h1>
            <p className="text-sm text-muted-foreground">
              Paste a plan an agent wrote. Feedback and approval go back to its thread.
            </p>
          </div>
        </div>
        <Field label="Plan" hint="Markdown. The first heading becomes the title unless you set one.">
          <Textarea
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            placeholder={"# Title\n\n## Goal\n…"}
            aria-label="Plan Markdown"
            spellCheck={false}
            required
            className="min-h-[16rem] font-mono text-xs leading-5"
          />
        </Field>
        <Field label="Title">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={guessTitle(markdown) || "Short name for the plan"}
            aria-label="Plan title"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pb-[env(safe-area-inset-bottom)]">
          <Button type="submit" disabled={!canSubmit}>
            {isSubmitting ? <Icon name="Loading" className="size-4 animate-spin" aria-hidden /> : null}
            Create plan
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
