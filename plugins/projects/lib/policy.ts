import {
  DEFAULT_PROFILES,
  type Policy,
  type Profile,
  type ProfileKey,
  type Role,
  type AssignmentAccess,
  type WorkKind,
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

export interface ReviewPartition {
  /** Null when both families' identical profiles merged into one reviewer. */
  key: "reviewOfClaude" | "reviewOfGpt" | null;
  profile: Profile;
  taskNums: number[];
  rationale: string;
}

/**
 * Default reviewers keyed by the family that actually implemented each task,
 * not by the project's default. A reviewer from a different family is the
 * recommendation, not a requirement: each key resolves to its configured
 * profile, whatever its family, and an explicit choice replaces the plan.
 * Mixed scopes get one default reviewer per implementing family, unless both
 * families resolve to the same profile: then one reviewer covers the union.
 */
export function planReview(input: {
  policy: Policy;
  taskNums: number[];
  assignments: Pick<
    AssignmentRecord,
    "taskNums" | "role" | "state" | "actualProfile" | "profile"
  >[];
}): ReviewPartition[] {
  type Key = NonNullable<ReviewPartition["key"]>;
  const byKey = new Map<
    Key,
    { tasks: Set<number>; notes: string[]; authored: boolean }
  >();
  const add = (
    key: Key,
    task: number,
    note: string,
    authored = true,
  ) => {
    const entry = byKey.get(key) ?? {
      tasks: new Set<number>(),
      notes: [],
      authored: false,
    };
    entry.tasks.add(task);
    entry.notes.push(note);
    entry.authored ||= authored;
    byKey.set(key, entry);
  };
  for (const task of input.taskNums) {
    const implementers = input.assignments.filter(
      (assignment) =>
        assignment.role === "work" &&
        assignment.taskNums.includes(task) &&
        ["reported", "accepted", "idle_no_report"].includes(assignment.state),
    );
    const series = new Set(
      implementers.map((assignment) =>
        seriesOf(assignment.actualProfile ?? assignment.profile),
      ),
    );
    if (series.has("claude"))
      add("reviewOfClaude", task, `${taskRef(task)} was implemented by Claude`);
    if (series.has("gpt"))
      add("reviewOfGpt", task, `${taskRef(task)} was implemented by GPT`);
    if (!series.has("claude") && !series.has("gpt"))
      add(
        "reviewOfClaude",
        task,
        `${taskRef(task)} has no recorded Claude or GPT implementer; using the default reviewer`,
        false,
      );
  }
  // Two identical reviewers would duplicate the work, so keys whose
  // profiles are exactly equal share one reviewer over the union scope.
  const parts: {
    keys: Key[];
    profile: Profile;
    tasks: Set<number>;
    notes: string[];
    same: Series | null;
  }[] = [];
  for (const [key, entry] of byKey) {
    const profile = profileFor(input.policy, key);
    const family = key === "reviewOfClaude" ? "claude" : "gpt";
    let part = parts.find((p) => sameProfile(p.profile, profile));
    if (!part)
      parts.push(
        (part = { keys: [], profile, tasks: new Set(), notes: [], same: null }),
      );
    part.keys.push(key);
    for (const task of entry.tasks) part.tasks.add(task);
    part.notes.push(...entry.notes);
    if (entry.authored && seriesOf(profile) === family) part.same = family;
  }
  return parts.map((part) => {
    const merged = part.keys.length > 1;
    const implementer = !merged
      ? "implementer"
      : `${part.same === "claude" ? "Claude" : "GPT"} implementer`;
    return {
      key: merged ? null : part.keys[0]!,
      profile: part.profile,
      taskNums: [...part.tasks].sort((a, b) => a - b),
      rationale: `${part.notes.join("; ")}. Configured reviewer: ${describeProfile(part.profile)}${part.same ? ` (same model family as the ${implementer})` : ""}${merged ? "; both families' reviewer profiles are identical, so one reviewer covers the whole scope" : ""}.`,
    };
  });
}

export interface DelegationFacts {
  project: Pick<ProjectRecord, "paused" | "memberProjectIds">;
  route: "fresh" | "continue" | "fork";
  role: Role;
  access?: AssignmentAccess;
  tasks: TaskRecord[];
  allTasks: TaskRecord[];
  bbProjectId: string;
  /** Existing worker for continue; source worker for fork. */
  worker: WorkerRecord | null;
  workerOpenAssignment: AssignmentRecord | null;
  /** Thread facts read live from BB just before dispatch. */
  thread: { archived: boolean; status: string; model: string | null } | null;
  requestedProfile: Profile;
  workspace: "shared" | "isolated";
  /** Work assignments reserving paths in the same BB project. */
  concurrentWork: {
    ref: string;
    workerRef: string;
    paths: string[];
    workspace: "shared" | "isolated";
    access?: AssignmentAccess;
    /**
     * Why settled-looking work still holds its scope (T91): its thread is running,
     * could not be proven quiet, or its report lists unverified background work.
     * Absent for work that is itself still running.
     */
    held?: "running" | "unknown" | "listed";
    /** The listed background work of this assignment's own report, when held is "listed". */
    background?: string[];
    /** Other assignments on the same thread whose reports also list unreleased work. */
    alsoListed?: string[];
    /** No write scope was recorded (pre-T91); held as the whole project. */
    legacy?: boolean;
    /** The holding assignment's ledger state, for the message. */
    state?: string;
    /** What BB's thread row showed for a running or unproven hold, quoted in the message. */
    seen?: string;
    /** The listed report's version, echoed by assignment-scope-release. */
    reportVersion?: string;
  }[];
  paths: string[];
  providerSupportsFork: boolean | null;
  forkAtCompletedPoint: boolean;
  reviewOf: number[];
  reviewOfTasks: TaskRecord[];
}

/**
 * Hard eligibility at actual dispatch. Returns human-readable reasons; empty
 * means eligible.
 */
export function delegationViolations(facts: DelegationFacts): string[] {
  const reasons: string[] = [];
  if (facts.project.paused)
    reasons.push("The project is paused. Resume it before starting new work.");
  if (!facts.project.memberProjectIds.includes(facts.bbProjectId))
    reasons.push(
      `BB project ${facts.bbProjectId} is not a member of this project. Add it to the project first.`,
    );
  if (facts.role === "work" && facts.tasks.length === 0)
    reasons.push("Work needs at least one task.");
  for (const task of facts.tasks) {
    if (task.status === "done" || task.status === "cancelled")
      reasons.push(`${task.ref} is ${task.status}.`);
    const unmet = task.dependsOn.filter(
      (num) =>
        facts.allTasks.find((other) => other.num === num)?.status !== "done",
    );
    if (unmet.length)
      reasons.push(
        `${task.ref} depends on ${unmet.map(taskRef).join(", ")}, which ${unmet.length === 1 ? "is" : "are"} not done.`,
      );
    if (facts.role === "work" && !task.brief)
      reasons.push(
        `${task.ref} has no brief yet. Add one with objective, acceptance criteria, areas, and verification.`,
      );
  }
  if (facts.role === "review") {
    if (facts.reviewOf.length === 0)
      reasons.push("A review needs the tasks it reviews (reviewOf).");
    for (const task of facts.reviewOfTasks)
      if (task.status === "cancelled") reasons.push(`${task.ref} was cancelled.`);
    // Structural successful report/checkpoint + exact revision are checked at
    // the service boundary; task status alone is never implementation proof.
  }

  const worker = facts.worker;
  if (facts.route === "fresh" && worker)
    reasons.push(
      "A fresh delegation creates a new worker; do not pass a worker.",
    );
  // A reviewer is always a fresh independent thread: continuing or forking any
  // existing context into a review would carry the implementer's perspective.
  if (facts.role === "review" && facts.route !== "fresh")
    reasons.push(
      "Reviewers are always fresh independent threads; a review never continues or forks an existing context.",
    );
  if (facts.route !== "fresh") {
    if (!worker)
      reasons.push(`The ${facts.route} route needs an existing worker.`);
    else {
      if (worker.role !== facts.role) {
        if (facts.route === "fork" && facts.role === "review")
          reasons.push(
            `${worker.ref} is an implementation worker. Do not fork an implementer's transcript into an independent reviewer; start a fresh review instead.`,
          );
        else if (worker.role === "review")
          reasons.push(
            `${worker.ref} is a reviewer. Reviewers never implement; delegate the fixes to a work worker and keep the reviewer for verification.`,
          );
        else
          reasons.push(
            `${worker.ref} is a work worker and cannot review. A worker never reviews work; start a fresh reviewer.`,
          );
      }
      if (worker.state === "retired")
        reasons.push(
          `${worker.ref} is retired and its thread is archived. Start a fresh worker instead.`,
        );
      if (facts.route === "continue") {
        if (!facts.thread || facts.thread.archived)
          reasons.push(
            `${worker.ref}'s thread is archived or missing. Start a fresh worker instead.`,
          );
        if (facts.workerOpenAssignment)
          reasons.push(
            `${worker.ref} still has ${facts.workerOpenAssignment.ref} open (${facts.workerOpenAssignment.state}). Wait for its report or stop it first.`,
          );
        const current = facts.thread?.model ?? worker.model;
        if (current && current !== facts.requestedProfile.model)
          reasons.push(
            `${worker.ref} runs ${current}; continuing it on ${facts.requestedProfile.model} would mix models in one context. Start a fresh worker.`,
          );
        if (
          worker.providerId &&
          worker.providerId !== facts.requestedProfile.providerId
        )
          reasons.push(
            `${worker.ref} runs on ${worker.providerId}, not ${facts.requestedProfile.providerId}.`,
          );
      }
      if (facts.route === "fork") {
        if (facts.providerSupportsFork === false)
          reasons.push(
            `${worker.providerId ?? "This provider"} does not support native forks on that machine.`,
          );
        if (!facts.forkAtCompletedPoint)
          reasons.push(
            `${worker.ref} is still working. Fork from a completed point: wait for its report or pass the event sequence of a finished turn.`,
          );
        if (
          worker.providerId &&
          worker.providerId !== facts.requestedProfile.providerId
        )
          reasons.push(
            "A fork keeps its source's provider and model; omit the profile or start fresh.",
          );
        if (worker.model && worker.model !== facts.requestedProfile.model)
          reasons.push(
            `A fork keeps ${worker.model}; omit the profile or start fresh.`,
          );
      }
    }
  }

  if (
    facts.role === "work" &&
    facts.access !== "read-only" &&
    facts.workspace === "shared"
  ) {
    for (const other of facts.concurrentWork) {
      if (other.access === "read-only") continue;
      if (other.workspace === "isolated") continue;
      if (pathsOverlap(facts.paths, other.paths))
        reasons.push(overlapReason(other));
    }
  }
  return reasons;
}

/** Names, boundedly, the other reports on the same thread that would hold once this one is released. */
function alsoListed(refs: string[] | undefined): string {
  if (!refs?.length) return "";
  const named = refs.length > 3 ? `${refs.slice(0, 3).join(", ")} and ${refs.length - 3} more` : refs.join(refs.length === 2 ? " and " : ", ");
  return ` ${named} on the same thread also ${refs.length === 1 ? "lists" : "list"} unverified work and keep${refs.length === 1 ? "s" : ""} holding these paths after this release; read ${refs.length === 1 ? "it" : "them"} for ${refs.length === 1 ? "its" : "their"} own jobs and version.`;
}

function overlapReason(other: DelegationFacts["concurrentWork"][number]): string {
  const who = `${other.ref} (${other.workerRef})`;
  const scope = other.legacy ? " (no recorded write scope, so it is held as the whole project)" : "";
  const exits = "narrow the paths, or use an isolated workspace";
  // A rejected assignment refuses later reports (T92), so only an explicit release frees it.
  if (other.held === "listed" && other.state === "rejected")
    return `${who}'s report lists background work (${(other.background ?? []).slice(0, 3).join("; ")}) that is unverified and still owns overlapping paths${scope}. ${other.ref} is rejected and takes no later report: once those jobs are checked and BB shows the thread ended, record initiative_task {"action":"assignment-scope-release","assignment":"${other.ref}","reportVersion":"${other.reportVersion ?? "…"}","reason":"…"}; the release is not evidence that they ended. Or ${exits}.${alsoListed(other.alsoListed)}`;
  if (other.held === "listed")
    return `${who}'s report lists background work (${(other.background ?? []).slice(0, 3).join("; ")}) that is unverified and still owns overlapping paths${scope}. Wait for an updated final report; or, once those jobs are checked and BB shows the thread ended, record initiative_task {"action":"assignment-scope-release","assignment":"${other.ref}","reportVersion":"${other.reportVersion ?? "…"}","reason":"…"}; or ${exits}.${alsoListed(other.alsoListed)}`;
  if (other.held === "running")
    return `${who} is ${other.state ?? "no longer running work"}, but its thread is still running (${other.seen ?? "foreground turn, queued input or background commands"}) on overlapping paths in the same workspace${scope}. Wait for it to finish, ${exits}.`;
  if (other.held === "unknown")
    return `${who} is ${other.state ?? "no longer running work"}, but its thread could not be proven quiet (${other.seen ?? "BB's thread state was missing, unreadable or changed while checking"}) and it wrote overlapping paths in the same workspace${scope}. Inspect it and retry, ${exits}.`;
  return `${who} is writing overlapping paths in the same workspace${scope}. Wait for it, ${exits}.`;
}

/** Empty path lists mean "the whole project", which overlaps everything. */
export function pathsOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  const norm = (path: string) =>
    path.replace(/^\.?\/+/u, "").replace(/\/+$/u, "");
  return a.some((left) =>
    b.some((right) => {
      const l = norm(left);
      const r = norm(right);
      return (
        l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`) || !l || !r
      );
    }),
  );
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
