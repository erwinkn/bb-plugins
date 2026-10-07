import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { SECRET_COMMAND } from "./redact";
import { available, unavailable, type CheckoutState, type ConversationMessage, type CoordinatorAction, type HandoverSnapshot, type NativeChild, type Read, type WorkerLive } from "./handover-packet";

/**
 * The native half of a handover (W191 audit, F1–F3): the old coordinator's conversation
 * counted in messages, each live worker's native status and latest messages, threads under
 * the coordinator that are not workers, and the checkout the new coordinator will run in.
 * Every read is bounded and timed; a failed one is recorded as unavailable, never as empty.
 */
type Sdk = BbPluginApi["sdk"];
type EventRow = { id?: string; seq: number; type: string; createdAt?: number | string; data?: Record<string, any> };

const PAGE = 100;
/** Conversation targets: about 60 messages, at least the last 10 from the user. */
const COORDINATOR_MESSAGES = 40;
const INPUT_MESSAGES = 30;
const USER_MESSAGES = 10;
/** Scan bounds, in pages of 100 events. */
const ITEM_PAGES = 30;
const INPUT_PAGES = 10;
const TAIL = 3;
const TAIL_PAGES = 5;
const ACTIONS = 20;
const READ_TIMEOUT_MS = 15_000;

const list = (sdk: Sdk, args: Record<string, unknown>) => sdk.threads.events.list(args as never) as Promise<EventRow[]>;
const inputText = (input: unknown) =>
  Array.isArray(input) ? (input as { type?: string; text?: string }[]).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
const timeOf = (row: EventRow) => {
  const v = row.createdAt;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

function timed<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), READ_TIMEOUT_MS); }),
  ]);
}
async function attempt<T>(what: string, read: () => Promise<T>): Promise<Read<T>> {
  try {
    return available(await timed(read(), what));
  } catch (error) {
    return unavailable(reason(error));
  }
}

/** One event as a conversation message, or null. Identity is the event, never its text. */
export function toMessage(row: EventRow): ConversationMessage | null {
  const at = timeOf(row);
  if (row.type === "client/turn/requested") {
    let text = inputText(row.data?.input).trim();
    if (!text) return null;
    const initiator = row.data?.initiator;
    const from = initiator === "user" ? "user" : initiator === "agent" ? "agent" : "system";
    // BB's own envelope lines carry no content.
    text = text.replace(/^\[bb (?:message from thread:\S+|system)\]\s*/, "");
    const id = typeof row.data?.requestId === "string" ? `request:${row.data.requestId}` : `event:${row.id ?? row.seq}`;
    return { id, seq: row.seq, at, from, sender: typeof row.data?.senderThreadId === "string" ? row.data.senderThreadId : null, text };
  }
  if (row.type === "item/completed") {
    const item = row.data?.item as Record<string, unknown> | undefined;
    if (!item || item.parentToolCallId) return null;
    const id = typeof item.id === "string" ? `item:${item.id}` : `event:${row.id ?? row.seq}`;
    // Some providers also record the user's input as a userMessage item.
    if (item.type === "userMessage") {
      const text = inputText(item.content).trim();
      return text ? { id, seq: row.seq, at, from: "user", sender: null, text } : null;
    }
    if (item.type !== "agentMessage" || typeof item.text !== "string" || !item.text.trim()) return null;
    return { id, seq: row.seq, at, from: "coordinator", sender: null, text: item.text.trim() };
  }
  return null;
}

/**
 * Commands that change something outside the ledger: what the coordinator did, which its
 * messages may not say (it updated an automation, merged a PR, pushed). Read-only commands
 * are left out.
 */
const OUTSIDE_EFFECT = /\b(?:bb automation (?:create|update|delete|enable|disable)|bb plugin (?:install|remove|reload)|gh (?:pr (?:merge|close|create|ready|reopen)|release create|workflow run|issue (?:create|close))|git push|(?:npm|pnpm) publish|wrangler (?:deploy|publish))\b/;
export function toAction(row: EventRow): CoordinatorAction | null {
  const item = row.data?.item as Record<string, unknown> | undefined;
  if (row.type !== "item/completed" || !item || item.parentToolCallId || item.type !== "commandExecution" || typeof item.command !== "string") return null;
  if (!OUTSIDE_EFFECT.test(item.command) || SECRET_COMMAND.test(item.command)) return null;
  const exit = item.exitCode === undefined || item.exitCode === null ? null : Number(item.exitCode);
  return { seq: row.seq, at: timeOf(row), command: item.command, exitCode: Number.isFinite(exit) ? exit : null };
}

/**
 * Page one event type backwards until `enough` holds or the scan bound is reached. `keep`
 * sees every message, newest first, and says whether it joins the conversation.
 */
async function pageBack(sdk: Sdk, threadId: string, type: string, pages: number, enough: (messages: ConversationMessage[], oldestSeq: number | null) => boolean, keep: (m: ConversationMessage, kept: number) => boolean = () => true, onRow: (row: EventRow) => void = () => {}) {
  const messages: ConversationMessage[] = [];
  let before: number | null = null;
  let oldestSeq: number | null = null;
  for (let page = 0; page < pages; page++) {
    const rows = await list(sdk, { threadId, types: [type], order: "desc", limit: String(PAGE), ...(before !== null ? { beforeSeq: String(before) } : {}) });
    // An API that ignores beforeSeq would return the same page forever: keep only older rows.
    const older = rows.filter(r => r.type === type && (before === null || r.seq < before));
    for (const row of [...older].sort((a, b) => b.seq - a.seq)) {
      onRow(row);
      const m = toMessage(row);
      if (m && keep(m, messages.length)) messages.push(m);
    }
    if (older.length) oldestSeq = Math.min(...older.map(r => r.seq));
    if (rows.length < PAGE || !older.length) return { messages, complete: true, oldestSeq };
    before = oldestSeq;
    if (enough(messages, oldestSeq)) break;
  }
  return { messages, complete: false, oldestSeq };
}

/**
 * The old coordinator's conversation, oldest first (F3). Inputs (the user, other threads, BB)
 * are paged first, then the coordinator's own messages, so a long run of tool calls never
 * crowds out the user's messages. Duplicates are dropped by event identity. Past its newest
 * messages, and within its page bound, the coordinator scan keeps two kinds of older message:
 * the final answer each user message received (the coordinator's last message before the next
 * input), and the latest message naming each open task (`taskRefs`), so neither an
 * instruction nor a task reads as undone when its completion is older than the window.
 */
export async function readConversation(sdk: Sdk, threadId: string, taskRefs: string[] = []): Promise<Conversation> {
  const inputs = await pageBack(sdk, threadId, "client/turn/requested", INPUT_PAGES, ms => ms.filter(m => m.from === "user").length >= USER_MESSAGES && ms.filter(m => m.from !== "system").length >= INPUT_MESSAGES);
  const ordered = [...inputs.messages].sort((a, b) => a.seq - b.seq);
  // Each user message's turn ends before the next input arrives.
  const asked = ordered.flatMap((m, i) => (m.from === "user" ? [{ id: m.id, seq: m.seq, until: ordered[i + 1]?.seq ?? Infinity }] : []));
  const answers: Record<string, ConversationMessage> = {};
  const mentions: Record<string, ConversationMessage> = {};
  const tasks = new Set(taskRefs);
  const note = (m: ConversationMessage) => {
    if (m.from !== "coordinator") return false;
    let useful = false;
    for (const ref of [...tasks]) if (new RegExp(`\\b${ref}\\b`).test(m.text)) { mentions[ref] = m; tasks.delete(ref); useful = true; }
    // Newest first: the first coordinator message seen inside a user's turn is its final answer.
    const turn = asked.find(a => a.seq < m.seq && m.seq < a.until && !answers[a.id]);
    if (turn) { answers[turn.id] = m; useful = true; }
    return useful;
  };
  const oldestAsked = asked[0]?.seq ?? Infinity;
  const actions: CoordinatorAction[] = [];
  const replies = await pageBack(sdk, threadId, "item/completed", ITEM_PAGES,
    (ms, oldest) => ms.length >= COORDINATOR_MESSAGES && !tasks.size && (oldest === null || oldest < oldestAsked),
    (m, kept) => { note(m); return kept < COORDINATOR_MESSAGES; },
    row => { const a = actions.length < ACTIONS ? toAction(row) : null; if (a) actions.push(a); });
  // Where both streams were scanned: older inputs stay (the user's words matter most), but
  // BB notices from before the coordinator's scanned replies add nothing.
  const replyStart = replies.complete ? null : replies.oldestSeq;
  const seen = new Set<string>();
  const messages = [...inputs.messages, ...replies.messages]
    .filter(m => !(m.from === "system" && replyStart !== null && m.seq < replyStart))
    .sort((a, b) => a.seq - b.seq)
    .filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  // A userMessage item records the same input as the turn request just before it: pair each
  // item with the nearest earlier unpaired request of the same text, one to one, and keep the
  // request. Two identical messages sent at different times both stay.
  const paired = new Set<string>();
  const kept = messages.filter((m, i) => {
    if (m.from !== "user" || m.id.startsWith("request:")) return true;
    for (let j = i - 1; j >= 0; j--) {
      const r = messages[j]!;
      if (r.from === "user" && r.id.startsWith("request:") && !paired.has(r.id) && r.text === m.text) {
        paired.add(r.id);
        return false;
      }
    }
    return true;
  });
  return { messages: kept, complete: inputs.complete && replies.complete, taskMentions: mentions, answers, actions: actions.reverse() };
}
type Conversation = { messages: ConversationMessage[]; complete: boolean; taskMentions: Record<string, ConversationMessage>; answers: Record<string, ConversationMessage>; actions: CoordinatorAction[] };

/**
 * A worker's latest substantive messages, oldest first (W194 #7). Pages back past tool calls
 * until it has TAIL messages of some length or reaches its bound; `complete` is false when the
 * bound stopped it, so "none" is never claimed for a thread that was not fully read.
 */
async function workerTail(sdk: Sdk, threadId: string): Promise<{ messages: ConversationMessage[]; complete: boolean }> {
  const substantive = (m: ConversationMessage) => m.text.length >= 80;
  const scan = await pageBack(sdk, threadId, "item/completed", TAIL_PAGES, ms => ms.filter(substantive).length >= TAIL);
  const picked = scan.messages.filter(substantive);
  return { messages: (picked.length ? picked : scan.messages).slice(0, TAIL).reverse(), complete: scan.complete || picked.length >= TAIL };
}

/**
 * What a handover is written from (F1, W194 #1–#2): one stable value per packet source. A read
 * that fails is "absent" when BB proved the thing missing (404) and "unavailable" otherwise,
 * never a fresh timestamp, so the same failure gives the same fingerprint and recovery from a
 * missing coordinator converges.
 */
export interface HandoverState {
  v: 2;
  incumbent: string | null;
  /** status, latest user input, latest activity (any message or tool event), outgoing checkout. */
  coordinator: { status: string; user: string; activity: string; home: string };
  /** Per live worker: native status, latest event, pull request. */
  workers: Record<string, string>;
  children: string;
  checkout: string;
  ledger: number;
}

const failed = (error: unknown) => ((error as { status?: number })?.status === 404 ? "absent" : "unavailable");
async function mark(read: () => Promise<string | number>): Promise<string> {
  try {
    return String(await timed(read(), "read"));
  } catch (error) {
    return failed(error);
  }
}
/** The latest event of these types in a thread, as a sequence number. */
const latestSeq = async (sdk: Sdk, threadId: string, types: string[]) =>
  (await list(sdk, { threadId, types, order: "desc", limit: "1" })).reduce((max, r) => Math.max(max, r.seq), 0);
/** The latest input the user typed, within three pages of inputs. */
async function latestUserInput(sdk: Sdk, threadId: string) {
  let before: number | null = null;
  for (let page = 0; page < 3; page++) {
    const rows = await list(sdk, { threadId, types: ["client/turn/requested"], order: "desc", limit: String(PAGE), ...(before !== null ? { beforeSeq: String(before) } : {}) });
    const user = rows.filter(r => r.data?.initiator === "user").sort((a, b) => b.seq - a.seq)[0];
    if (user) return user.seq;
    if (rows.length < PAGE) return "none";
    before = Math.min(...rows.map(r => r.seq));
  }
  return "none in the last 300 inputs";
}
const homeOf = async (sdk: Sdk, threadId: string) => {
  const environmentId = (await sdk.threads.get({ threadId })).environmentId;
  if (!environmentId) return "none";
  const env = (await sdk.environments.get({ environmentId })) as { path?: string | null; hostId?: string | null };
  return `${env.hostId ?? "?"}:${env.path ?? "?"}`;
};
const checkoutMark = (c: CheckoutState) =>
  `${c.hostId}:${c.path} ${c.branch}@${c.headSha} +${c.ahead}-${c.behind} ~${c.changedFiles} ${c.sampleFiles.join(",")} ${c.commits.map(k => k.shortSha).join(",")}`;
const pullRequestMark = (pr: { number: number | null; state: string } | null) => (pr ? `#${pr.number}:${pr.state}` : "none");

export async function readHandoverState(sdk: Sdk, store: Store, projectId: string, options: { destination: Destination }): Promise<HandoverState> {
  const project = store.project(projectId);
  const coordinator = project?.coordinatorThreadId ?? null;
  const all = store.workers(projectId);
  const registered = new Set(all.map(w => w.threadId).filter(Boolean));
  const live = all.filter(w => w.state !== "retired" && w.threadId);
  const [status, user, activity, home, workers, children, checkout] = await Promise.all([
    coordinator ? mark(async () => (await sdk.threads.get({ threadId: coordinator })).status) : "none",
    coordinator ? mark(() => latestUserInput(sdk, coordinator)) : "none",
    coordinator ? mark(() => latestSeq(sdk, coordinator, ["item/completed", "client/turn/requested"])) : "none",
    coordinator ? mark(() => homeOf(sdk, coordinator)) : "none",
    Promise.all(live.map(async w => {
      const [native, last, pr] = await Promise.all([
        mark(async () => { const t = await sdk.threads.get({ threadId: w.threadId! }); return `${t.archivedAt ? "archived" : t.status}/${t.queuedMessageCount ?? 0}/${t.activeBackgroundAgentCount ?? 0}`; }),
        mark(() => latestSeq(sdk, w.threadId!, ["item/completed"])),
        w.environmentId ? mark(async () => pullRequestMark(await readPullRequest(sdk, w.environmentId!))) : "none",
      ]);
      return [w.ref, `${native}@${last}#${pr}`] as const;
    })),
    coordinator ? mark(async () => (await listChildren(sdk, coordinator, registered)).map(c => `${c.threadId}:${c.status}`).sort().join(",")) : "none",
    mark(async () => checkoutMark(await readCheckout(sdk, await options.destination()))),
  ]);
  return { v: 2, incumbent: coordinator, coordinator: { status, user, activity, home }, workers: Object.fromEntries(workers), children, checkout, ledger: store.ledgerStamp(projectId) };
}

export async function handoverFingerprint(sdk: Sdk, store: Store, projectId: string, options: { destination: Destination }): Promise<string> {
  return JSON.stringify(await readHandoverState(sdk, store, projectId, options));
}

/**
 * Whether a draft's saved fingerprint still holds against the current state (F1).
 * - preview: every source must be unchanged.
 * - replacement (captured once the replacement could run): the incumbent and its conversation
 *   must be unchanged. Workers and the ledger are excluded on purpose: they keep moving while
 *   Luna writes, and rewriting for them could never converge on a busy Initiative.
 * - final (a replacement draft written again): only the user's own input must be unchanged, so
 *   a coordinator woken by worker notices cannot keep the replacement from starting.
 */
export function fingerprintHolds(saved: string, current: HandoverState, purpose: "preview" | "replacement" | "final"): "holds" | "stale" | "unknown" {
  let then: HandoverState;
  try {
    then = JSON.parse(saved) as HandoverState;
  } catch {
    return "stale";
  }
  if (then?.v !== 2 || then.incumbent !== current.incumbent) return "stale";
  // W194: a live coordinator whose input could not be read may have just said "stop": hold and
  // read again. Only a thread BB proved gone ("absent") is a stable answer.
  const compared = purpose === "final" ? ["user"] as const : ["user", "activity"] as const;
  if (compared.some(key => current.coordinator[key] === "unavailable")) return "unknown";
  if (compared.some(key => then.coordinator[key] !== current.coordinator[key])) return "stale";
  if (purpose !== "preview") return "holds";
  return JSON.stringify(then) === JSON.stringify(current) ? "holds" : "stale";
}

/** The latest user input of a thread as a fingerprint value: the last read before a coordinator starts. */
export const readUserMark = (sdk: Sdk, threadId: string) => mark(() => latestUserInput(sdk, threadId));

async function readCheckout(sdk: Sdk, environmentId: string): Promise<CheckoutState> {
  const envs = sdk.environments as Sdk["environments"] & { status?: Sdk["environments"]["status"] };
  if (typeof envs.status !== "function") throw new Error("this BB version cannot report checkout status");
  const status = await envs.status({ environmentId });
  const env = (await sdk.environments.get({ environmentId })) as { path?: string | null; hostId?: string | null };
  if (status.outcome === "not_applicable") throw new Error(status.message);
  if (status.outcome === "unavailable") throw new Error(status.failure.message);
  const w = status.workspace;
  const files = w.workingTree.files;
  return {
    environmentId,
    path: env.path ?? null,
    hostId: env.hostId ?? null,
    branch: w.checkout.kind === "branch" ? w.checkout.branchName : w.checkout.kind === "detached" ? "(detached)" : w.branch.currentBranch,
    headSha: "headSha" in w.checkout ? w.checkout.headSha : null,
    defaultBranch: w.branch.defaultBranch,
    ahead: w.mergeBase?.aheadCount ?? null,
    behind: w.mergeBase?.behindCount ?? null,
    changedFiles: files.length,
    sampleFiles: [...new Set(files.map(f => `${f.status} ${f.path}`))].slice(0, 8),
    commits: (w.mergeBase?.commits ?? []).slice(0, 8).map(c => ({ shortSha: c.shortSha, subject: c.subject, at: c.authoredAt })),
  };
}

async function readPullRequest(sdk: Sdk, environmentId: string) {
  const envs = sdk.environments as Sdk["environments"] & { pullRequest?: Sdk["environments"]["pullRequest"] };
  if (typeof envs.pullRequest !== "function") throw new Error("this BB version cannot report pull requests");
  const pr = await envs.pullRequest({ environmentId });
  if (pr.outcome === "absent") return null;
  if (pr.outcome === "unavailable") throw new Error(pr.message);
  return { number: pr.pullRequest.number, state: pr.pullRequest.state, title: pr.pullRequest.title };
}

/** Resolves the environment the replacement coordinator will run in, or throws why it can't. */
export type Destination = () => Promise<string>;

async function listChildren(sdk: Sdk, coordinator: string, registered: Set<string | null>): Promise<NativeChild[]> {
  const rows = (await sdk.threads.list({ parentThreadId: coordinator, limit: 100 })) as { id: string; title?: string | null; status: string; createdAt?: number | string; archivedAt?: unknown; deletedAt?: unknown }[];
  return rows
    .filter(t => !registered.has(t.id) && !t.archivedAt && !t.deletedAt)
    .map((t): NativeChild => ({ threadId: t.id, title: t.title ?? null, status: t.status, createdAt: timeOf({ seq: 0, type: "", createdAt: t.createdAt }) }));
}

export async function captureHandoverSnapshot(
  sdk: Sdk,
  store: Store,
  projectId: string,
  options: { now: number; destination: Destination },
): Promise<HandoverSnapshot> {
  const project = store.project(projectId)!;
  const coordinator = project.coordinatorThreadId;
  const live = store.workers(projectId).filter(w => w.state !== "retired");
  const registered = new Set(store.workers(projectId).map(w => w.threadId).filter(Boolean));
  const [incumbent, home, conversation, workers, children, checkout] = await Promise.all([
    coordinator ? attempt("coordinator status", async () => (await sdk.threads.get({ threadId: coordinator })).status) : Promise.resolve(unavailable<string>("no coordinator")),
    coordinator
      ? attempt("outgoing checkout", async () => {
          const environmentId = (await sdk.threads.get({ threadId: coordinator })).environmentId ?? null;
          if (!environmentId) return null;
          const env = (await sdk.environments.get({ environmentId })) as { path?: string | null; hostId?: string | null };
          return { environmentId, path: env.path ?? null, hostId: env.hostId ?? null };
        })
      : Promise.resolve(unavailable<null>("no coordinator")),
    coordinator
      ? attempt("conversation", () => readConversation(sdk, coordinator, store.tasks(projectId).filter(t => !["done", "cancelled"].includes(t.status)).map(t => t.ref)))
      : Promise.resolve(unavailable<Conversation>("no coordinator")),
    Promise.all(live.filter(w => w.threadId).map(async (w): Promise<[string, WorkerLive]> => {
      const threadId = w.threadId!;
      const [status, tail, pullRequest] = await Promise.all([
        attempt("worker status", async () => {
          const t = await sdk.threads.get({ threadId });
          return { status: t.archivedAt ? "archived" : t.status, queued: t.queuedMessageCount ?? 0, background: t.activeBackgroundAgentCount ?? 0 };
        }),
        attempt("worker messages", () => workerTail(sdk, threadId)),
        w.environmentId ? attempt("pull request", () => readPullRequest(sdk, w.environmentId!)) : Promise.resolve(undefined),
      ]);
      return [w.ref, { threadId, status, tail, ...(pullRequest && (!pullRequest.ok || pullRequest.value) ? { pullRequest } : {}) }];
    })),
    coordinator ? attempt("child threads", () => listChildren(sdk, coordinator, registered)) : Promise.resolve(unavailable<NativeChild[]>("no coordinator")),
    attempt("destination checkout", async () => readCheckout(sdk, await options.destination())),
  ]);
  return {
    capturedAt: options.now,
    incumbent: { threadId: coordinator, status: incumbent, home },
    conversation,
    workers: Object.fromEntries(workers),
    children,
    checkout,
  };
}
