import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Plan } from "../contract";
import { useContainerWidth, RAIL_BREAKPOINT_PX } from "../hooks/useContainerWidth";
import { usePlansApi } from "../hooks/usePlansApi";
import { useReviewDraft } from "../hooks/useReviewDraft";
import { clearDraft, isDraftEmpty, readDraft, type ReviewDraft } from "../lib/draft-store";
import { describeError } from "../lib/errors";
import {
  commentsForVersion,
  findVersion,
  latestVersion,
  sortedVersions,
  unresolvedComments,
} from "../lib/plan-model";
import type { QuoteMatch } from "../lib/quote-anchor";
import { CommentComposer, CommentRail, type CommentActions, type PendingComment } from "./CommentRail";
import { PlanChanges } from "./PlanChanges";
import { PlanDocument, type AnchorMap } from "./PlanDocument";
import { PlanHeader, type ReviewView } from "./PlanHeader";
import { ReviewFooter, type ReviewAction, type SubmitFailure } from "./ReviewFooter";
import { RevisionDialog } from "./RevisionDialog";

interface PlanReviewProps {
  plan: Plan;
  /** Receives every mutation result so the owner's cache stays authoritative. */
  onPlanChange: (plan: Plan) => void;
  onDeleted: () => void;
  onBack?: () => void;
  className?: string;
}

/**
 * The review workspace for one plan: header with version and view controls,
 * the document (or its changes) beside a comment rail on wide containers, and
 * the decision footer. Layout follows the container, so the same component
 * serves the full page, the thread side panel, and phones.
 */
export function PlanReview({
  plan,
  onPlanChange,
  onDeleted,
  onBack,
  className,
}: PlanReviewProps) {
  const api = usePlansApi();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(rootRef);
  const isWide = width !== null && width >= RAIL_BREAKPOINT_PX;

  const latest = latestVersion(plan);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const version = findVersion(plan, selectedVersionId) ?? latest;
  const [view, setView] = useState<ReviewView>("document");
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<AnchorMap>({});
  const [pendingMatch, setPendingMatch] = useState<QuoteMatch | null>(null);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState<ReviewAction | null>(null);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const requestIdRef = useRef<string | null>(null);

  // A new latest version (agent revision) takes over the view; an explicit
  // older selection stays until the user moves on.
  const latestId = latest?.id ?? null;
  const previousLatestRef = useRef(latestId);
  useEffect(() => {
    if (previousLatestRef.current !== latestId) {
      previousLatestRef.current = latestId;
      setSelectedVersionId(null);
      setActiveCommentId(null);
    }
  }, [latestId]);

  useEffect(() => {
    if (isWide && view === "comments") setView("document");
  }, [isWide, view]);

  const draftState = useReviewDraft(plan.id, version?.id ?? "none");
  const { draft, update: updateDraft, reset: resetDraft, persistFailed } = draftState;

  const comments = useMemo(
    () => (version ? commentsForVersion(plan, version.id) : []),
    [plan, version],
  );
  const isLatest = version !== null && latest !== null && version.id === latest.id;
  const isApproved = plan.status === "approved";
  const canEdit = isLatest && !isApproved && submitting === null;
  const blockers = useMemo(
    () => (version ? unresolvedComments(plan).filter((comment) => comment.versionId !== version.id) : []),
    [plan, version],
  );
  const blockerVersion = useMemo(() => {
    const first = blockers[0];
    return first ? findVersion(plan, first.versionId) : null;
  }, [blockers, plan]);

  // A note written for an older version stays keyed to it; surface it here
  // instead of letting it vanish when the agent's revision switches the view.
  const [dismissedRecovery, setDismissedRecovery] = useState<string | null>(null);
  const recovery = useMemo(() => {
    if (version === null) return null;
    for (const older of sortedVersions(plan)) {
      if (older.id === version.id || older.number > version.number) continue;
      const stored = readDraft(plan.id, older.id);
      if (!isDraftEmpty(stored) && dismissedRecovery !== older.id) return { version: older, draft: stored };
    }
    return null;
  }, [dismissedRecovery, plan, version]);

  const runMutation = useCallback(
    async (work: () => Promise<Plan>) => {
      const next = await work();
      onPlanChange(next);
      return next;
    },
    [onPlanChange],
  );

  const commentActions = useMemo<CommentActions>(
    () => ({
      update: async (commentId, body) => {
        await runMutation(() => api.call("updateComment", { id: plan.id, commentId, body }));
      },
      remove: async (commentId) => {
        await runMutation(() => api.call("removeComment", { id: plan.id, commentId }));
        setActiveCommentId((current) => (current === commentId ? null : current));
      },
    }),
    [api, plan.id, runMutation],
  );

  const setPending = useCallback(
    (pending: PendingComment | null) => updateDraft({ pendingComment: pending }),
    [updateDraft],
  );

  const submitPending = useCallback(
    async (pending: PendingComment) => {
      if (version === null) return;
      const next = await runMutation(() =>
        api.call("addComment", {
          id: plan.id,
          versionId: version.id,
          quote: pending.quote,
          body: pending.body,
        }),
      );
      updateDraft({ pendingComment: null });
      const added = next.comments.find(
        (comment) => !plan.comments.some((existing) => existing.id === comment.id),
      );
      if (added) setActiveCommentId(added.id);
      if (!isWide) setView("comments");
    },
    [api, isWide, plan.comments, plan.id, runMutation, updateDraft, version],
  );

  const submitReview = useCallback(
    async (action: ReviewAction) => {
      if (version === null) return;
      // One request id per attempt series: a retry after a failure reuses it so
      // the backend can deduplicate an agent message that did go through.
      requestIdRef.current ??= crypto.randomUUID();
      const requestId = requestIdRef.current;
      setSubmitting(action);
      setFailure(null);
      try {
        await runMutation(() =>
          api.call("submitReview", {
            id: plan.id,
            versionId: version.id,
            action,
            note: draft.note.trim(),
            requestId,
          }),
        );
        requestIdRef.current = null;
        resetDraft();
        toast.success(
          action === "approve"
            ? plan.sample
              ? "Sample plan approved"
              : "Approval sent to the thread"
            : plan.sample
              ? "Feedback recorded on the sample"
              : "Feedback sent to the thread",
        );
      } catch (cause) {
        setFailure({ message: describeError(cause), requestId, action });
      } finally {
        setSubmitting(null);
      }
    },
    [api, draft.note, plan.id, plan.sample, resetDraft, runMutation, version],
  );

  const submitRevision = useCallback(
    async (markdown: string) => {
      if (latest === null) return;
      await runMutation(() =>
        api.call("revise", { id: plan.id, markdown, expectedVersionId: latest.id }),
      );
      setSelectedVersionId(null);
      setView("changes");
    },
    [api, latest, plan.id, runMutation],
  );

  const adoptRecovery = useCallback(
    (from: { version: { id: string }; draft: ReviewDraft }) => {
      updateDraft((current) => ({
        note: [current.note.trim(), from.draft.note.trim()].filter(Boolean).join("\n\n"),
        pendingComment: current.pendingComment ?? from.draft.pendingComment,
      }));
      clearDraft(plan.id, from.version.id);
      setDismissedRecovery(from.version.id);
    },
    [plan.id, updateDraft],
  );

  const deletePlan = useCallback(async () => {
    try {
      await api.call("remove", { id: plan.id });
      toast.success("Plan deleted");
      onDeleted();
    } catch (cause) {
      toast.error(describeError(cause));
    }
  }, [api, onDeleted, plan.id]);

  if (version === null || latest === null) {
    return (
      <div className={cn("p-6 text-sm text-muted-foreground", className)}>This plan has no versions.</div>
    );
  }

  const pending = draft.pendingComment;

  return (
    <div ref={rootRef} className={cn("plans-review @container flex h-full min-h-0 flex-col bg-background", className)}>
      <PlanHeader
        plan={plan}
        version={version}
        onVersionChange={(id) => {
          setSelectedVersionId(id === latest.id ? null : id);
          setActiveCommentId(null);
        }}
        view={view}
        onViewChange={setView}
        showCommentsTab={!isWide}
        commentCount={comments.length}
        onBack={onBack}
        onRevise={() => setReviseOpen(true)}
        onDelete={() => setDeleteOpen(true)}
      />
      {!isLatest ? (
        <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
          <Icon name="Info" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Viewing v{version.number}, read-only.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setSelectedVersionId(null)}
          >
            Go to v{latest.number}
          </Button>
        </div>
      ) : blockers.length > 0 && !isApproved ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
          <Icon name="MessageSquare" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {blockers.length} open {blockers.length === 1 ? "comment" : "comments"} on{" "}
            {blockerVersion ? `v${blockerVersion.number}` : "an earlier version"} still{" "}
            {blockers.length === 1 ? "blocks" : "block"} approval.
          </span>
          <span className="flex items-center gap-1">
            {blockerVersion ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setSelectedVersionId(blockerVersion.id);
                  setActiveCommentId(blockers[0]?.id ?? null);
                  if (!isWide) setView("comments");
                }}
              >
                Show
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
      {recovery !== null && isLatest && !isApproved ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
          <Icon name="Edit" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            You have an unsent draft from v{recovery.version.number}
            {recovery.draft.note.trim() ? `: “${truncate(recovery.draft.note.trim(), 60)}”` : "."}
          </span>
          <span className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => adoptRecovery(recovery)}>
              Copy to v{version.number}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                clearDraft(plan.id, recovery.version.id);
                setDismissedRecovery(recovery.version.id);
              }}
            >
              Discard
            </Button>
          </span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Keep the rendered text index alive across tabs, including new comments. */}
          <div className={view === "document" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <PlanDocument
              visible={view === "document"}
              markdown={version.markdown}
              comments={comments}
              activeCommentId={activeCommentId}
              canComment={canEdit}
              pendingQuote={pending?.quote ?? null}
              onPendingMatch={setPendingMatch}
              onAnnotate={async (quote, kind) => {
                try {
                  await runMutation(() => api.call("addComment", { id: plan.id, versionId: version.id, quote, kind, body: "" }));
                } catch (error) { toast.error(describeError(error)); }
              }}
              onQuote={(quote) => {
                setPending({ quote, body: pending?.quote === quote ? pending.body : "" });
                setActiveCommentId(null);
              }}
              onActivateComment={(id) => {
                setActiveCommentId(id);
                if (!isWide && id !== null) setView("comments");
              }}
              onAnchorsChange={setAnchors}
            />
          </div>
          {view === "changes" ? (
            <PlanChanges plan={plan} version={version} isWide={isWide} />
          ) : view === "comments" ? (
            <CommentRail
              comments={comments}
              anchors={anchors}
              activeCommentId={activeCommentId}
              onActivate={(id) => {
                setActiveCommentId(id);
                if (id !== null) setView("document");
              }}
              actions={commentActions}
              canEdit={!isApproved && submitting === null}
              pending={pending}
              pendingMatch={pendingMatch}
              onPendingChange={setPending}
              onPendingSubmit={submitPending}
              showComposer={false}
              showHeader={false}
            />
          ) : null}
        </div>
        {isWide ? (
          <aside className="flex w-80 shrink-0 flex-col border-l border-border" aria-label="Comments">
            <CommentRail
              comments={comments}
              anchors={anchors}
              activeCommentId={activeCommentId}
              onActivate={setActiveCommentId}
              actions={commentActions}
              canEdit={!isApproved && submitting === null}
              pending={pending}
              pendingMatch={pendingMatch}
              onPendingChange={setPending}
              onPendingSubmit={submitPending}
              showComposer
              emptyMessage={view === "changes" && canEdit ? "Open Document to comment on the text." : undefined}
            />
          </aside>
        ) : null}
      </div>
      {isLatest ? (
        <ReviewFooter
          plan={plan}
          versionId={version.id}
          note={draft.note}
          onNoteChange={(note) => updateDraft({ note })}
          persistFailed={persistFailed}
          submitting={submitting}
          failure={failure}
          onSubmit={(action) => void submitReview(action)}
          onDismissFailure={() => setFailure(null)}
          confirmOpen={confirmOpen}
          onConfirmOpenChange={setConfirmOpen}
          onRevise={() => setReviseOpen(true)}
        />
      ) : null}

      {!isWide ? (
        <Dialog open={pending !== null && view === "document"} onOpenChange={(open) => !open && setPending(null)}>
          <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>New comment</DialogTitle>
            </DialogHeader>
            {pending ? (
              <CommentComposer
                pending={pending}
                match={pendingMatch}
                onChange={setPending}
                onCancel={() => setPending(null)}
                onSubmit={submitPending}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}

      <RevisionDialog
        plan={plan}
        latest={latest}
        open={reviseOpen}
        onOpenChange={setReviseOpen}
        onSubmit={submitRevision}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{plan.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              All {plan.versions.length} {plan.versions.length === 1 ? "version" : "versions"} and{" "}
              {plan.comments.length} {plan.comments.length === 1 ? "comment" : "comments"} are removed.
              The linked thread is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void deletePlan()}
            >
              Delete plan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
