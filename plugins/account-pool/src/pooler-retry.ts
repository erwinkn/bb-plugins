import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { ModelFamily, PoolProvider } from "./contracts.js";
import { modelFamily } from "./quota.js";

// Retries for turns that fail on a Pooler 429. BB's own provider-retry cannot schedule them: Claude
// Code behind the Pooler runs as an API-key session and reports no rate-limit window, and Codex
// spends its own retries and ends as too-many-failed-attempts. Only the Pooler knows when an account
// frees up, so it asks BB for the retry, the way provider-retry does after a subscription reset.

// The same attempt cap, reset buffer and jitter as BB's provider-retry.
const MAX_RETRY_ATTEMPTS = 5;
const RESET_BUFFER_MS = 15_000;
const RESET_JITTER_MS = 30_000;
// When an account can already serve (it freed up between the 429 and the failure), a short pause
// instead of an immediate retry.
const ELIGIBLE_NOW_DELAY_MS = 30_000;
export const RETRY_REASON = "Waiting for an Account Pooler account";

// A BB plugin setting, not part of the Pooler's own config record: that record keeps its five keys
// so an older build can still parse it after a rollback. The choices and default match BB's
// provider-retry, plus Off. A thread capped for days must not wake up on stale context, so the
// default stops at 6 hours and a longer wait fails the turn visibly, as before.
const MAXIMUM_WAITS = {
  Off: 0,
  "1 hour": 60 * 60_000,
  "6 hours": 6 * 60 * 60_000,
  "24 hours": 24 * 60 * 60_000,
  "No limit": Number.POSITIVE_INFINITY,
} as const;
type MaximumWait = keyof typeof MAXIMUM_WAITS;
const DEFAULT_MAXIMUM_WAIT: MaximumWait = "6 hours";
export const RETRY_SETTINGS = {
  autoRetryMaximumWait: {
    type: "select",
    label: "Maximum automatic wait",
    description:
      "When a turn fails because no Account Pooler account is eligible, retry it once one frees up, unless that is farther away than this.",
    options: Object.keys(MAXIMUM_WAITS),
    default: DEFAULT_MAXIMUM_WAIT,
  },
} as const;

// The wait a stored choice allows. An unknown one (from a later build) keeps the default.
export function maximumWaitMs(choice: string): number {
  return Object.hasOwn(MAXIMUM_WAITS, choice)
    ? MAXIMUM_WAITS[choice as MaximumWait]
    : MAXIMUM_WAITS[DEFAULT_MAXIMUM_WAIT];
}

// How many of a thread's latest turn requests are searched for the failed one's model.
export const TURN_REQUEST_PAGE = 20;

const POOLED_PROVIDERS: Readonly<Record<string, PoolProvider>> = {
  "claude-code": "claude",
  codex: "codex",
};

export type PoolerRetryDecision =
  | { kind: "decline"; reason: string }
  | { kind: "retry"; sendAt: number; eligibleAt: number };

// When to retry, given when the Pooler next has an account (null: none known). Pure, for tests.
export function decidePoolerRetry(input: {
  eligibleAt: number | null;
  maxWaitMs: number;
  now: number;
  random: number;
}): PoolerRetryDecision {
  if (input.eligibleAt === null)
    return { kind: "decline", reason: "no account is known to free up" };
  const eligibleAt = Math.max(input.eligibleAt, input.now + ELIGIBLE_NOW_DELAY_MS);
  if (input.eligibleAt - input.now > input.maxWaitMs)
    return {
      kind: "decline",
      reason: `the next account frees up at ${new Date(input.eligibleAt).toISOString()}, beyond the maximum wait of ${Math.round(input.maxWaitMs / 60_000)} minutes`,
    };
  return {
    kind: "retry",
    eligibleAt,
    sendAt:
      eligibleAt + RESET_BUFFER_MS + Math.floor(input.random * RESET_JITTER_MS),
  };
}

export interface PoolerRetryDeps {
  now: () => number;
  random: () => number;
  maxWaitMs: () => number;
  providerOf: (threadId: string) => Promise<string>;
  // Whether the Pooler routes this provider's sessions for the thread: the same test that decides
  // whether it contributes its URL and token to the thread's environment.
  routes: (provider: PoolProvider, threadId: string) => Promise<boolean>;
  // The model the failed turn ran on, or null when its request is not found.
  turnModel: (threadId: string, requestId: string) => Promise<string | null>;
  nextEligibleAt: (provider: PoolProvider, family: ModelFamily) => Promise<number | null>;
  // When the hub's latest 429 told the thread's session to come back, or null when it answered
  // none recently (or the session is unknown). A session pinned to a held account waits for that
  // account even while another one could serve.
  sessionRetryAt: (provider: PoolProvider, threadId: string) => Promise<number | null>;
  retry: (args: {
    threadId: string;
    turnRequestId: string;
    sendAt: number;
    reason: string;
  }) => Promise<unknown>;
  log: (message: string) => void;
}

// Handles one turn.failed. Never throws: every outcome, a decline included, is logged at debug.
export async function handlePoolerTurnFailed(
  deps: PoolerRetryDeps,
  event: PluginTurnFailedEvent,
): Promise<void> {
  const subject = `${event.threadId} (request ${event.requestId}, attempt ${event.attemptNumber})`;
  const decline = (reason: string) =>
    deps.log(`Account Pooler does not retry ${subject}: ${reason}.`);
  try {
    // Codex reports the Pooler's usage-limit answer (a 429 past its 60 s retry limit) by name,
    // with no status.
    if (
      event.errorInfo?.httpStatusCode !== 429 &&
      event.errorInfo?.providerCode !== "usageLimitExceeded"
    )
      return decline("not a 429 or a usage limit");
    if (event.attemptNumber >= MAX_RETRY_ATTEMPTS)
      return decline(`attempt ${MAX_RETRY_ATTEMPTS} reached`);
    const maxWaitMs = deps.maxWaitMs();
    if (maxWaitMs === 0) return decline("automatic retries are off");
    const providerId = await deps.providerOf(event.threadId);
    const provider = POOLED_PROVIDERS[providerId];
    if (provider === undefined)
      return decline(`provider ${providerId} is not pooled`);
    if (!(await deps.routes(provider, event.threadId)))
      return decline(`the Pooler does not route its ${provider} traffic`);
    const model = await deps.turnModel(event.threadId, event.requestId);
    if (model === null) return decline("the failed turn's model is unknown");
    const family = modelFamily(model);
    const nextEligibleAt = await deps.nextEligibleAt(provider, family);
    const sessionRetryAt =
      nextEligibleAt === null ? null : await deps.sessionRetryAt(provider, event.threadId);
    const now = deps.now();
    const decision = decidePoolerRetry({
      eligibleAt:
        nextEligibleAt === null ? null : Math.max(nextEligibleAt, sessionRetryAt ?? nextEligibleAt),
      maxWaitMs,
      now,
      random: deps.random(),
    });
    if (decision.kind === "decline")
      return decline(`${decision.reason} (${provider} ${family})`);
    try {
      await deps.retry({
        threadId: event.threadId,
        turnRequestId: event.requestId,
        sendAt: decision.sendAt,
        reason: RETRY_REASON,
      });
    } catch (error) {
      if (!isRetryAlreadyQueued(error)) throw error;
      deps.log(`Account Pooler found a retry already queued for ${subject}.`);
      return;
    }
    deps.log(
      `Account Pooler retries ${subject} at ${new Date(decision.sendAt).toISOString()}, once a ${provider} ${family} account frees up at ${new Date(decision.eligibleAt).toISOString()}.`,
    );
  } catch (error) {
    deps.log(
      `Account Pooler could not schedule a retry of ${subject}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// BB answers 409 retry_already_queued when the failed turn already has a retry waiting (another
// plugin's, or a person's); one retry is all a failure needs.
function isRetryAlreadyQueued(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code, body } = error as {
    status?: unknown;
    code?: unknown;
    body?: unknown;
  };
  const bodyCode =
    typeof body === "object" && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  return (
    status === 409 &&
    (code === "retry_already_queued" || bodyCode === "retry_already_queued")
  );
}
