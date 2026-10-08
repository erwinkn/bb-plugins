import {
  DEFAULT_PROFILES,
  type Policy,
  type Profile,
  type ProfileKey,
  type Role,
  type AssignmentAccess,
  type WorkKind,
  type WorkerKind,
  WORKER_KIND_PROFILE,
} from "./schema";
import type {
  AssignmentRecord,
  ProjectRecord,
  TaskRecord,
  TokenTotals,
  UsageRecord,
  WorkerRecord,
} from "./store";
import { taskRef, workerRef } from "./store";

// Pure decisions. Nothing here talks to BB; callers gather facts first and
// act on the result, so every rule is testable on plain data.

export const profileFor = (policy: Policy, key: ProfileKey): Profile =>
  policy.profiles[key] ?? DEFAULT_PROFILES[key];

/** The default work profile for a worker kind; a missing kind is a plain worker. */
export const workerKindProfile = (policy: Policy, kind: WorkerKind = "worker"): Profile =>
  profileFor(policy, WORKER_KIND_PROFILE[kind]);

export const sameProfile = (a: Profile, b: Profile) =>
  a.providerId === b.providerId &&
  a.model === b.model &&
  a.reasoningLevel === b.reasoningLevel &&
  a.serviceTier === b.serviceTier;

export const describeProfile = (profile: Profile) =>
  `${profile.providerId} / ${profile.model} / ${profile.reasoningLevel} / ${profile.serviceTier ?? "tier unspecified"}`;

export type ProfileChoice =
  | { ok: true; profile: Profile; source: "user" | "explicit" | "default" }
  | { ok: false; reason: string };

/**
 * A user's explicit choice on a task wins and cannot be silently replaced. A
 * coordinator may pass its own profile when the user has not chosen one.
 */
export function chooseWorkProfile(input: {
  policy: Policy;
  kind: WorkKind;
  task: Pick<TaskRecord, "ref" | "profileOverride" | "profileSource"> | null;
  explicit: Profile | null;
}): ProfileChoice {
  const user =
    input.task?.profileSource === "user" ? input.task.profileOverride : null;
  if (user) {
    // Historical/user profiles without a tier constrain the model and effort,
    // while leaving native tier inheritance available. An explicit user tier
    // still wins over every coordinator choice.
    const requested = input.explicit;
    if (
      requested &&
      (user.providerId !== requested.providerId ||
        user.model !== requested.model ||
        user.reasoningLevel !== requested.reasoningLevel ||
        (user.serviceTier !== undefined &&
          requested.serviceTier !== undefined &&
          user.serviceTier !== requested.serviceTier))
    )
      return {
        ok: false,
        reason: `${input.task!.ref} has a profile the user chose (${describeProfile(user)}). Use it or ask the user to change it.`,
      };
    return {
      ok: true,
      profile: requested?.serviceTier !== undefined && user.serviceTier === undefined
        ? { ...user, serviceTier: requested.serviceTier }
        : user,
      source: "user",
    };
  }
  if (input.explicit)
    return { ok: true, profile: input.explicit, source: "explicit" };
  if (input.task?.profileOverride)
    return {
      ok: true,
      profile: input.task.profileOverride,
      source: "explicit",
    };
  return {
    ok: true,
    profile: profileFor(input.policy, input.kind),
    source: "default",
  };
}

export type Series = "claude" | "gpt" | "unknown";

/**
 * Model family of a recorded implementer. It picks the default reviewer and
 * describes review scopes; it never gates a dispatch.
 */
export function seriesOf(
  profile: Pick<Profile, "providerId" | "model"> | null,
): Series {
  if (!profile) return "unknown";
  const model = profile.model.toLowerCase();
  if (model.startsWith("claude") || profile.providerId === "claude-code")
    return "claude";
  if (/^(gpt|o\d|codex)/u.test(model) || profile.providerId === "codex")
    return "gpt";
  return "unknown";
}

export interface DelegationFacts {
  project: Pick<ProjectRecord, "paused" | "memberProjectIds">;
  route: "fresh" | "continue";
  role: Role;
  tasks: TaskRecord[];
  bbProjectId: string;
  /** The existing worker messaged with work (continue). */
  worker: WorkerRecord | null;
  workerOpenAssignment: AssignmentRecord | null;
  /** Thread facts read live from BB just before dispatch. */
  thread: { archived: boolean; status: string; model: string | null } | null;
  requestedProfile: Profile;
}

/**
 * Hard eligibility at actual dispatch (T136): only what would make the work go wrong.
 * Overlapping writers and shared tasks are warnings, returned separately.
 */
export function delegationViolations(facts: DelegationFacts): string[] {
  const reasons: string[] = [];
  if (facts.project.paused)
    reasons.push("The Initiative is paused. Resume it before giving out new work.");
  if (!facts.project.memberProjectIds.includes(facts.bbProjectId))
    reasons.push(`BB project ${facts.bbProjectId} is not a member of this Initiative. Add it to the Initiative first.`);
  for (const task of facts.tasks)
    if (task.status === "done" || task.status === "cancelled")
      reasons.push(`${task.ref} is ${task.status}. Reopen it first if it needs more work.`);
  const worker = facts.worker;
  if (facts.route === "fresh" && worker)
    reasons.push("A spawn creates a new worker; message the existing one instead.");
  // A review is done by a fresh reviewer, one per review round, and a reviewer gets no more
  // work (W239); delegate refuses that earlier, naming the reviewer to spawn instead.
  if (facts.role === "review" && facts.route !== "fresh")
    reasons.push("A review is done by a fresh reviewer; spawn one with reviews:\"W#\".");
  if (facts.route === "continue") {
    if (!worker) reasons.push("Name the worker to message.");
    else {
      if (worker.role === "review")
        reasons.push(`${worker.ref} is a reviewer, and reviews are not reused. Send the fixes to the work worker, then spawn a fresh reviewer.`);
      if (worker.state === "retired")
        reasons.push(`${worker.ref} is retired and its thread is archived. Spawn a fresh worker with handoffs:["${worker.ref}"].`);
      if (!facts.thread || facts.thread.archived)
        reasons.push(`${worker.ref}'s thread is archived or missing. Spawn a fresh worker with handoffs:["${worker.ref}"].`);
      if (facts.workerOpenAssignment)
        reasons.push(`${worker.ref} is still working on ${facts.workerOpenAssignment.ref} (${facts.workerOpenAssignment.state}). Send a plain initiative_message to steer it, or wait for its report.`);
      const current = facts.thread?.model ?? worker.model;
      if (current && current !== facts.requestedProfile.model)
        reasons.push(`${worker.ref} runs ${current}; switching it to ${facts.requestedProfile.model} would mix models in one context. Spawn a fresh worker.`);
      if (worker.providerId && worker.providerId !== facts.requestedProfile.providerId)
        reasons.push(`${worker.ref} runs on ${worker.providerId}, not ${facts.requestedProfile.providerId}.`);
    }
  }
  return reasons;
}


// Usage ----------------------------------------------------------------------

export interface UsageObservation {
  seq: number;
  at: number;
  providerThreadId: string | null;
  total: TokenTotals;
  last?: TokenTotals;
}

/**
 * Fold one cumulative provider report into a thread's record. Cumulative
 * totals may reset while the conversation id survives. A changed id, a
 * shrinking total, or a first-result total equal to its last-turn aggregate is
 * evidence of a new accounting epoch, and the finished session moves to closed totals
 * so it is counted exactly once.
 */
export function foldUsage(
  current: Pick<
    UsageRecord,
    "lastSeq" | "providerThreadId" | "sessionTotals" | "closedTotals" | "resets"
  >,
  observation: UsageObservation,
): Pick<
  UsageRecord,
  | "lastSeq"
  | "providerThreadId"
  | "sessionTotals"
  | "closedTotals"
  | "resets"
  | "lastReportAt"
> & { reset: boolean } {
  if (observation.seq <= current.lastSeq)
    return { ...current, lastReportAt: null, reset: false };
  const shrank =
    current.sessionTotals !== null &&
    observation.total.total !== null && current.sessionTotals.total !== null &&
    observation.total.total < current.sessionTotals.total;
  const same =
    current.sessionTotals !== null &&
    Object.keys(observation.total).every(
      (key) =>
        observation.total[key as keyof TokenTotals] ===
        current.sessionTotals![key as keyof TokenTotals],
    );
  const epochStart =
    !same &&
    observation.total.total !== null &&
    observation.last !== undefined &&
    Object.keys(observation.total).every(
      (key) =>
        observation.total[key as keyof TokenTotals] ===
        observation.last![key as keyof TokenTotals],
    );
  const reset =
    current.sessionTotals !== null &&
    (epochStart ||
      shrank ||
      (current.providerThreadId !== null &&
        current.providerThreadId !== observation.providerThreadId));
  return {
    lastSeq: observation.seq,
    providerThreadId: observation.providerThreadId,
    sessionTotals: observation.total,
    closedTotals: reset
      ? addTotals(current.closedTotals, current.sessionTotals!)
      : current.closedTotals,
    resets: current.resets + (reset ? 1 : 0),
    lastReportAt: observation.at,
    reset,
  };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input === null || b.input === null ? null : a.input + b.input,
    cachedInput: a.cachedInput === null || b.cachedInput === null ? null : a.cachedInput + b.cachedInput,
    output: a.output === null || b.output === null ? null : a.output + b.output,
    reasoningOutput: a.reasoningOutput === null || b.reasoningOutput === null ? null : a.reasoningOutput + b.reasoningOutput,
    total: a.total === null || b.total === null ? null : a.total + b.total,
  };
}

export function observedTotals(
  record: Pick<UsageRecord, "sessionTotals" | "closedTotals">,
): TokenTotals {
  return record.sessionTotals
    ? addTotals(record.closedTotals, record.sessionTotals)
    : record.closedTotals;
}

export const workerLabel = (worker: Pick<WorkerRecord, "num" | "label">) =>
  `${workerRef(worker.num)} ${worker.label}`;
