import { useState } from "react";
import type { InitiativeUsage, UsageThread } from "./lib/usage";

const number = (value: number | null | undefined) =>
  value == null ? "n/a" : value.toLocaleString();
const tokens = (value: number | null | undefined) => value == null ? "n/a" :
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const stamp = (at: number | null) => at === null ? "unknown" : new Date(at).toLocaleString();
const age = (at: number | null) => {
  if (at === null) return "unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` :
    minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`;
};
const wallTime = (ms: number | null) => ms === null ? "unknown" :
  ms < 60000 ? `${(ms / 1000).toFixed(1)} sec` :
    `${Math.floor(ms / 3600000)} hr ${Math.floor(ms / 60000) % 60} min`;
const identity = (thread: UsageThread) => thread.ownership === "coordinator" ?
  `Coordinator${thread.generation === null ? "" : ` G${thread.generation}`}` :
  thread.ownership === "worker" ? `W${thread.workerNum}${thread.generation === null ? "" : ` G${thread.generation}`} · ${thread.label}` :
    thread.label;
const profileName = (thread: UsageThread) => thread.historicalAttribution === "mixed" ?
  "Mixed historical profiles" : `${thread.profile?.last.providerId ?? "Unknown provider"} · ${thread.profile?.last.model ?? "Unknown model"}`;

function ThreadDetails({ thread, openThread }: {
  thread: UsageThread; openThread: (threadId: string) => void;
}) {
  const total = thread.totals;
  const turns = thread.turns;
  return (
    <div className="project-usage-thread">
      <button className="project-usage-open" onClick={() => openThread(thread.threadId)}>
        {identity(thread)}
      </button>
      <p className="project-meta">
        {thread.ownership === "user" ? "User-owned conversation" : thread.ownership}
        {thread.retained ? " · retained history" : ""}
        {thread.forkedFrom ? ` · forked from ${thread.forkedFrom}` : ""}
        {" · "}{thread.runtime}
      </p>
      <dl className="project-usage-values">
        <dt>Provider-native total</dt><dd>{number(total?.total)}</dd>
        <dt>Input</dt><dd>{number(total?.input)}</dd>
        <dt>Cached input</dt><dd>{number(total?.cachedInput)}</dd>
        <dt>Output</dt><dd>{number(total?.output)}</dd>
        <dt>Reasoning output</dt><dd>{number(total?.reasoningOutput)}</dd>
      </dl>
      {!thread.reporting ? <p className="project-meta">Token usage unavailable.</p> : null}
      <p className="project-meta">
        {thread.historicalAttribution !== "mixed" && thread.profile?.last.providerId === "claude-code" ?
          "Claude input excludes cached input. Cached input combines reads and writes." :
          thread.historicalAttribution !== "mixed" && thread.profile?.last.providerId === "codex" ?
            "Codex input includes cached input. Output includes reasoning output." :
            "Components are shown as reported. Their relationship to total is unknown."}
        {" "}Historical provider/model allocation is {thread.historicalAttribution}.
      </p>
      <p className="project-meta">
        Last observed profile: {profileName(thread)}.
        {" "}Profile sampled {stamp(thread.profile?.last.at ?? null)}.
        {" "}First sampled profile: {thread.profile?.first.providerId ?? "unknown provider"}
        {" / "}{thread.profile?.first.model ?? "unknown model"}
        {" at "}{stamp(thread.profile?.first.at ?? null)}.
      </p>
      <dl className="project-usage-values">
        <dt>Latest context used / window</dt>
        <dd>{number(thread.context.used)} / {number(thread.context.window)}</dd>
        <dt>Estimated</dt><dd>{thread.context.estimated === null ? "unknown" : thread.context.estimated ? "yes" : "no"}</dd>
        <dt>Context observed</dt><dd>{stamp(thread.context.at)}</dd>
        <dt>Detected resets</dt><dd>{thread.resets}</dd>
        <dt>First / last observation</dt><dd>{stamp(thread.firstObservedAt)} / {stamp(thread.lastObservedAt)}</dd>
        <dt>Token observation</dt><dd>{stamp(thread.tokenObservedAt)}</dd>
      </dl>
      {thread.context.changedAt !== null ? <p className="project-meta">
        Context compacted or cleared {stamp(thread.context.changedAt)}.
        {thread.context.at === null || thread.context.changedAt > thread.context.at ? " The gauge predates that change." : ""}
      </p> : null}
      {thread.staleWhileActive ? <p className="project-meta">
        Working. Usage may be stale until this thread goes idle.
      </p> : null}
      <dl className="project-usage-values">
        <dt>Observed turn completions</dt><dd>{number(turns.observedCompletions)}</dd>
        <dt>Completed / failed / interrupted</dt><dd>{number(turns.completed)} / {number(turns.failed)} / {number(turns.interrupted)}</dd>
        <dt>Unknown status</dt><dd>{number(turns.unknownStatus)}</dd>
        <dt>Paired coverage</dt><dd>{number(turns.paired)} / {number(turns.observedCompletions)}</dd>
        <dt>Paired elapsed wall time</dt><dd>{wallTime(turns.elapsedMs)}</dd>
        <dt>Missing pair</dt><dd>{number(turns.unpaired)}</dd>
        <dt>Turn observations</dt><dd>{stamp(thread.turnObservations?.firstObservedAt ?? null)} / {stamp(thread.turnObservations?.lastObservedAt ?? null)}</dd>
      </dl>
      <p className="project-meta">Wall time is completion minus the matching start within BB turn boundaries. Unpaired elapsed time is unknown.</p>
    </div>
  );
}

export function UsagePage({ usage: u, openThread }: {
  usage: InitiativeUsage; openThread: (threadId: string) => void;
}) {
  const [by, setBy] = useState<"thread" | "model" | "role">("thread");
  const groups = by === "model" ? u.profileGroups.map((group, index) => ({
    ...group, key: `model:${index}`,
    label: group.historicalAttribution === "mixed" ? "Mixed historical profiles" :
      `${group.providerId ?? "Unknown provider"} / ${group.model ?? "Unknown model"}`,
    meta: "Historical allocation " + group.historicalAttribution,
  })) : by === "role" ? [
    { ...u.coordinator, key: "coordinator", label: "Coordinator", meta: "Across coordinator generations", threads: u.coordinator.generations },
    { ...u.workerTotal, key: "workers", label: "Workers", meta: "Logical workers and their generations", threads: u.threads.filter(t => t.ownership === "worker") },
    { ...u.conversations, key: "user", label: "Your threads", meta: "User-owned and ad-hoc conversations" },
  ] : [
    ...u.coordinator.generations.map(thread => ({
      key: thread.threadId, label: identity(thread), meta: profileName(thread),
      totals: thread.totals, reportingThreads: thread.reporting ? 1 : 0, recordedThreads: 1,
      activeStaleThreads: thread.staleWhileActive ? 1 : 0,
      lastObservedAt: thread.lastObservedAt, threads: [thread],
    })),
    ...u.workers.map(worker => ({
      ...worker, key: worker.ref, label: `${worker.ref} · ${worker.label}`,
      meta: `${worker.recordedThreads} generation thread${worker.recordedThreads === 1 ? "" : "s"} · ${worker.state}${worker.forkedFrom ? ` · forked from ${worker.forkedFrom}` : ""}`,
      threads: worker.generations,
    })),
    ...u.conversations.threads.map(thread => ({
      key: thread.threadId, label: thread.label, meta: "User-owned · " + profileName(thread),
      totals: thread.totals, reportingThreads: thread.reporting ? 1 : 0, recordedThreads: 1,
      activeStaleThreads: thread.staleWhileActive ? 1 : 0,
      lastObservedAt: thread.lastObservedAt, threads: [thread],
    })),
  ];
  const maxTokens = Math.max(1, ...groups.map(g => g.totals?.total ?? 0));
  return (
    <section className="project-usage" aria-label="Observed usage">
      <div className="project-usage-head">
        <p title={u.totals?.total == null ? "Token usage unavailable" : `${number(u.totals.total)} provider-reported tokens`}>
          <strong>{tokens(u.totals?.total)}</strong>{u.totals?.total == null ? "" : " tokens"}
        </p>
        <p className="project-meta">Last observed <time title={stamp(u.lastObservedAt)}>{age(u.lastObservedAt)}</time></p>
      </div>
      <div className="project-usage-filter" role="group" aria-label="Group usage by">
        {(["thread", "model", "role"] as const).map(value => (
          <button key={value} aria-pressed={by === value} onClick={() => setBy(value)}>{value}</button>
        ))}
      </div>
      {groups.map(group => (
        <details className="project-usage-row" key={by + group.key}>
          <summary>
            <span className="project-usage-name">
              <span>{group.label} <time className="project-meta" title={stamp(group.lastObservedAt)}>{age(group.lastObservedAt)}</time></span>
              <span className="project-meta">{group.meta}
                {group.activeStaleThreads > 0 ? <span className="project-usage-working" title="Working now. Usage may be stale until the next idle sample."> · Working</span> : null}
              </span>
            </span>
            <span className={`project-usage-bar${group.totals?.total == null ? " project-usage-bar--unknown" : ""}`} aria-hidden="true"><i style={{ width: `${100 * (group.totals?.total ?? 0) / maxTokens}%` }} /></span>
            <span className="project-usage-amount" title={group.totals?.total == null ? "Tokens unavailable, not zero" : number(group.totals.total)}>
              {tokens(group.totals?.total)}
            </span>
          </summary>
          <p className="project-meta">Reporting {group.reportingThreads} / {group.recordedThreads} recorded threads. Retained generations are included.</p>
          {group.threads.map(thread => <ThreadDetails key={thread.threadId} thread={thread} openThread={openThread} />)}
        </details>
      ))}
      <details className="project-details">
        <summary>Coverage and definitions</summary>
        <p>{u.reportingThreads} / {u.recordedThreads} recorded generation/member threads report tokens.
          {" "}{u.resets} detected resets. {u.activeStaleThreads} working threads may have stale observations.</p>
        <p className="project-meta">Coordinator: {u.coordinator.reportingThreads} / {u.coordinator.recordedThreads}.
          {" "}Workers: {u.workerTotal.reportingThreads} / {u.workerTotal.recordedThreads}.
          {" "}User-owned: {u.conversations.reportingThreads} / {u.conversations.recordedThreads}.</p>
        {u.notes.map(note => <p className="project-meta" key={note}>{note}</p>)}
      </details>
    </section>
  );
}
