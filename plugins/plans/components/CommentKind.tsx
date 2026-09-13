import { Markdown } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { PlanComment } from "../contract";

export type CommentKind = NonNullable<PlanComment["kind"]>;

/** Colors and labels follow the document highlights for the same kind. */
export const KIND_STYLE: Record<
  CommentKind,
  { border: string; text: string; icon: "X" | "Check" | null; label: string | null }
> = {
  comment: { border: "border-warning", text: "", icon: null, label: "Comment" },
  ask: { border: "border-primary", text: "text-primary", icon: null, label: "Ask" },
  redline: { border: "border-destructive", text: "text-destructive", icon: "X", label: "Redline" },
  looksGood: { border: "border-success", text: "text-success", icon: "Check", label: "Looks good" },
};

export function kindOf(comment: PlanComment): CommentKind {
  return comment.kind ?? "comment";
}

export function Quote({ text, kind }: { text: string; kind: CommentKind }) {
  return (
    <blockquote
      className={cn(
        "border-l-2 pl-2.5 text-xs leading-5 text-muted-foreground",
        KIND_STYLE[kind].border,
        kind === "redline" && "line-through decoration-destructive/50",
      )}
    >
      <span className="line-clamp-2 break-words">{text}</span>
    </blockquote>
  );
}

export function KindBadge({ kind }: { kind: CommentKind }) {
  const style = KIND_STYLE[kind];
  if (style.label === null) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", style.text)}>
      {style.icon ? <Icon name={style.icon} className="size-3" aria-hidden /> : null}
      {style.label}
    </span>
  );
}

/**
 * A comment or reply body. It renders through the host Markdown renderer like
 * the plan itself; code blocks scroll inside the card instead of widening it.
 */
export function CommentBody({ body, className }: { body: string; className?: string }) {
  return (
    <Markdown
      content={body}
      className={cn("min-w-0 break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto", className)}
    />
  );
}
