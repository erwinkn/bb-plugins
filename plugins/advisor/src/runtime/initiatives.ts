// Optional Initiative context (A152 §1 snapshot reads). The Advisor reads
// Projects only through a public, token-authenticated read surface; it never
// opens Projects' database or imports its code. That surface (T96) does not
// exist yet, so production uses `unavailableInitiatives`: watched threads are
// treated as standalone, and a thread Projects created is marked with partial
// requirement coverage instead of a guessed membership. Tests use typed fakes
// built from the installed Projects shapes.

import type { AssignmentRecord, Membership, Read, RefsResult, TaskBriefRecord } from "../rules/snapshot.js";
import { ok } from "../rules/snapshot.js";

export interface InitiativeSource {
  readonly available: boolean;
  readonly label: string;
  membership(threadId: string, signal: AbortSignal): Promise<Read<Membership | null>>;
  assignments(threadId: string, refs: string[], signal: AbortSignal): Promise<Read<RefsResult<AssignmentRecord>>>;
  tasks(threadId: string, refs: string[], signal: AbortSignal): Promise<Read<RefsResult<TaskBriefRecord>>>;
}

export const unavailableInitiatives: InitiativeSource = {
  available: false,
  label: "Initiative context unavailable: the authenticated Projects read API is not available yet (T96).",
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
    status: "Unavailable (deferred, stage S5): Projects does not pull Advisor findings yet.",
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
