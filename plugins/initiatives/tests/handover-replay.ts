import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { memoryStore } from "./helpers";
import type { Store } from "../lib/store";

/**
 * W188: the nine real coordinator handovers of Oct 7 (W191 audit) as replayable fixtures.
 * Each holds the old coordinator's conversation cut at the replacement, the ledger rolled
 * back to that moment, native thread status and children, the worker message logs the audit
 * collected, and the destination checkout where the audit established it. Anything the audit
 * did not collect answers as a failed read, so the packet must show it as unavailable.
 */
const DIR = new URL("./fixtures/handover/", import.meta.url);

type Message =
  | { seq: number; at: number | null; type: "item/completed"; id: string | null; item: "agentMessage" | "userMessage" | "commandExecution"; text: string; exitCode?: string | number | null }
  | { seq: number; at: number | null; type: "client/turn/requested"; requestId: string | null; initiator: string; sender: string | null; text: string };
interface ThreadFact { status: string; title: string | null; parentThreadId: string | null; createdAt: number | null; archivedAt: number | null; queued: number; background: number }
export interface ReplayCase {
  case: string;
  name: string;
  projectId: string;
  oldCoordinator: string;
  replacementAt: number;
  notes: string[];
  ledger: { project: Record<string, unknown>; workers: Row[]; tasks: Row[]; assignments: Row[]; knowledge: Row[]; updates: Row[] };
  threads: Record<string, ThreadFact>;
  events: Record<string, { messages: Message[]; fillerItemSeqs: number[] }>;
  workerLogs: number[];
  checkout: null | { path: string; hostId: string; branch: string; headSha: string | null; defaultBranch: string; ahead: number; behind: number; changedFiles: number; source: string };
  /** Where the outgoing coordinator ran, when the audit established it (RM1). */
  outgoing?: { path: string; hostId: string; source: string } | null;
}
type Row = Record<string, unknown>;

export const replayCases = () => readdirSync(DIR).filter(f => f.endsWith(".json.gz")).map(f => f.replace(/\.json\.gz$/, "")).sort();
export const loadCase = (name: string): ReplayCase => JSON.parse(gunzipSync(readFileSync(new URL(`${name}.json.gz`, DIR))).toString("utf8"));
/** Every string in a fixture, decoded (JSON kept as text in ledger columns too), for the credential check. */
export function fixtureStrings(name: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (/^[[{]/.test(value)) try { return walk(JSON.parse(value)); } catch { /* plain text */ }
      out.push(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(JSON.parse(gunzipSync(readFileSync(new URL(`${name}.json.gz`, DIR))).toString("utf8")));
  return out;
}

function insert(store: Store, table: string, row: Row) {
  const columns = new Set((store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
  const entries = Object.entries(row).filter(([key]) => columns.has(key));
  const value = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? Number(v) : v);
  store.db.prepare(`INSERT INTO ${table} (${entries.map(([k]) => k).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`).run(...entries.map(([, v]) => value(v)));
}

/** The ledger as it stood at the replacement, in a fresh store whose clock reads that moment. */
export function replayStore(fx: ReplayCase): Store {
  const { store } = memoryStore(fx.replacementAt);
  insert(store, "projects", fx.ledger.project);
  for (const [table, rows] of [["workers", fx.ledger.workers], ["tasks", fx.ledger.tasks], ["assignments", fx.ledger.assignments], ["knowledge", fx.ledger.knowledge], ["updates", fx.ledger.updates]] as const)
    for (const row of rows) insert(store, table, row);
  return store;
}

const notCollected = () => Object.assign(new Error("not collected by the audit"), { status: 503 });

/** A BB SDK that answers from the fixture, with the real API's paging rules (per type, 100 per page). */
const DEST = "env_destination", OUTGOING = "env_outgoing";
/** The replacement's checkout as the service resolves it: the default source's environment. */
export const replayDestination = (fx: ReplayCase) => async () => {
  if (!fx.checkout) throw notCollected();
  return DEST;
};

export function replaySdk(fx: ReplayCase): BbPluginApi["sdk"] {
  const rowsOf = (threadId: string) => {
    const e = fx.events[threadId];
    if (!e) return null;
    const rows = e.messages.map(m => m.type === "item/completed"
      ? { id: `ev_${m.seq}`, seq: m.seq, createdAt: m.at, type: m.type, data: { item: m.item === "agentMessage" ? { id: m.id, type: "agentMessage", text: m.text } : m.item === "commandExecution" ? { id: m.id, type: "commandExecution", command: m.text, exitCode: m.exitCode ?? null } : { id: m.id, type: "userMessage", content: [{ type: "text", text: m.text }] } } }
      : { id: `ev_${m.seq}`, seq: m.seq, createdAt: m.at, type: m.type, data: { requestId: m.requestId, initiator: m.initiator, senderThreadId: m.sender, input: [{ type: "text", text: m.text }] } });
    for (const seq of e.fillerItemSeqs) rows.push({ id: `ev_${seq}`, seq, createdAt: null, type: "item/completed", data: { item: { id: null, type: "commandExecution", text: "" } } });
    return rows;
  };
  const thread = (threadId: string) => {
    const t = fx.threads[threadId];
    if (!t) throw notCollected();
    return { id: threadId, status: t.status === "archived" ? "idle" : t.status, archivedAt: t.archivedAt, deletedAt: null, queuedMessageCount: t.queued, activeBackgroundAgentCount: t.background, environmentId: threadId === fx.oldCoordinator ? OUTGOING : null, title: t.title, parentThreadId: t.parentThreadId, createdAt: t.createdAt };
  };
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => thread(threadId),
      list: async ({ parentThreadId }: { parentThreadId?: string }) => Object.keys(fx.threads).filter(id => fx.threads[id]!.parentThreadId === parentThreadId).map(thread),
      events: {
        list: async (args: { threadId: string; types?: string[]; order?: string; limit?: string; beforeSeq?: string; afterSeq?: string }) => {
          const rows = rowsOf(args.threadId);
          if (!rows) throw notCollected();
          const limit = Math.min(100, Number(args.limit ?? 100));
          // The real API limits each requested type separately.
          return (args.types ?? [...new Set(rows.map(r => r.type))]).flatMap(type =>
            rows.filter(r => r.type === type && (args.beforeSeq === undefined || r.seq < Number(args.beforeSeq)) && (args.afterSeq === undefined || r.seq > Number(args.afterSeq)))
              .sort((a, b) => (args.order === "asc" ? a.seq - b.seq : b.seq - a.seq)).slice(0, limit));
        },
      },
    },
    environments: {
      get: async ({ environmentId }: { environmentId: string }) => {
        if (environmentId === OUTGOING && fx.outgoing) return { id: OUTGOING, path: fx.outgoing.path, hostId: fx.outgoing.hostId };
        if (environmentId !== DEST || !fx.checkout) throw notCollected();
        return { id: DEST, path: fx.checkout.path, hostId: fx.checkout.hostId };
      },
      status: async ({ environmentId }: { environmentId: string }) => {
        if (environmentId !== DEST || !fx.checkout) throw notCollected();
        const c = fx.checkout;
        return {
          outcome: "available",
          workspace: {
            branch: { currentBranch: c.branch, defaultBranch: c.defaultBranch },
            checkout: { kind: "branch", branchName: c.branch, headSha: c.headSha },
            mergeBase: { aheadCount: c.ahead, behindCount: c.behind, baseRef: `origin/${c.defaultBranch}`, commits: [], deletions: 0, files: [], hasCommittedUnmergedChanges: false, insertions: 0, lineStatsComplete: true, mergeBaseBranch: c.defaultBranch },
            workingTree: { files: Array.from({ length: c.changedFiles }, () => ({ path: "(name not recorded)", status: "M", insertions: null, deletions: null })), deletions: 0, insertions: 0, hasUncommittedChanges: c.changedFiles > 0, lineStatsComplete: false, state: c.changedFiles ? "dirty_uncommitted" : "clean" },
          },
        };
      },
      pullRequest: async () => { throw notCollected(); },
    },
  };
  return sdk as unknown as BbPluginApi["sdk"];
}
