import type { BbPluginApi, PluginInteractionResult } from "@get-bb/plugin-sdk";
import type { Round, Submission } from "../lib/model";

export const INPUT_TIMEOUT_MS = 60 * 60 * 1000;
export const INPUT_RENDERER = "round";
const HOLD_RETRY_MS = 15_000;
type WaitingRound = {
  round: Round;
  attached: boolean;
  stop: AbortController;
  submission?: Submission;
  done: Promise<PluginInteractionResult>;
};

/** Records which round's prompt is open so an unarchive can reopen it. */
export interface HoldPersistence {
  mark(round: Round): void;
  unmark(threadId: string, roundId: string): void;
}

/** The native prompt controls attention, not answer delivery. No holds survive reload. */
export class QuestionInteractions {
  private active = new Map<string, WaitingRound>();
  constructor(private readonly bb: BbPluginApi, private readonly persistence?: HoldPersistence) {}

  has(threadId: string): boolean { return this.active.has(threadId); }

  async wait(round: Round, signal?: AbortSignal): Promise<Submission | PluginInteractionResult> {
    const entry = this.start(round, true, signal);
    const result = await entry.done;
    return entry.submission ?? result;
  }

  /** Short-lived tool clients return now; the saved answers arrive as a message. */
  hold(round: Round): void {
    const entry = this.start(round, false);
    void entry.done.catch((error: unknown) => this.bb.log.warn("Questions hold ended: " + String(error)));
  }

  private start(round: Round, attached: boolean, signal?: AbortSignal): WaitingRound {
    if (this.has(round.threadId)) throw new Error("This thread already has a Questions interaction open.");
    if (signal?.aborted) throw new Error("Questions request was cancelled.");
    this.persistence?.mark(round);
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const entry: WaitingRound = { round, attached, stop, done: Promise.resolve({ outcome: "cancelled", reason: "request-aborted" }) };
    this.active.set(round.threadId, entry);
    entry.done = this.prompt(entry).then((result) => {
      // A dismissal ends the hold for good. Stops, aborts, reloads, and
      // archive interruptions keep the marker so unarchive can reopen it.
      if (result.outcome === "cancelled" && result.reason === "user") this.persistence?.unmark(round.threadId, round.id);
      return result;
    }).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      if (this.active.get(round.threadId) === entry) this.active.delete(round.threadId);
    });
    return entry;
  }

  private async prompt(entry: WaitingRound): Promise<PluginInteractionResult> {
    const { round, stop } = entry;
    try {
      while (!stop.signal.aborted) {
        try {
          const result = await this.bb.ui.requestInput({
            threadId: round.threadId, rendererId: INPUT_RENDERER,
            title: `Round ${round.number} — ${round.questions.length} question${round.questions.length === 1 ? "" : "s"}`,
            payload: { roundId: round.id }, timeoutMs: INPUT_TIMEOUT_MS,
          }, { signal: stop.signal });
          if (result.outcome === "cancelled" && result.reason === "timeout") continue;
          // A native response is only a dismissal. Only the validated submit RPC
          // can commit answers and complete the waiting tool.
          return result.outcome === "submitted" ? { outcome: "cancelled", reason: "user" } : result;
        } catch (error) {
          if (stop.signal.aborted) break;
          if (entry.attached) throw error;
          this.bb.log.warn("Questions prompt unavailable; retrying: " + String(error));
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); stop.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, HOLD_RETRY_MS);
            stop.signal.addEventListener("abort", done, { once: true });
          });
        }
      }
      return { outcome: "cancelled", reason: "request-aborted" };
    } finally {
      entry.attached = false;
    }
  }

  /** Commit before resolving a waiting tool. Otherwise close the hold before message delivery. */
  async deliverToWaiter(submission: Submission, commit: () => void): Promise<boolean> {
    const entry = this.active.get(submission.threadId);
    if (!entry || submission.questionIds.length !== entry.round.questions.length
      || !entry.round.questions.every((q) => submission.questionIds.includes(q.id))) return false;
    const attached = entry.attached && !entry.stop.signal.aborted;
    if (attached) {
      // There is no asynchronous boundary between selecting the receiver and
      // committing its result. Expiry cannot split these two operations.
      commit();
      entry.submission = submission;
    }
    await this.release(submission.threadId);
    return attached;
  }

  async release(threadId: string): Promise<void> {
    const entry = this.active.get(threadId);
    if (!entry) return;
    entry.stop.abort();
    await entry.done.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.keys()].map((threadId) => this.release(threadId)));
  }
}
