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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { cn } from "@/lib/utils";
import type { Plan } from "../contract";
import { useContainerWidth, RAIL_BREAKPOINT_PX } from "../hooks/useContainerWidth";
import { usePlansApi } from "../hooks/usePlansApi";
import { useReviewDraft } from "../hooks/useReviewDraft";
import { readLastSeen, writeLastSeen, readShownNotice, writeShownNotice } from "../lib/seen-store";
import { useDeliveryStatus } from "../hooks/useDeliveryStatus";
import { describeError } from "../lib/errors";
import {
  commentsForVersion,
  findVersion,
  latestVersion,
} from "../lib/plan-model";
import { definedContext, type QuoteMatch } from "../lib/quote-anchor";
import { CommentComposer, CommentRail, type CommentActions, type PendingComment } from "./CommentRail";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { ShortcutCheatSheet } from "./ShortcutCheatSheet";
import { PlanChanges } from "./PlanChanges";
import { PlanDocument, type AnchorMap } from "./PlanDocument";
import { PlanHeader, type ReviewView } from "./PlanHeader";
import { ReviewFooter, type ReviewAction, type SubmitFailure } from "./ReviewFooter";

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
  // Phones get a sheet for the composer; every other layout anchors it to the text.
  const isCompact = useIsCompactViewport();
  const isCoarse = usePointerCoarse();
  const isMobile = isCompact || isCoarse;

  const latest = latestVersion(plan);
  const delivery = useDeliveryStatus(plan.id, plan.status);
  const seenRef = useRef(readLastSeen(plan.id));
  const [changesBase, setChangesBase] = useState(seenRef.current);
  const [agentUpdate, setAgentUpdate] = useState<typeof latest>(() => {
    const seen = findVersion(plan, seenRef.current);
    return seen && latest && latest.number > seen.number && latest.source === "agent" ? latest : null;
  });
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const version = findVersion(plan, selectedVersionId) ?? latest;
  const [view, setView] = useState<ReviewView>("document");
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<AnchorMap>({});
  const [pendingMatch, setPendingMatch] = useState<QuoteMatch | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
      setChangesBase(seenRef.current);
      if (latest?.source === "agent") setAgentUpdate(latest);
      previousLatestRef.current = latestId;
      setSelectedVersionId(null);
      setActiveCommentId(null);
    }
  }, [latestId, latest]);

  useEffect(() => {
    if (isWide && view === "comments") setView("document");
  }, [isWide, view]);

  // ? opens the cheat sheet unless the reviewer is typing.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const doc = root.ownerDocument;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      setShortcutsOpen(true);
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, []);

  const draftState = useReviewDraft(plan.id, version?.id ?? "none");
  const { draft, update: updateDraft, reset: resetDraft, persistFailed } = draftState;

  const comments = useMemo(
    () => (version ? commentsForVersion(plan, version.id) : []),
    [plan, version],
  );
  const isLatest = version !== null && latest !== null && version.id === latest.id;
  const isApproved = plan.status === "approved";
  const canEdit = isLatest && !isApproved && submitting === null;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const markSeen = () => {
      clearTimeout(timer);
      if (view !== "document" || !isLatest || !latestId || document.visibilityState === "hidden") return;
      seenRef.current = latestId;
      writeLastSeen(plan.id, latestId);
      timer = setTimeout(() => {
        setAgentUpdate((update) => update?.id === latestId ? null : update);
      }, 3000);
    };
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", markSeen);
    };
  }, [view, isLatest, latestId, plan.id]);

  const notice = plan.delivery.notice;
  const [dismissedNotice, setDismissedNotice] = useState(() => readShownNotice(plan.id));
  useEffect(() => {
    if (notice) writeShownNotice(plan.id, notice);
  }, [plan.id, notice]);

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
        await runMutation(() => api.call("updateAnnotation", { id: plan.id, annotationId: commentId, body }));
      },
      resolve: async (annotationId) => {
        await runMutation(() => api.call("resolveAnnotation", { id: plan.id, annotationId }));
      },
      reply: async (annotationId, body) => {
        await runMutation(() => api.call("replyToAnnotation", { id: plan.id, annotationId, body }));
      },
      remove: async (commentId) => {
        await runMutation(() => api.call("withdrawAnnotation", { id: plan.id, annotationId: commentId }));
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
        api.call("addAnnotation", {
          id: plan.id,
          versionId: pending.versionId ?? version.id,
          kind: pending.kind ?? "comment",
          quote: pending.quote,
          body: pending.body,
          ...definedContext({ prefix: pending.prefix, suffix: pending.suffix,
            ...(pending.versionId ? { position: pending.position }
              : pendingMatch?.kind === "unique" ? { position: pendingMatch.start } : {}) }),
        }),
      );
      updateDraft({ pendingComment: null });
      const added = next.comments.find(
        (comment) => !plan.comments.some((existing) => existing.id === comment.id),
      );
      if (added) setActiveCommentId(added.id);
      if (!isWide) setView("comments");
    },
    [api, isWide, plan.comments, plan.id, runMutation, updateDraft, version, pendingMatch],
  );

  const approvePlan = useCallback(
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
          api.call("approve", { id: plan.id, requestId, versionId: version.id }),
        );
        requestIdRef.current = null;
        resetDraft();
        toast.success(plan.sample ? "Sample plan approved" : "Plan approved");
      } catch (cause) {
        setFailure({ message: describeError(cause), requestId, action });
      } finally {
        setSubmitting(null);
      }
    },
    [api, plan.id, plan.sample, resetDraft, runMutation, version],
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

  const pending = canEdit ? draft.pendingComment : null;

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
        onDeliveryModeChange={(mode) => {
          void runMutation(() => api.call("setDeliveryMode", { id: plan.id, mode })).catch((cause) => toast.error(describeError(cause)));
        }}
        onDelete={() => setDeleteOpen(true)}
        onDiagnostics={() => setDiagnosticsOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
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
            Go to latest
          </Button>
        </div>
      ) : null}
      {agentUpdate ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground" role="status">
          <span className="min-w-0 flex-1 break-words">Updated by the agent · v{agentUpdate.number}{agentUpdate.summary ? ` · ${agentUpdate.summary}` : ""}</span>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => { setSelectedVersionId(null); setView("changes"); setAgentUpdate(null); }}>Show changes</Button>
          <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Dismiss update" onClick={() => setAgentUpdate(null)}>
            <Icon name="X" className="size-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
      {notice && notice !== dismissedNotice ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1 text-xs text-muted-foreground">
          <p className="flex-1">{notice}</p>
          <Button size="sm" variant="ghost" aria-label="Dismiss delivery notice" onClick={() => setDismissedNotice(notice)}>Dismiss</Button>
        </div>
      ) : null}
      {persistFailed ? <p className="px-4 py-1 text-xs text-muted-foreground">Draft not saved in this browser.</p> : null}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Keep the rendered text index alive across tabs, including new comments. */}
          <div className={view === "document" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <PlanDocument
              visible={view === "document"}
              markdown={version.markdown}
              versionId={version.id}
              comments={comments}
              activeCommentId={activeCommentId}
              hoveredCommentId={hoveredCommentId}
              onHoverComment={setHoveredCommentId}
              canComment={canEdit}
              pendingQuote={pending?.quote ?? null}
              pendingKind={pending?.kind}
              pendingContext={pending ? { prefix: pending.prefix, suffix: pending.suffix,
                ...(pending.versionId ? { position: pending.position } : {}) } : undefined}
              onPendingMatch={setPendingMatch}
              composer={
                !isMobile && pending ? (
                  <CommentComposer
                    pending={pending}
                    match={pendingMatch}
                    onChange={setPending}
                    onCancel={() => setPending(null)}
                    onSubmit={submitPending}
                  />
                ) : undefined
              }
              onAnnotate={async (quote, kind, context) => {
                try {
                  await runMutation(() => api.call("addAnnotation", { id: plan.id, versionId: version.id, quote, kind, body: "", ...context }));
                } catch (error) { toast.error(describeError(error)); }
              }}
              onQuote={(quote, context, kind = "comment") => {
                setPending({ quote, kind, versionId: version.id, ...context, body: pending?.quote === quote ? pending.body : "" });
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
            <PlanChanges key={version.id} plan={plan} version={version} isWide={isWide} lastSeenId={changesBase} />
          ) : view === "comments" ? (
            <CommentRail
              comments={comments}
              anchors={anchors}
              activeCommentId={activeCommentId}
              onActivate={(id) => {
                setActiveCommentId(id);
                if (id !== null) setView("document");
              }}
              hoveredCommentId={hoveredCommentId}
              onHover={setHoveredCommentId}
              actions={commentActions}
              canEdit={canEdit}
              failedAnnotations={delivery.failedAnnotations}
              cancelledAnnotations={delivery.cancelledAnnotations}
              pending={pending}
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
              hoveredCommentId={hoveredCommentId}
              onHover={setHoveredCommentId}
              actions={commentActions}
              canEdit={canEdit}
              failedAnnotations={delivery.failedAnnotations}
              cancelledAnnotations={delivery.cancelledAnnotations}
              pending={pending}
              emptyMessage={view === "changes" && canEdit ? "Open Document to comment on the text." : undefined}
            />
          </aside>
        ) : null}
      </div>
      {isLatest ? (
        <ReviewFooter
          plan={plan}
          failedCount={delivery.failedCount}
          approvalState={delivery.approvalState}
          submitting={submitting}
          failure={failure}
          onSubmit={(action) => void approvePlan(action)}
          onDismissFailure={() => setFailure(null)}
          confirmOpen={confirmOpen}
          onConfirmOpenChange={setConfirmOpen}
        />
      ) : null}

      {isMobile ? (
        <Dialog open={pending !== null && view === "document"} onOpenChange={(open) => !open && setPending(null)}>
          <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{pending?.kind === "ask" ? "New ask" : "New comment"}</DialogTitle>
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

      <DiagnosticsDialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} root={rootRef.current} anchors={anchors} />
      <ShortcutCheatSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} canAnnotate={canEdit} />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{plan.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes all {plan.versions.length} versions and {plan.comments.length} annotations,
              and any queued feedback message. The thread's history stays.
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
