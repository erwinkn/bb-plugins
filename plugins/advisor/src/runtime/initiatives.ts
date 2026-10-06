// Optional Initiative context (A152 §1 snapshot reads). The Advisor reads
// the Initiatives plugin only through a public, token-authenticated read
// surface; it never opens its database or imports its code. Without that
// surface `unavailableInitiatives` applies: watched threads are treated as
// standalone, and a thread the Initiatives plugin created is marked with
// partial requirement coverage instead of a guessed membership. Tests use
// typed fakes built from the installed Initiatives shapes.

import type { AssignmentRecord, Membership, Read, RefsResult, TaskBriefRecord } from "../rules/snapshot.js";
import { ok } from "../rules/snapshot.js";

/** An Initiative a user can watch whole (context/v1/initiatives). */
export interface InitiativeSummary {
  id: string;
  name: string;
  paused: boolean;
  coordinatorThreadId: string | null;
}

export type MemberState = "active" | "stopped" | "retired" | "former";

/** One thread of an Initiative, in the thread route's terms (context/v1/members). */
export interface InitiativeMember {
  threadId: string;
  kind: string;
  role: string;
  worker: string | null;
  generation: number | null;
  state: MemberState;
}

/** One page of members; `next` is the cursor for the following page, null on the last. */
export interface InitiativeMembers {
  id: string;
  name: string;
  archived: boolean;
  next: string | null;
  members: InitiativeMember[];
}

/**
 * A listing read. "unavailable" means the route is not there (Initiatives not
 * installed, or a build without it); "failed" is any other unknown answer.
 * Neither is ever read as "no members".
 */
export type Listing<T> = { status: "ok"; value: T } | { status: "unavailable" | "failed"; error: string };

export interface InitiativeSource {
  readonly available: boolean;
  readonly label: string;
  initiatives(signal: AbortSignal): Promise<Listing<InitiativeSummary[]>>;
  members(initiativeId: string, after: string | null, signal: AbortSignal): Promise<Listing<InitiativeMembers>>;
  membership(threadId: string, signal: AbortSignal): Promise<Read<Membership | null>>;
  assignments(threadId: string, refs: string[], signal: AbortSignal): Promise<Read<RefsResult<AssignmentRecord>>>;
  tasks(threadId: string, refs: string[], signal: AbortSignal): Promise<Read<RefsResult<TaskBriefRecord>>>;
}

export const unavailableInitiatives: InitiativeSource = {
  available: false,
  label: "Initiative context unavailable: the Initiatives plugin's authenticated read API is not available.",
  async initiatives() {
    return { status: "unavailable", error: "the Initiatives context routes are not available" } as const;
  },
  async members() {
    return { status: "unavailable", error: "the Initiatives context routes are not available" } as const;
  },
  async membership() {
    return ok(null);
  },
  async assignments() {
    return ok({ items: [], missingRefs: [] });
  },
  async tasks() {
    return ok({ items: [], missingRefs: [] });
  },
};

/** Coordinator intake, coordinator wakes and automatic decision recording are deferred stages. */
export const DEFERRED_STAGES = [
  {
    id: "initiative-intake",
    label: "Initiative finding intake",
    status: "Unavailable (deferred, stage S5): Initiatives does not pull Advisor findings yet.",
  },
  {
    id: "coordinator-wake",
    label: "Coordinator wakes",
    status: "Unavailable (deferred, stage S5): the Advisor never messages or wakes any thread.",
  },
  {
    id: "decision-capture",
    label: "Decision capture",
    status: "Unavailable (separate design, T80): the Advisor records no decisions and gives the model no tools.",
  },
] as const;
