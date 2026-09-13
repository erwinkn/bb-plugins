import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PlanComment } from "../contract";
import { isDelivered, stateLabel } from "../lib/plan-model";
import { formatRelativeTime } from "../lib/time";
import type { QuoteContext, QuoteMatch } from "../lib/quote-anchor";
import type { AnchorMap } from "./PlanDocument";
import { CommentBody, KindBadge, kindOf, Quote } from "./CommentKind";

export interface PendingComment extends QuoteContext {
  versionId?: string;
  quote: string;
  body: string;
  kind?: "comment" | "ask";
}

export interface CommentActions {
  update: (commentId: string, body: string) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
  resolve: (commentId: string) => Promise<void>;
  reply: (commentId: string, body: string) => Promise<void>;
}

interface CommentRailProps {
  comments: PlanComment[];
  failedAnnotations?: ReadonlySet<string>;
  /** In a queued message the user deleted before dispatch; not resent. */
  cancelledAnnotations?: ReadonlySet<string>;
  anchors: AnchorMap;
  activeCommentId: string | null;
  onActivate: (commentId: string | null) => void;
  /** Hover is shared with the document so either side lights up the other. */
  hoveredCommentId?: string | null;
  onHover?: (commentId: string | null) => void;
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
  failedAnnotations,
  cancelledAnnotations,
  anchors,
  activeCommentId,
  onActivate,
  hoveredCommentId = null,
  onHover,
  actions,
  canEdit,
  pending,
  showHeader = true,
  emptyMessage,
  className,
}: CommentRailProps) {
  const open = comments.filter((comment) => comment.state === "open").length;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {showHeader ? (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Comments
          </h2>
          {comments.length > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {open > 0 ? `${open} open · ` : ""}
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
                  failed={failedAnnotations?.has(comment.id) ?? false}
                  cancelled={cancelledAnnotations?.has(comment.id) ?? false}
                  anchor={anchors[comment.id]}
                  isActive={comment.id === activeCommentId}
                  isHovered={comment.id === hoveredCommentId}
                  onActivate={() => onActivate(comment.id === activeCommentId ? null : comment.id)}
                  onHover={onHover}
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
  match,
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
      await onSubmit({ ...pending, body: pending.body.trim() });
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
      {match?.kind === "missing" ? <p className="text-xs text-muted-foreground">The quoted text changed.</p> : null}
      <Textarea
        ref={textareaRef}
        value={pending.body}
        onChange={(event) => onChange({ ...pending, body: event.target.value })}
        onKeyDown={onKeyDown}
        placeholder={pending.kind === "ask" ? "What do you want to know?" : "What should change here?"}
        aria-label={pending.kind === "ask" ? "Ask" : "Comment"}
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
          {pending.kind === "ask" ? "Add ask" : "Add comment"}
        </Button>
      </div>
    </form>
  );
}

function anchorNote(anchor: QuoteMatch | undefined): string | null {
  if (anchor?.kind === "ambiguous")
    return `This passage appears ${anchor.count} times, so it is not highlighted.`;
  if (anchor?.kind === "missing") return "Text changed";
  return null;
}

interface CommentCardProps {
  comment: PlanComment;
  failed: boolean;
  cancelled: boolean;
  anchor?: QuoteMatch;
  isActive: boolean;
  isHovered: boolean;
  onActivate: () => void;
  onHover?: (commentId: string | null) => void;
  actions: CommentActions;
  canEdit: boolean;
}

function CommentCard({ comment, failed, cancelled, anchor, isActive, isHovered, onActivate, onHover, actions, canEdit }: CommentCardProps) {
  const [isEditing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [isReplying, setReplying] = useState(false);
  const replyButtonRef = useRef<HTMLButtonElement>(null);
  const restoreReplyFocus = useRef(false);
  const withdrawn = comment.state === "withdrawn";
  const isDraft = !isDelivered(comment);
  const actionable = canEdit && !withdrawn;
  const editable = isDraft && actionable;
  useEffect(() => { if (!editable) setEditing(false); }, [editable]);
  const kind = kindOf(comment);
  const note = anchorNote(anchor);
  const closeReply = () => {
    restoreReplyFocus.current = true;
    setReplying(false);
  };
  useEffect(() => {
    if (!isReplying && !isBusy && restoreReplyFocus.current) {
      replyButtonRef.current?.focus();
      restoreReplyFocus.current = false;
    }
  }, [isReplying, isBusy]);

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
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") onHover?.(comment.id);
      }}
      onPointerLeave={() => onHover?.(null)}
      className={cn(
        "group relative space-y-1.5 px-3 py-2.5 transition-colors duration-150",
        withdrawn && "opacity-50 [&_blockquote]:line-through",
        isActive && "bg-state-active",
        isHovered && !isActive && "bg-state-hover",
      )}
    >
      {withdrawn ? <Quote text={comment.quote} kind={kind} /> : <button
        type="button"
        onClick={onActivate}
        className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={anchor === undefined || anchor.kind === "unique" ? "Show this passage in the plan" : "Select comment"}
      >
        <Quote text={comment.quote} kind={kind} />
      </button>}
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
      ) : comment.body ? (
        <CommentBody body={comment.body} className="text-sm leading-5" />
      ) : null}
      <div className="flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">#{comment.number}</span>
        <KindBadge kind={kind} />
        <span className="rounded border border-border px-1 text-[11px]">
          {withdrawn ? "Withdrawn" : failed ? "Not delivered · retrying" : cancelled ? "Not delivered · cancelled" : stateLabel(comment)}
        </span>
        <span aria-hidden>·</span>
        <time dateTime={new Date(comment.createdAt).toISOString()}>
          {formatRelativeTime(comment.createdAt)}
        </time>
        {actionable && !isEditing ? (
          <span
            className={cn(
              "ml-auto flex items-center gap-0.5 transition-opacity duration-150",
              "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100",
              isActive && "pointer-fine:opacity-100",
            )}
          >
            {editable ? (
              <IconAction
                label="Edit comment"
                icon="Edit"
                disabled={isBusy}
                onClick={() => { setBody(comment.body); setEditing(true); }}
              />
            ) : null}
            <IconAction
              label={isDraft ? "Delete comment" : "Withdraw comment"}
              icon="Trash2"
              disabled={isBusy}
              onClick={() => void run(() => actions.remove(comment.id))}
            />
          </span>
        ) : null}
      </div>
      {comment.replies.map((item) => (
        <div key={item.id} className="ml-2 space-y-1 border-l border-border py-1 pl-2 text-sm">
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span>{item.author === "agent" ? "Agent" : "You"}</span>
            <time dateTime={new Date(item.createdAt).toISOString()}>{formatRelativeTime(item.createdAt)}</time>
          </div>
          <CommentBody body={item.body} />
        </div>
      ))}
      {actionable && !isEditing ? (
        <div className="flex items-center gap-1">
          <Button ref={replyButtonRef} type="button" variant="ghost" size="sm"
            className="h-7 px-2 text-xs text-muted-foreground pointer-coarse:min-h-11"
            aria-expanded={isReplying} disabled={isBusy} onClick={() => setReplying(true)}>
            Reply
          </Button>
          {comment.state === "open" && kind !== "looksGood" ? (
            <Button type="button" variant="ghost" size="sm"
              className="h-7 px-2 text-xs text-muted-foreground pointer-coarse:min-h-11"
              disabled={isBusy} onClick={() => void run(() => actions.resolve(comment.id))}>
              Resolve
            </Button>
          ) : null}
        </div>
      ) : null}
      {actionable && !isEditing && isReplying ? (
        <form className="space-y-1" onSubmit={(event) => {
          event.preventDefault();
          if (!reply.trim() || isBusy) return;
          void run(async () => { await actions.reply(comment.id, reply.trim()); setReply(""); closeReply(); });
        }}>
          <Textarea aria-label={`Reply to #${comment.number}`} placeholder="Reply…" rows={1}
            autoFocus
            className="min-h-9 resize-none" value={reply} disabled={isBusy}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault(); closeReply();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault(); event.currentTarget.form?.requestSubmit();
              }
            }} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" disabled={isBusy} onClick={closeReply}>Cancel</Button>
            <Button size="sm" type="submit" disabled={isBusy || !reply.trim()}>Send</Button>
          </div>
        </form>
      ) : null}
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
