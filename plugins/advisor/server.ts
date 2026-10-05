// BB Advisor backend: watches selected threads, keeps immutable evidence, and
// (only when explicitly enabled) asks a tools-less reviewer for findings with
// mechanically checked citations. It never writes to a watched thread, its
// files, or any Initiative record.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { POOLER_PLUGIN_ID, poolerAdvisorStatus } from "./src/config/routes.js";
import { SECRET_KEYS, settingsDescriptors } from "./src/config/settings.js";
import { rpcContract, type SettingsView } from "./src/rpc.js";
import { Advisor } from "./src/runtime/advisor.js";
import { sdkHost, type AdvisorHost } from "./src/runtime/host.js";
import { DEFERRED_STAGES, type InitiativeSource } from "./src/runtime/initiatives.js";
import { PROJECTS_PLUGIN_ID, projectsInitiatives } from "./src/runtime/projects.js";
import { openStore } from "./src/store/store.js";
import type { FetchLike } from "./src/transport/types.js";
import type { TransportDeps } from "./src/transport/transports.js";
import { cardView, feedView, feedWatchIds, findingView, initiativeWatchView, memberView, overview, routesTable, unseenTotal, watchDetail, watchSummary } from "./src/views.js";
import { discussionPrompt } from "./src/discuss.js";
import { runCli } from "./src/cli.js";

export { rpcContract };
export type { AdvisorRpc } from "./src/rpc.js";

export interface AdvisorPluginOptions {
  host?: AdvisorHost;
  initiatives?: InitiativeSource;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  loopbackBaseUrl?: () => string;
  fakeFindings?: TransportDeps["fakeFindings"];
  /** Test seam: per-read deadline for native and Projects reads (production 10 s). */
  readDeadlineMs?: number;
  /** Test seam: receives the runtime once the factory has registered everything. */
  onReady?: (r: { advisor: Advisor; store: ReturnType<typeof openStore> }) => void;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** The factory, with injectable dependencies for tests. Production uses the defaults. */
export function createAdvisorPlugin(opts: AdvisorPluginOptions = {}) {
  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define(settingsDescriptors);
    const store = openStore(bb);
    const host = opts.host ?? sdkHost(bb, POOLER_PLUGIN_ID);
    const now = opts.now ?? Date.now;
    const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
    const loopback = opts.loopbackBaseUrl ?? (() => bb.server.loopbackBaseUrl);
    const initiatives =
      opts.initiatives ??
      projectsInitiatives({ fetch: fetchImpl, loopbackBaseUrl: loopback, token: async () => (await bb.sdk.plugins.token({ pluginId: PROJECTS_PLUGIN_ID })).token });
    const advisor = new Advisor({
      host,
      store,
      initiatives,
      now,
      sleep: opts.sleep ?? sleepFor,
      log: bb.log,
      publish: (channel, payload) => bb.realtime.publish(channel, payload),
      ...(opts.readDeadlineMs ? { readDeadlineMs: opts.readDeadlineMs } : {}),
      transportDeps: {
        fetch: fetchImpl,
        loopbackBaseUrl: loopback,
        poolerToken: (signal) => host.poolerToken(signal),
        ...(opts.fakeFindings ? { fakeFindings: opts.fakeFindings } : {}),
        secret: async (key) => {
          const v = (await settings.get())[key];
          return typeof v === "string" && v.length > 0 ? v : undefined;
        },
      },
    });
    advisor.applySettings((await settings.get()) as Record<string, unknown>);
    settings.onChange((next) => {
      advisor.applySettings(next as Record<string, unknown>);
    });

    bb.background.service("advisor", {
      start: (signal) => advisor.run(signal),
    });

    // The one-second event notice is only a wake-up, never a visibility promise.
    bb.events.on("experimental_thread.events", ({ thread }) => {
      if (store.getWatchByThread(thread.id)?.enabled) advisor.wake();
    });
    bb.events.on("thread.idle", ({ thread }) => {
      if (store.getWatchByThread(thread.id)?.enabled) advisor.wake();
    });
    // A new thread may be a new member of a watched Initiative: list members at the next pass.
    bb.events.on("thread.created", () => advisor.noteThreadCreated());

    const via = "panel";
    const discussion = (occurrenceId: string) => {
      const o = store.getOccurrence(occurrenceId);
      if (!o) throw new Error(`unknown finding ${occurrenceId}`);
      const w = store.getWatch(o.watchId);
      const thread = { threadId: w?.threadId ?? "unknown", title: w?.title ?? null };
      const finding = findingView(store, o, { threadId: thread.threadId, initiative: w ? memberView(store, w.threadId) : null });
      return { finding, thread, watchId: o.watchId, projectId: w?.projectId ?? null, title: `Advisor · ${finding.summary}`.slice(0, 120) };
    };
    /** Discuss creates in flight, by finding. */
    const discussing = new Map<string, Promise<string>>();
    /** The discussion thread opened for a finding, while it still exists and is not archived. */
    const liveDiscussion = async (occurrenceId: string): Promise<string | null> => {
      const threadId = store.discussionOf(occurrenceId);
      if (!threadId) return null;
      try {
        const t = await host.getThread(threadId);
        if (t.archivedAt === null) return threadId;
      } catch (err) {
        // Unknown is not gone: only BB's own 404 forgets the link.
        if ((err as { status?: number }).status !== 404) throw err;
      }
      store.forgetDiscussion(occurrenceId);
      return null;
    };
    bb.rpc.register(rpcContract, {
      overview: () => overview(store, advisor, initiatives, now()),
      settingsView: async (): Promise<SettingsView> => {
        const raw = (await settings.get()) as Record<string, unknown>;
        const r = advisor.resolved;
        // Read for every route, so Settings can say whether a pooled route would be let through.
        let read: Parameters<typeof poolerAdvisorStatus>[1];
        try {
          read = { ok: true, value: await bb.sdk.plugins.callRpc({ pluginId: POOLER_PLUGIN_ID, method: "advisor.get", input: null, outputSchema: z.unknown() }) };
        } catch (err) {
          read = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const pooler = poolerAdvisorStatus(r.config.route, read);
        return {
          effective: Object.fromEntries(Object.entries(r.config).filter(([k]) => k !== "secretsPresent")),
          errors: { review: r.reviewErrors, observation: r.observationErrors },
          notes: r.notes,
          secrets: Object.fromEntries(SECRET_KEYS.map((k) => [k, typeof raw[k] === "string" && (raw[k] as string).length > 0])),
          routes: routesTable(),
          pooler,
          settingsLog: store.listSettingsLog(30),
          deferred: [...DEFERRED_STAGES],
          initiativeContext: initiatives.label,
        };
      },
      threadOptions: async ({ query }) => {
        const threads = await host.listRecentThreads(100);
        const q = (query ?? "").toLowerCase();
        return {
          threads: threads
            .filter((t) => !q || (t.title ?? "").toLowerCase().includes(q) || t.id.includes(q))
            .slice(0, 50)
            .map((t) => ({ id: t.id, title: t.title ?? null, projectId: t.projectId ?? null, status: String(t.status), watched: store.getWatchByThread(t.id) !== null })),
        };
      },
      threadStatus: ({ threadId }) => {
        const w = store.getWatchByThread(threadId);
        return { watch: w ? watchSummary(store, advisor, w) : null };
      },
      watchAdd: async ({ threadId }) => ({ watch: watchSummary(store, advisor, await advisor.watch(threadId, via)) }),
      watchRemove: ({ watchId }) => ({ ok: true as const, ...advisor.unwatch(watchId, via) }),
      initiativeOptions: async () => {
        const r = await initiatives.initiatives(AbortSignal.timeout(10_000));
        if (r.status !== "ok") return { status: r.status, error: r.error, initiatives: [] };
        const on = new Set(store.listInitiativeWatches().filter((i) => i.enabled).map((i) => i.id));
        return { status: "ok" as const, error: null, initiatives: r.value.map((i) => ({ id: i.id, name: i.name, paused: i.paused, watched: on.has(i.id) })) };
      },
      initiativeWatchSet: async ({ initiativeId, enabled }) => {
        if (enabled) await advisor.watchInitiative(initiativeId, via);
        else advisor.unwatchInitiative(initiativeId, via);
        return { initiative: initiativeWatchView(store, initiativeId)! };
      },
      initiativeWatchRemove: ({ initiativeId }) => ({ deleted: advisor.unwatchInitiative(initiativeId, via, true).deleted }),
      watchSetEnabled: ({ watchId, enabled }) => (advisor.setEnabled(watchId, enabled, via), { ok: true as const }),
      watchPause: ({ watchId }) => (advisor.pause(watchId, via), { ok: true as const }),
      watchResume: ({ watchId }) => (advisor.resume(watchId, via), { ok: true as const }),
      watchSkipToTip: ({ watchId }) => ({ skipped: advisor.skipToTip(watchId, via) }),
      watchDetail: ({ watchId }) => {
        const w = store.getWatch(watchId);
        if (!w) throw new Error(`unknown watch ${watchId}`);
        return watchDetail(store, advisor, w, now());
      },
      watchEvidence: ({ watchId, beforeSeq, limit }) => {
        const cards = store.listCards(watchId, { ...(beforeSeq !== undefined ? { beforeSeq } : {}), limit: limit ?? 50 });
        return { cards: cards.map(cardView), nextBeforeSeq: cards.length === (limit ?? 50) ? cards[cards.length - 1]!.seq : null };
      },
      previewReview: async ({ watchId }) => {
        const w = store.getWatch(watchId);
        if (!w) throw new Error(`unknown watch ${watchId}`);
        const hold = advisor.dispatchHold(w, true);
        if (hold) return { state: "held", reviewId: null, why: hold };
        const end = await advisor.start(w, true);
        return { state: end.state, reviewId: end.reviewId, why: "why" in end ? end.why : null };
      },
      findingOpen: ({ occurrenceId }) => {
        const o = store.getOccurrence(occurrenceId);
        if (!o) throw new Error(`unknown finding ${occurrenceId}`);
        const card = store.getCards(o.watchId, [o.evidence.split("/")[0]!])[0] ?? null;
        const retained = o.retained as { status?: string };
        if (card) return { source: "evidence" as const, complete: true, label: null, card: cardView(card), retained };
        const complete = retained.status !== "clipped";
        return { source: "retained" as const, complete, label: complete ? "full evidence pruned; citation retained whole" : "citation clipped; full evidence pruned", card: null, retained };
      },
      findingAcknowledge: ({ occurrenceId }) => {
        store.acknowledge(occurrenceId, now());
        store.logAction(store.getOccurrence(occurrenceId)?.watchId ?? null, "acknowledge", occurrenceId, via, now());
        bb.realtime.publish("advisor.changed", { at: now() });
        return { ok: true as const };
      },
      issueSetState: ({ watchId, category, locator, state }) => {
        const verified = store.listIssues(watchId).find((i) => i.category === category && i.locator === locator)?.subjectVerified ?? false;
        store.setIssueState(watchId, category, locator, state, verified, now());
        store.logAction(watchId, `issue-${state}`, `${category} ${locator}`, via, now());
        bb.realtime.publish("advisor.changed", { at: now() });
        return { ok: true as const };
      },
      findingsClearAcknowledged: ({ watchId }) => {
        const cleared = store.clearAcknowledged(watchId);
        store.logAction(watchId, "clear-view", `${cleared} acknowledged findings hidden from the list`, via, now());
        bb.realtime.publish("advisor.changed", { at: now() });
        return { cleared };
      },
      ledger: () => ({ rows: store.listLedger(100) }),
      feed: ({ initiativeId, watchId, before, limit }) => feedView(store, advisor, { initiativeId, watchId, before, limit }),
      unseen: () => ({ unseen: unseenTotal(store, advisor.resolved.config.severityThreshold) }),
      feedMarkSeen: ({ initiativeId, watchId }) => {
        const marked = store.acknowledgeAll(feedWatchIds(store, { initiativeId, watchId }), now());
        store.logAction(watchId ?? null, "acknowledge-all", `${marked} findings${initiativeId ? ` of Initiative ${initiativeId}` : ""}`, via, now());
        bb.realtime.publish("advisor.changed", { at: now() });
        return { marked };
      },
      discussDraft: async ({ occurrenceId }) => {
        const d = discussion(occurrenceId);
        return { prompt: discussionPrompt(d.finding, d.thread), projectId: d.projectId, threadId: await liveDiscussion(occurrenceId), title: d.title };
      },
      discussCreate: async ({ occurrenceId, request }) => {
        // One create per finding at a time: a concurrent submit (two tabs) waits and reuses its
        // thread. A failed spawn rejects every waiter and leaves nothing behind, so it can be retried.
        const pending = discussing.get(occurrenceId);
        if (pending) return { threadId: await pending, reused: true };
        const create = (async () => {
          const existing = await liveDiscussion(occurrenceId);
          if (existing) return { threadId: existing, reused: true };
          const d = discussion(occurrenceId);
          // The user's own submit from BB's composer: a separate thread, never the watched one.
          const thread = await bb.sdk.threads.spawn({
            ...(request as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]),
            title: d.title,
          });
          store.saveDiscussion(occurrenceId, thread.id, now());
          store.logAction(d.watchId, "discuss", `${occurrenceId} → ${thread.id}`, via, now());
          bb.realtime.publish("advisor.changed", { at: now() });
          return { threadId: thread.id, reused: false };
        })();
        const shared = create.then((r) => r.threadId);
        shared.catch(() => {}); // waiters see the error; an unwaited failure is not unhandled
        discussing.set(occurrenceId, shared);
        try {
          return await create;
        } finally {
          discussing.delete(occurrenceId);
        }
      },
      recordsGet: ({ occurrenceIds }) => {
        const records = [];
        const missing = [];
        for (const id of occurrenceIds) {
          const o = store.getOccurrence(id);
          if (o) records.push(findingView(store, o));
          else missing.push(id);
        }
        return { records, missing };
      },
    });

    bb.cli.register({
      name: "advisor",
      summary: "Watch threads and inspect Advisor evidence and findings",
      commands: [
        { name: "status", summary: "Activation, watches and today's budget use", usage: "bb advisor status" },
        { name: "watch", summary: "Watch a thread, or a whole Initiative with --initiative (reads events; never writes)", usage: "bb advisor watch <threadId> | --initiative <id|name>" },
        {
          name: "unwatch",
          summary: "Stop watching a thread (deletes its evidence), or turn an Initiative watch off (keeps history; --delete removes it)",
          usage: "bb advisor unwatch <threadId> | --initiative <id|name> [--delete]",
        },
        { name: "findings", summary: "Findings of a watched thread", usage: "bb advisor findings <threadId>" },
      ],
      run: (argv) => runCli(argv, { store, advisor, initiatives, now }),
    });

    bb.onDispose(() => advisor.dispose());
    opts.onReady?.({ advisor, store });
  };
}

export default createAdvisorPlugin();
