// A fake BB world behind the SDK's official fake plugin host: threads, their
// persisted event logs (installed paging contract: limit <= 100, strict
// cursors, bare arrays), environments with git status, listings and patches,
// and the Pooler plugin token. No network, no real threads.

import { appendFileSync } from "node:fs";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createAdvisorPlugin, type AdvisorPluginOptions } from "../../server.js";
import type { Advisor } from "../../src/runtime/advisor.js";
import { unavailableInitiatives } from "../../src/runtime/initiatives.js";
import type { Store } from "../../src/store/store.js";
import type { EventQuery, EventRow } from "../../src/rules/events.js";
import { NativeEvents } from "./a160.js";

export class Clock {
  constructor(public t = Date.UTC(2026, 9, 5, 10, 0, 0)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface EnvState {
  head: string | null;
  files: Array<{ path: string; binary?: boolean }>;
  patches: Record<string, string>;
  truncated?: boolean;
  path: string;
}

export class FakeWorld {
  threads = new Map<string, any>();
  events = new Map<string, EventRow[]>();
  envs = new Map<string, EnvState>();
  queries: Array<{ threadId: string } & EventQuery> = [];
  tokenCalls = 0;
  failGet = new Set<string>();
  /** threads.spawn calls (Discuss only; the Advisor never writes to a watched thread). */
  spawns: any[] = [];
  /** The next spawns that fail (BB refusing the create). */
  failSpawns = 0;
  /** What the Pooler's advisor.get answers; an Error is thrown, as for an absent plugin. */
  poolerAdvisor: unknown = new Error("no advisor.get");

  constructor(public clock: Clock) {}

  addThread(id: string, over: Record<string, unknown> = {}) {
    const t = makeThreadResponse({ id, title: `thread ${id}`, parentThreadId: null, archivedAt: null, environmentId: `env_${id}`, createdAt: this.clock.now(), ...over } as any);
    this.threads.set(id, t);
    this.events.set(id, []);
    if (!this.envs.has(`env_${id}`)) this.envs.set(`env_${id}`, { head: "h1", files: [], patches: {}, path: "/repo" });
    return t;
  }

  private seq(threadId: string) {
    const rows = this.events.get(threadId)!;
    return rows.length === 0 ? 0 : rows[rows.length - 1]!.seq;
  }

  /** Append one event; seq increases by one, createdAt is the clock unless given. */
  emit(threadId: string, type: string, data: Record<string, any>, createdAt?: number): EventRow {
    const seq = this.seq(threadId) + 1;
    const row = { id: `ev_${threadId}_${seq}`, scope: { kind: "thread" }, threadId, seq, createdAt: createdAt ?? this.clock.now(), type, data: { threadId, ...data } } as EventRow & Record<string, any>;
    this.events.get(threadId)!.push(row);
    return row;
  }

  request(threadId: string, rid: string, text: string, sender: string | null = null) {
    return this.emit(threadId, "client/turn/requested", {
      requestId: rid,
      senderThreadId: sender,
      initiator: sender ? "agent" : "user",
      source: sender ? "tell" : "spawn",
      input: [{ type: "text", text }],
      request: { method: "turn/start", params: {} },
      target: { kind: "new-turn" },
    });
  }
  accept(threadId: string, rid: string) {
    return this.emit(threadId, "turn/input/accepted", { clientRequestId: rid, providerThreadId: "p", scope: { kind: "thread" } });
  }
  turnStart(threadId: string) {
    return this.emit(threadId, "turn/started", { providerThreadId: "p" });
  }
  fileChange(threadId: string, path: string, diff: string | undefined, status = "completed") {
    return this.emit(threadId, "item/completed", {
      providerThreadId: "p",
      item: { type: "fileChange", id: `fc_${this.seq(threadId) + 1}`, status, approvalStatus: null, changes: [{ kind: "update", path, ...(diff !== undefined ? { diff } : {}) }] },
    });
  }
  command(threadId: string, command: string, exitCode: number, output = "") {
    return this.emit(threadId, "item/completed", {
      providerThreadId: "p",
      item: { type: "commandExecution", id: `c_${this.seq(threadId) + 1}`, status: exitCode === 0 ? "completed" : "failed", command, cwd: "/repo", exitCode, aggregatedOutput: output, approvalStatus: null },
    });
  }
  agentMessage(threadId: string, text: string) {
    return this.emit(threadId, "item/completed", { providerThreadId: "p", item: { type: "agentMessage", id: `m_${this.seq(threadId) + 1}`, text } });
  }
  turnEnd(threadId: string, status = "completed") {
    return this.emit(threadId, "turn/completed", { providerThreadId: "p", status });
  }
  interrupt(threadId: string) {
    return this.emit(threadId, "system/thread/interrupted", { reason: "manual-stop" });
  }
  ownership(threadId: string, prev: string | null, next: string | null) {
    return this.emit(threadId, "system/operation", {
      operation: "ownership_change",
      operationId: `op${this.seq(threadId) + 1}`,
      status: "completed",
      message: "m",
      metadata: { action: "transfer", previousParentThreadId: prev, nextParentThreadId: next },
    });
  }

  /** SDK overrides for createFakePluginHost. */
  sdk() {
    const world = this;
    return {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (world.failGet.has(threadId)) throw Object.assign(new Error("threads.get failed"), { status: 503 });
          const t = world.threads.get(threadId);
          if (!t) throw Object.assign(new Error(`thread ${threadId} not found`), { status: 404 });
          return t;
        },
        list: async (args: { projectId?: string }) => [...world.threads.values()].filter((t) => !args.projectId || t.projectId === args.projectId),
        spawn: async (args: any) => {
          await new Promise((r) => setTimeout(r, 5)); // a real spawn takes a while: concurrent callers overlap
          if (world.failSpawns > 0) {
            world.failSpawns--;
            throw new Error("spawn refused");
          }
          world.spawns.push(args);
          return world.addThread(`thr_spawned_${world.spawns.length}`, { title: args.title ?? null });
        },
        events: {
          list: async (args: { threadId: string } & EventQuery) => {
            const { threadId, signal: _s, ...q } = args as any;
            world.queries.push({ threadId, ...q });
            if (process.env.ADVISOR_DUMP_QUERIES) appendFileSync(process.env.ADVISOR_DUMP_QUERIES, JSON.stringify(q) + "\n");
            return new NativeEvents(world.events.get(threadId) ?? []).listSync(q);
          },
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, path: world.envs.get(environmentId)?.path ?? null }),
        status: async ({ environmentId }: { environmentId: string }) => {
          const e = world.envs.get(environmentId)!;
          return {
            outcome: "available",
            workspace: { checkout: e.head === null ? { kind: "unknown", reason: "x" } : { kind: "branch", branchName: "main", headSha: e.head } },
          };
        },
        diffFiles: async ({ environmentId }: { environmentId: string }) => {
          const e = world.envs.get(environmentId)!;
          return {
            outcome: "available",
            files: e.files.map((f) => ({ path: f.path, binary: f.binary ?? false, additions: 1, deletions: 1, changeKind: "modified", loadMode: "auto", origin: "tracked", previousPath: null })),
            initialPatches: [],
            mergeBaseRef: null,
            shortstat: "",
            truncated: e.truncated ?? false,
          };
        },
        diffPatch: async ({ environmentId, paths }: { environmentId: string; paths: string[] }) => {
          const e = world.envs.get(environmentId)!;
          return { outcome: "available", patches: paths.map((p) => ({ path: p, patch: e.patches[p] ?? "", truncated: false })) };
        },
      },
      plugins: {
        token: async () => {
          world.tokenCalls++;
          return { ok: true, token: "tok-advisor" };
        },
        callRpc: async () => {
          if (world.poolerAdvisor instanceof Error) throw world.poolerAdvisor;
          return world.poolerAdvisor;
        },
      },
    } as any;
  }
}

export interface Rig {
  world: FakeWorld;
  clock: Clock;
  advisor: Advisor;
  store: Store;
  bb: any;
  harness: any;
  tick(): Promise<void>;
  reload(opts?: Partial<AdvisorPluginOptions>): Promise<void>;
}

export async function rig(settings: Record<string, any> = {}, opts: Partial<AdvisorPluginOptions> = {}, world?: FakeWorld): Promise<Rig> {
  const clock = world?.clock ?? new Clock();
  const w = world ?? new FakeWorld(clock);
  let ready: { advisor: Advisor; store: Store } | null = null;
  const { bb, harness } = createFakePluginHost({ pluginId: "advisor", sdk: w.sdk(), settings });
  const make = (o: Partial<AdvisorPluginOptions>) =>
    createAdvisorPlugin({
      now: clock.now,
      sleep: async () => {},
      fetch: async () => {
        throw new Error("no network in tests");
      },
      initiatives: unavailableInitiatives,
      ...opts,
      ...o,
      onReady: (r) => (ready = r),
    });
  await make({})(bb);
  const r: Rig = {
    world: w,
    clock,
    advisor: ready!.advisor,
    store: ready!.store,
    bb,
    harness,
    async tick() {
      await r.advisor.tick(new AbortController().signal);
      await r.advisor.idle();
    },
    async reload(o = {}) {
      const next = await r.harness.lifecycle.reload(make(o));
      r.bb = next.bb;
      r.harness = next.harness;
      r.advisor = ready!.advisor;
      r.store = ready!.store;
    },
  };
  return r;
}

/** A unified diff of one changed line, as a provider sends it in fileChange.diff. */
export function oneLineDiff(line: number, before: string, after: string, ctxBefore: string[] = [], ctxAfter: string[] = []): string {
  const start = line - ctxBefore.length;
  const n = ctxBefore.length + 1 + ctxAfter.length;
  return [`@@ -${start},${n} +${start},${n} @@`, ...ctxBefore.map((l) => ` ${l}`), `-${before}`, `+${after}`, ...ctxAfter.map((l) => ` ${l}`)].join("\n");
}
