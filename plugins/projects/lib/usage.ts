import { BUSY_STATUSES } from "./bb";
import { observedTotals } from "./policy";
import type { Store, UsageTurn } from "./store";
import type { LiveThread } from "./overview";

export function summarizeTurns(turns: UsageTurn[], sampled: boolean) {
  const ended = turns.filter(turn => turn.completedAt !== null);
  const paired = ended.filter(turn => turn.turnId !== null &&
    turn.startedAt !== null && turn.completedAt! >= turn.startedAt);
  return {
    observedCompletions: sampled ? ended.length : null,
    completed: sampled ? ended.filter(turn => turn.status === "completed").length : null,
    failed: sampled ? ended.filter(turn => turn.status === "failed").length : null,
    interrupted: sampled ? ended.filter(turn => turn.status === "interrupted").length : null,
    unknownStatus: sampled ? ended.filter(turn => !["completed", "failed", "interrupted"].includes(turn.status ?? "")).length : null,
    paired: sampled ? paired.length : null,
    elapsedMs: paired.length ? paired.reduce((sum, turn) => sum + turn.completedAt! - turn.startedAt!, 0) : null,
    unpaired: sampled ? ended.length - paired.length : null,
  };
}

export function buildUsage(store: Store, projectId: string, live: Map<string, LiveThread>) {
  const project = store.project(projectId)!;
  const workers = store.workers(projectId);
  const records = new Map(store.projectUsage(projectId).map(row => [row.threadId, row]));
  const logicalWorkers = [
    ...workers,
    ...[...new Set([...records.values()].filter(row => row.workerNum > 0).map(row => row.workerNum))]
      .filter(num => !workers.some(worker => worker.num === num))
      .map(num => ({ num, ref: `W${num}`, label: "Retained worker", state: "unknown", forkedFrom: null })),
  ];
  const members = new Map<string, {
    threadId: string; workerNum: number; generation: number | null;
    label: string; retained: boolean; forkedFrom: string | null;
  }>();
  const add = (row: (typeof members extends Map<string, infer V> ? V : never)) => {
    if (!members.has(row.threadId)) members.set(row.threadId, row);
  };
  for (const workerNum of [0, ...workers.map(worker => worker.num)]) {
    const worker = workers.find(row => row.num === workerNum);
    for (const generation of store.generations(projectId, workerNum)) {
      add({
        threadId: generation.threadId, workerNum, generation: generation.generation,
        label: worker?.label ?? "Coordinator",
        retained: generation.endedAt !== null || worker?.state === "retired",
        forkedFrom: worker?.forkedFrom ? `W${worker.forkedFrom}` : null,
      });
    }
    const current = workerNum === 0 ? project.coordinatorThreadId : worker?.threadId;
    if (current) add({
      threadId: current, workerNum, generation: worker?.generation ?? project.coordinatorGeneration,
      label: worker?.label ?? "Coordinator", retained: worker?.state === "retired",
      forkedFrom: worker?.forkedFrom ? `W${worker.forkedFrom}` : null,
    });
  }
  for (const thread of store.projectThreads(projectId)) if (thread.threadId) add({
    threadId: thread.threadId, workerNum: -1, generation: null,
    label: thread.label, retained: false, forkedFrom: null,
  });
  for (const thread of store.nestedProjectThreads(projectId)) add({
    threadId: thread.threadId, workerNum: -1, generation: null,
    label: thread.label, retained: false, forkedFrom: null,
  });
  // Keep old observations even if the ledger no longer has a current row.
  for (const record of records.values()) add({
    threadId: record.threadId, workerNum: record.workerNum, generation: null,
    label: record.workerNum === 0 ? "Coordinator" : record.workerNum < 0 ? "Member conversation" : `W${record.workerNum}`,
    retained: true, forkedFrom: null,
  });
  const threads = [...members.values()].map(member => {
    const record = records.get(member.threadId);
    const cursor = store.turnCursor(member.threadId);
    const native = live.get(member.threadId);
    const profile = record?.profileObservation ?? null;
    const observedTimes = [record?.lastObservedAt, record?.lastReportAt, cursor?.lastObservedAt]
      .filter((at): at is number => at != null);
    return {
      ...member,
      ownership: member.workerNum === 0 ? "coordinator" as const :
        member.workerNum < 0 ? "user" as const : "worker" as const,
      totals: record?.lastReportAt != null ? observedTotals(record) : null,
      reporting: record?.lastReportAt != null,
      resets: record?.resets ?? 0,
      firstObservedAt: record?.firstObservedAt ?? null,
      lastObservedAt: observedTimes.length ? Math.max(...observedTimes) : null,
      tokenObservedAt: record?.lastReportAt ?? null,
      profile,
      historicalAttribution: profile?.mixed ? "mixed" as const : "unknown" as const,
      // A current settings lookup cannot prove which model produced an epoch.
      context: {
        used: record?.contextUsed ?? null, window: record?.contextWindow ?? null,
        estimated: record?.contextEstimated ?? null,
        at: record?.contextObservedAt ?? null,
        changedAt: record?.contextChangedAt ?? null,
      },
      runtime: native ? native.archived ? "archived" : native.status : "unknown",
      staleWhileActive: !!native && !native.archived && BUSY_STATUSES.has(native.status),
      turns: summarizeTurns(store.usageTurns(member.threadId), cursor !== null),
      turnObservations: cursor,
    };
  });
  const aggregate = (rows: typeof threads) => {
    const reporting = rows.filter(row => row.reporting);
    const times = rows.map(row => row.lastObservedAt).filter((at): at is number => at !== null);
    return {
      recordedThreads: rows.length, reportingThreads: reporting.length,
      // Only provider-native totals combine across thread/provider groups.
      // Components retain their provider-specific meaning in each thread row.
      totals: reporting.length ? {
        total: reporting.reduce<number | null>((sum, row) =>
          sum === null || row.totals!.total === null ? null : sum + row.totals!.total, 0),
      } : null,
      resets: rows.reduce((sum, row) => sum + row.resets, 0),
      lastObservedAt: times.length ? Math.max(...times) : null,
      activeStaleThreads: rows.filter(row => row.staleWhileActive).length,
    };
  };
  const profileGroups = new Map<string, typeof threads>();
  for (const thread of threads) {
    // Changed profiles stay in a mixed-history bucket, never the latest model.
    const key = thread.historicalAttribution === "mixed" ? "mixed" :
      JSON.stringify([thread.profile?.last.providerId ?? null, thread.profile?.last.model ?? null]);
    profileGroups.set(key, [...(profileGroups.get(key) ?? []), thread]);
  }
  return {
    ...aggregate(threads),
    profileGroups: [...profileGroups.values()].map(rows => ({
      providerId: rows[0]!.historicalAttribution === "mixed" ? null : rows[0]!.profile?.last.providerId ?? null,
      model: rows[0]!.historicalAttribution === "mixed" ? null : rows[0]!.profile?.last.model ?? null,
      historicalAttribution: rows[0]!.historicalAttribution,
      ...aggregate(rows), threads: rows,
    })),
    coordinator: { ...aggregate(threads.filter(row => row.ownership === "coordinator")),
      generations: threads.filter(row => row.ownership === "coordinator") },
    workers: logicalWorkers.map(worker => ({
      ref: worker.ref, label: worker.label, state: worker.state,
      forkedFrom: worker.forkedFrom ? `W${worker.forkedFrom}` : null,
      ...aggregate(threads.filter(row => row.workerNum === worker.num)),
      generations: threads.filter(row => row.workerNum === worker.num),
    })),
    workerTotal: aggregate(threads.filter(row => row.ownership === "worker")),
    conversations: { ...aggregate(threads.filter(row => row.ownership === "user")),
      threads: threads.filter(row => row.ownership === "user") },
    threads,
    notes: [
      "Observed usage comes from bounded idle samples of recorded Initiative threads. Recent event tails and retained accounting epochs do not establish lifetime coverage. Active threads can be stale until idle.",
      "Profile groups describe threads with that last observed effective profile. Historical token allocation is unknown: native token events have no model identity. Changed observed profiles stay mixed; legacy model labels are not proof.",
      "Totals are provider-native. Claude input is uncached; cached input combines cache reads and cache writes. Codex cached input is contained in input, and reasoning is contained in output. Components must not be added to reconstruct total. Cached input is never a cache-hit rate.",
      "Context is the latest reported point gauge, not an additive total. Missing values and an unknown estimated flag stay unknown.",
      "Turn counts deduplicate native scope.turnId completions and preserve completed, failed and interrupted statuses. Events without turn identity count as unpaired event observations. Elapsed wall time pairs start/completion createdAt within BB turn boundaries; missing starts are unknown. It includes whatever work happened inside that interval.",
      "Detected resets retain earlier observed epochs once. Undetectable restarts and history outside sampled pages remain unknown. User-owned conversations contribute separately from workers; retained generations remain in totals.",
    ],
  };
}
export type InitiativeUsage = ReturnType<typeof buildUsage>;
export type UsageThread = InitiativeUsage["threads"][number];

/** Shape-compatible placeholder; detailed views request observed telemetry explicitly. */
export function unloadedUsage(): InitiativeUsage {
  const totals = { recordedThreads: 0, reportingThreads: 0, totals: null, resets: 0, lastObservedAt: null, activeStaleThreads: 0 };
  return { ...totals, profileGroups: [], coordinator: { ...totals, generations: [] }, workers: [], workerTotal: totals, conversations: { ...totals, threads: [] }, threads: [], notes: [] };
}
