// `bb advisor`: bounded, read-mostly output for agents and terminals.

import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import type { Advisor } from "./runtime/advisor.js";
import type { InitiativeSource } from "./runtime/initiatives.js";
import type { Store } from "./store/store.js";
import { findingView, initiativeWatchView, memberView, overview, type InitiativeWatchView } from "./views.js";

interface CliDeps {
  store: Store;
  advisor: Advisor;
  initiatives: InitiativeSource;
  now: () => number;
}

function bounded(text: string): string {
  const max = Math.min(PLUGIN_CLI_OUTPUT_MAX_BYTES, 64 * 1024) - 64;
  if (Buffer.byteLength(text) <= max) return text;
  return Buffer.from(text).subarray(0, max).toString("utf8").replace(/�$/u, "") + "\n[output cut]\n";
}

function initiativeLine(i: InitiativeWatchView): string {
  const m = i.members;
  return `${i.name} (${i.id}) ${i.enabled ? "on" : "off"}${i.archived ? " · archived" : ""} · ${m.live} live members, ${m.observed} observed, ${m.total - m.live} retired, former or archived${m.excluded ? `, ${m.excluded} excluded` : ""}${i.error ? ` · ${i.error}` : ""}`;
}

export async function runCli(argv: string[], d: CliDeps): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const flags = new Set<string>(argv.filter((a) => a === "--delete"));
  const rest = argv.filter((a) => !flags.has(a));
  const [cmd, first, second] = rest;
  const initiative = first === "--initiative" ? second : first?.startsWith("--initiative=") ? first.slice("--initiative=".length) : undefined;
  const arg = first?.startsWith("--initiative") ? undefined : first;
  if (cmd === "watch" && initiative) {
    try {
      const iw = await d.advisor.watchInitiative(initiative, "cli");
      const v = initiativeWatchView(d.store, iw.id)!;
      return {
        exitCode: 0,
        stdout: `watching Initiative ${initiativeLine(v)}\nnew members are added as they appear; retired, former and archived members stop being observed and keep their history\n`,
      };
    } catch (err) {
      return { exitCode: 1, stderr: `${err instanceof Error ? err.message : String(err)}\n` };
    }
  }
  if (cmd === "unwatch" && initiative) {
    try {
      const r = d.advisor.unwatchInitiative(initiative, "cli", flags.has("--delete"));
      return {
        exitCode: 0,
        stdout: flags.has("--delete")
          ? `removed the Initiative watch of ${r.initiative.name}; ${r.deleted} member watches and their evidence were deleted (threads you watch yourself are kept)\n`
          : `Initiative watch of ${r.initiative.name} is off; ${r.stopped} member watches stopped and keep their evidence and findings (\`--delete\` removes them)\n`,
      };
    } catch (err) {
      return { exitCode: 1, stderr: `${err instanceof Error ? err.message : String(err)}\n` };
    }
  }
  if (cmd === undefined || cmd === "status") {
    const o = overview(d.store, d.advisor, d.initiatives, d.now());
    const lines = [
      `observation: ${o.activation.observation ? "on" : "off"} · reviews: ${o.activation.review ? "on" : "off"} · provider requests: ${o.activation.providerRequests ? "allowed" : "off"}`,
      `route: ${o.activation.route} (${o.activation.billing})`,
      ...o.errors.review.map((e) => `review error: ${e}`),
      ...o.errors.observation.map((e) => `observation error: ${e}`),
      ...o.notes.map((n) => `note: ${n}`),
      `today ${o.today.day} (${o.today.timeZone}): USD $${o.today.usd.charged.toFixed(5)} of ${o.today.usd.cap ?? "unset"}, ${o.today.usd.requests} API requests; subscription ${o.today.subscription.requests} requests, ${o.today.subscription.tokens} tokens`,
      `${o.initiativeContext}`,
      ...(o.initiativeWatches.length ? [`initiative watches (${o.initiativeWatches.length}):`, ...o.initiativeWatches.map((i) => `  ${initiativeLine(i)}`)] : []),
      `watches (${o.watches.length}):`,
      ...o.watches.map(
        (w) =>
          `  ${w.threadId} ${w.enabled ? "on" : "off"} ${w.title ?? ""}${w.initiative ? ` · ${w.initiative.name} ${w.initiative.label}` : ""}${w.ended ? ` · stopped: ${w.ended}` : ""} · cursor #${w.cursor ?? "-"} of #${w.tip ?? "-"} · backlog ${w.backlog} · open ${w.openFindings}${w.pause.length ? ` · paused: ${w.pause.join(", ")}` : ""}${w.hold ? ` · ${w.hold}` : ""}`,
      ),
    ];
    return { exitCode: 0, stdout: bounded(lines.join("\n") + "\n") };
  }
  if (cmd === "watch" && arg) {
    try {
      const w = await d.advisor.watch(arg, "cli");
      return { exitCode: 0, stdout: `watching ${w.threadId} (${w.id}); observation only reads its events\n` };
    } catch (err) {
      return { exitCode: 1, stderr: `${err instanceof Error ? err.message : String(err)}\n` };
    }
  }
  if (cmd === "unwatch" && arg) {
    const w = d.store.getWatchByThread(arg);
    if (!w) return { exitCode: 1, stderr: `not watching ${arg}\n` };
    const { excludedFrom } = d.advisor.unwatch(w.id, "cli");
    const excluded = excludedFrom.length
      ? `; excluded from the Initiative watch of ${excludedFrom.join(", ")}, so it is not added back (\`bb advisor watch ${arg}\` includes it again)`
      : "";
    return { exitCode: 0, stdout: `stopped watching ${arg}; its evidence and findings were deleted (the spend ledger keeps its rows)${excluded}\n` };
  }
  if (cmd === "findings" && arg) {
    const w = d.store.getWatchByThread(arg);
    if (!w) return { exitCode: 1, stderr: `not watching ${arg}\n` };
    const member = memberView(d.store, w.threadId);
    const rows = d.store.listOccurrences(w.id, 50).map((o) => findingView(d.store, o, { threadId: w.threadId, initiative: member }));
    const lines = rows.map(
      (f) => `${f.severity.padEnd(8)} ${f.category} ${f.subject} [${f.subjectStatus}] ${f.issueState ?? ""}${f.preview ? " (preview: fake)" : ""}\n    ${f.summary}`,
    );
    const head = member ? `${arg} · Initiative ${member.name} · ${member.label} (${member.state})\n` : "";
    return { exitCode: 0, stdout: bounded(head + (lines.join("\n") || "no findings") + "\n") };
  }
  return {
    exitCode: 2,
    stderr: "usage: bb advisor status | watch <threadId> | watch --initiative <id|name> | unwatch <threadId> | unwatch --initiative <id|name> [--delete] | findings <threadId>\n",
  };
}
