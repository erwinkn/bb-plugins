// `bb advisor`: bounded, read-mostly output for agents and terminals.

import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import type { Advisor } from "./runtime/advisor.js";
import type { InitiativeSource } from "./runtime/initiatives.js";
import type { Store } from "./store/store.js";
import { findingView, overview } from "./views.js";

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

export async function runCli(argv: string[], d: CliDeps): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const [cmd, arg] = argv;
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
      `watches (${o.watches.length}):`,
      ...o.watches.map(
        (w) =>
          `  ${w.threadId} ${w.enabled ? "on" : "off"} ${w.title ?? ""} · cursor #${w.cursor ?? "-"} of #${w.tip ?? "-"} · backlog ${w.backlog} · open ${w.openFindings}${w.pause.length ? ` · paused: ${w.pause.join(", ")}` : ""}${w.hold ? ` · ${w.hold}` : ""}`,
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
    d.advisor.unwatch(w.id, "cli");
    return { exitCode: 0, stdout: `stopped watching ${arg}; its evidence and findings were deleted (the spend ledger keeps its rows)\n` };
  }
  if (cmd === "findings" && arg) {
    const w = d.store.getWatchByThread(arg);
    if (!w) return { exitCode: 1, stderr: `not watching ${arg}\n` };
    const rows = d.store.listOccurrences(w.id, 50).map((o) => findingView(d.store, o));
    const lines = rows.map(
      (f) => `${f.severity.padEnd(8)} ${f.category} ${f.subject} [${f.subjectStatus}] ${f.issueState ?? ""}${f.preview ? " (preview: fake)" : ""}\n    ${f.summary}`,
    );
    return { exitCode: 0, stdout: bounded((lines.join("\n") || "no findings") + "\n") };
  }
  return { exitCode: 2, stderr: "usage: bb advisor status | watch <threadId> | unwatch <threadId> | findings <threadId>\n" };
}
