import type { Plan, PlanComment, PlanVersion } from "../contract";

export type PlanStatus = Plan["status"];

export const STATUS_LABEL: Record<PlanStatus, string> = {
  review: "Needs review",
  revising: "Revising",
  approved: "Approved",
};

/** Versions ordered newest first; the backend does not promise an order. */
export function sortedVersions(plan: Plan): PlanVersion[] {
  return [...plan.versions].sort((a, b) => b.number - a.number);
}

export function latestVersion(plan: Plan): PlanVersion | null {
  return sortedVersions(plan)[0] ?? null;
}

export function findVersion(plan: Plan, versionId: string | null): PlanVersion | null {
  if (versionId === null) return null;
  return plan.versions.find((version) => version.id === versionId) ?? null;
}

export function previousVersion(plan: Plan, version: PlanVersion): PlanVersion | null {
  return (
    sortedVersions(plan).find((candidate) => candidate.number < version.number) ??
    null
  );
}

export function versionLabel(version: PlanVersion, plan?: Plan): string {
  const latest = plan ? latestVersion(plan) : null;
  return latest && latest.id === version.id
    ? `v${version.number} · latest`
    : `v${version.number}`;
}

/** Comments pinned to one version, oldest first so the rail reads in order. */
export function commentsForVersion(plan: Plan, versionId: string): PlanComment[] {
  return plan.comments
    .filter((comment) => comment.versionId === versionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function unsentComments(plan: Plan, versionId: string): PlanComment[] {
  return commentsForVersion(plan, versionId).filter((comment) => comment.sentAt === null);
}

/**
 * What "Send feedback" will deliver: every unsent comment on any version. The
 * backend batches across versions and labels each by version.
 */
export function pendingFeedbackComments(plan: Plan): PlanComment[] {
  return plan.comments.filter((comment) => comment.sentAt === null);
}

/** Comments that still block approval: unsent, or sent against the latest version. */
export function openComments(plan: Plan): PlanComment[] {
  return plan.comments.filter((comment) => comment.kind !== "looksGood" && (comment.sentAt === null || comment.versionId === latestVersion(plan)?.id));
}

export interface ReviewGate {
  canSendFeedback: boolean;
  feedbackReason: string | null;
  canApprove: boolean;
  approveReason: string | null;
}

/**
 * Mirrors the backend rules so controls disable with an explanation instead of
 * failing on submit: feedback needs a comment or a note; approval needs zero
 * open comments on any version and must target the latest version.
 */
export function reviewGate(
  plan: Plan,
  versionId: string,
  note: string,
): ReviewGate {
  const isLatest = latestVersion(plan)?.id === versionId;
  const closed = plan.status === "approved";
  const pendingCount = pendingFeedbackComments(plan).length;
  const hasNote = note.trim().length > 0;
  const open = openComments(plan).length;

  let feedbackReason: string | null = null;
  if (closed) feedbackReason = "This plan is approved.";
  else if (!isLatest) feedbackReason = "Switch to the latest version to send feedback.";
  else if (pendingCount === 0 && !hasNote)
    feedbackReason = "Add a comment or a note to send feedback.";

  let approveReason: string | null = null;
  if (closed) approveReason = "This plan is already approved.";
  else if (!isLatest) approveReason = "Only the latest version can be approved.";
  else if (plan.status === "revising") approveReason = "Review the next revision before approving.";
  else if (open > 0)
    approveReason =
      open === 1
        ? "Send or delete the pending comment, then review the next revision."
        : `Send or delete the ${open} pending comments, then review the next revision.`;

  return {
    canSendFeedback: feedbackReason === null,
    feedbackReason,
    canApprove: approveReason === null,
    approveReason,
  };
}

export function shortThreadId(threadId: string): string {
  return threadId.length > 14 ? `${threadId.slice(0, 12)}…` : threadId;
}
