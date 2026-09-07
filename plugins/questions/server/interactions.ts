import type { BbPluginApi, PluginInteractionResult } from "@get-bb/plugin-sdk";
import type { Round, Submission } from "../lib/model";

export const INPUT_TIMEOUT_MS = 60 * 60 * 1000;
export const INPUT_RENDERER = "round";
type WaitingRound = { round: Round; submission?: Submission; confirmation?: Promise<void>; delivery?: Promise<boolean> };

/** One host-owned waiting interaction per thread. Drafts remain in SQLite. */
export class QuestionInteractions {
  private active = new Map<string, WaitingRound>();
  constructor(private readonly bb: BbPluginApi) {}

  async wait(round: Round, signal?: AbortSignal): Promise<Submission | PluginInteractionResult> {
    if (this.active.has(round.threadId)) throw new Error("This thread already has a Questions interaction open.");
    const entry: WaitingRound = { round };
    try {
      for (;;) {
        this.active.set(round.threadId, entry);
        const result = await this.bb.ui.requestInput({
          threadId: round.threadId, rendererId: INPUT_RENDERER,
          title: `Round ${round.number} — ${round.questions.length} question${round.questions.length === 1 ? "" : "s"}`,
          payload: { roundId: round.id }, timeoutMs: INPUT_TIMEOUT_MS,
        }, { signal });
        if (result.outcome === "cancelled" && result.reason === "timeout" && !signal?.aborted) {
          // A response may finish as the host expires the interaction. Do not
          // create another waiter until that response has a known outcome.
          const delivered = await entry.delivery?.catch(() => false);
          if (delivered && entry.submission) return entry.submission;
          if (signal?.aborted) return result;
          continue;
        }
        if (result.outcome === "submitted") {
          const value = result.value;
          if (!entry.submission || typeof value !== "object" || value === null || Array.isArray(value)
            || value.submissionId !== entry.submission.id) {
            throw new Error("No validated round submission was received. Your drafts are kept.");
          }
          await entry.confirmation;
          return entry.submission;
        }
        return result;
      }
    } finally {
      if (this.active.get(round.threadId) === entry) this.active.delete(round.threadId);
    }
  }

  /** False means no waiting call for this round: late answers use a message. */
  deliver(submission: Submission, confirmed: () => void): Promise<boolean> {
    const entry = this.active.get(submission.threadId);
    if (!entry || !submission.questionIds.every((id) => entry.round.questions.some((q) => q.id === id))) return Promise.resolve(false);
    // Claim before the first asynchronous step, including interaction lookup.
    const delivery = this.respond(entry, submission, confirmed);
    entry.delivery = delivery;
    return delivery;
  }

  private async respond(entry: WaitingRound, submission: Submission, confirmed: () => void): Promise<boolean> {
    const pending = await this.bb.sdk.threads.interactions.list({ threadId: submission.threadId });
    if (this.active.get(submission.threadId) !== entry) throw new Error("The interaction ended or renewed. Check the result before submitting again.");
    const interaction = pending.find((item) => item.origin?.kind === "plugin"
      && item.origin.pluginId === "questions" && item.origin.rendererId === INPUT_RENDERER
      && item.payload.kind === "plugin" && typeof item.payload.data === "object"
      && item.payload.data !== null && !Array.isArray(item.payload.data)
      && item.payload.data.roundId === entry.round.id && item.status === "pending");
    // A timeout can race submission. Do not turn a failed native response
    // into an automatic message send, which could deliver the answer twice.
    if (!interaction) throw new Error("The waiting interaction ended. Check the thread before retrying.");
    entry.submission = submission;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    entry.confirmation = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void entry.confirmation.catch(() => {}); // Cancellation may remove the waiter first.
    try {
      const result = await this.bb.sdk.threads.interactions.respond({
        threadId: submission.threadId, interactionId: interaction.id,
        value: { submissionId: submission.id },
      });
      if (result.status !== "resolved") throw new Error("The interaction did not confirm submission.");
      confirmed(); // Commit before the agent resumes and reads submitted answers.
      resolve();
      return true;
    } catch (error) {
      reject(error);
      throw error;
    }
  }
}
