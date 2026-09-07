import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PlanComment } from "../contract";
import { formatRelativeTime } from "../lib/time";
import type { QuoteMatch } from "../lib/quote-anchor";
import type { AnchorMap } from "./PlanDocument";

export interface PendingComment {
  quote: string;
  body: string;
}

export interface CommentActions {
  update: (commentId: string, body: string) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
}

interface CommentRailProps {
  comments: PlanComment[];
  anchors: AnchorMap;
  activeCommentId: string | null;
  onActivate: (commentId: string | null) => void;
  actions: CommentActions;
  /** Editing and deleting unsent comments on an unapproved plan. */
  canEdit: boolean;
  /** A comment being composed elsewhere; keeps the empty prompt out of the way. */
  pending: PendingComment | null;
  /** Off when a tab already names the rail. */
  showHeader?: boolean;
  /** Copy for the empty rail; defaults to the select-text prompt. */
  emptyMessage?: string;
  className?: string;
}

export function CommentRail({
  comments,
  anchors,
  activeCommentId,
  onActivate,
  actions,
  canEdit,
  pending,
  showHeader = true,
  emptyMessage,
  className,
}: CommentRailProps) {
  const unresolved = comments.filter((comment) => !comment.resolved && comment.kind !== "looksGood").length;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {showHeader ? (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Comments
          </h2>
          {comments.length > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {unresolved > 0 ? `${unresolved} open · ` : ""}
              {comments.length} total
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {comments.length === 0 && pending === null ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {emptyMessage ??
              (canEdit
                ? "Select text in the plan to leave a comment."
                : "No comments on this version.")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {comments.map((comment) => (
              <li key={comment.id}>
                <CommentCard
                  comment={comment}
                  anchor={anchors[comment.id]}
                  isActive={comment.id === activeCommentId}
                  onActivate={() => onActivate(comment.id === activeCommentId ? null : comment.id)}
                  actions={actions}
                  canEdit={canEdit}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface CommentComposerProps {
  pending: PendingComment;
  /** Where the quote sits in the document; null while unknown. */
  match: QuoteMatch | null;
  onChange: (pending: PendingComment) => void;
  onCancel: () => void;
  onSubmit: (pending: PendingComment) => Promise<void>;
  autoFocus?: boolean;
}

export function CommentComposer({
  pending,
  onChange,
  onCancel,
  onSubmit,
  autoFocus = true,
}: CommentComposerProps) {
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = pending.body.trim().length > 0 && !isSubmitting;

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ quote: pending.quote, body: pending.body.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        ref={textareaRef}
        value={pending.body}
        onChange={(event) => onChange({ ...pending, body: event.target.value })}
        onKeyDown={onKeyDown}
        placeholder="What should change here?"
        aria-label="Comment"
        rows={3}
        className="min-h-[4.5rem] resize-none"
        disabled={isSubmitting}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isSubmitting ? <Icon name="Loading" className="size-3.5 animate-spin" aria-hidden /> : null}
          Add comment
        </Button>
      </div>
    </form>
  );
}

type CommentKind = NonNullable<PlanComment["kind"]>;

/** Colors and labels follow the document highlights for the same kind. */
const KIND_STYLE: Record<
  CommentKind,
  { border: string; text: string; icon: "X" | "Check" | null; label: string | null }
> = {
  comment: { border: "border-warning", text: "", icon: null, label: null },
  redline: { border: "border-destructive", text: "text-destructive", icon: "X", label: "Redline" },
  looksGood: { border: "border-success", text: "text-success", icon: "Check", label: "Looks good" },
};

function kindOf(comment: PlanComment): CommentKind {
  return comment.kind ?? "comment";
}

function Quote({ text, kind, muted }: { text: string; kind: CommentKind; muted?: boolean }) {
  return (
    <blockquote
      className={cn(
        "border-l-2 pl-2.5 text-xs leading-5 text-muted-foreground",
        muted ? "border-border" : KIND_STYLE[kind].border,
        kind === "redline" && !muted && "line-through decoration-destructive/50",
      )}
    >
      <span className="line-clamp-2 break-words">{text}</span>
    </blockquote>
  );
}

function KindBadge({ kind }: { kind: CommentKind }) {
  const style = KIND_STYLE[kind];
  if (style.label === null || style.icon === null) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", style.text)}>
      <Icon name={style.icon} className="size-3" aria-hidden />
      {style.label}
    </span>
  );
}

function anchorNote(anchor: QuoteMatch | undefined): string | null {
  if (anchor?.kind === "ambiguous")
    return `This passage appears ${anchor.count} times, so it is not highlighted.`;
  if (anchor?.kind === "missing") return "This passage is not in the displayed version.";
  return null;
}

interface CommentCardProps {
  comment: PlanComment;
  anchor?: QuoteMatch;
  isActive: boolean;
  onActivate: () => void;
  actions: CommentActions;
  canEdit: boolean;
}

function CommentCard({ comment, anchor, isActive, onActivate, actions, canEdit }: CommentCardProps) {
  const [isEditing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDraft = comment.sentAt === null;
  const editable = isDraft && canEdit;
  const kind = kindOf(comment);
  const note = anchorNote(anchor);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "group relative space-y-1.5 px-3 py-2.5 transition-colors duration-150",
        isActive && "bg-state-active",
        comment.resolved && !isActive && "opacity-70",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={anchor === undefined || anchor.kind === "unique" ? "Show this passage in the plan" : "Select comment"}
      >
        <Quote text={comment.quote} kind={kind} muted={comment.resolved} />
      </button>
      {note ? <p className="text-[11px] leading-4 text-muted-foreground">{note}</p> : null}
      {isEditing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await actions.update(comment.id, body.trim());
              setEditing(false);
            });
          }}
        >
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Edit comment"
            rows={3}
            className="min-h-[4.5rem] resize-none"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setBody(comment.body);
                setEditing(false);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setBody(comment.body);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isBusy || body.trim() === ""}>
              Save
            </Button>
          </div>
        </form>
      ) : kind === "comment" ? (
        <p className={cn("whitespace-pre-wrap break-words text-sm leading-5", comment.resolved && "text-muted-foreground")}>
          {comment.body}
        </p>
      ) : null}
      <div className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
        {kind !== "comment" ? (
          <>
            <KindBadge kind={kind} />
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span className={cn(isDraft && "text-foreground")}>{isDraft ? "Draft" : "Sent"}</span>
        <span aria-hidden>·</span>
        <time dateTime={new Date(comment.createdAt).toISOString()}>
          {formatRelativeTime(comment.createdAt)}
        </time>
        {editable && !isEditing ? (
          <span
            className={cn(
              "ml-auto flex items-center gap-0.5 transition-opacity duration-150",
              "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100",
              isActive && "pointer-fine:opacity-100",
            )}
          >
            {kind === "comment" ? (
              <IconAction
                label="Edit comment"
                icon="Edit"
                disabled={isBusy}
                onClick={() => setEditing(true)}
              />
            ) : null}
            <IconAction
              label="Delete comment"
              icon="Trash2"
              disabled={isBusy}
              onClick={() => void run(() => actions.remove(comment.id))}
            />
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function IconAction({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: "Edit" | "Trash2";
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="size-7 text-muted-foreground [&_svg]:size-3.5"
    >
      <Icon name={icon} aria-hidden />
    </Button>
  );
}
