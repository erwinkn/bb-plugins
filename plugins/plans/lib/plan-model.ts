import type { Plan, PlanComment, PlanVersion } from "../contract";

export type PlanStatus = Plan["status"];

export const STATUS_LABEL: Record<PlanStatus, string> = {
  open: "Open",
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

/** Latest shows the annotation history; older versions show their own annotations. */
export function commentsForVersion(plan: Plan, versionId: string): PlanComment[] {
  return plan.comments
    .filter((comment) => latestVersion(plan)?.id === versionId || comment.versionId === versionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function openAnnotations(plan: Plan): PlanComment[] {
  return plan.comments.filter((annotation) => annotation.state === "open");
}

export function isDelivered(annotation: PlanComment): boolean {
  return annotation.deliveredAt !== null;
}

export function stateLabel(annotation: PlanComment): string {
  if (annotation.state === "open") return isDelivered(annotation) ? "Delivered" : "Pending";
  return { answered: "Answered", addressed: "Addressed", withdrawn: "Withdrawn" }[annotation.state];
}
