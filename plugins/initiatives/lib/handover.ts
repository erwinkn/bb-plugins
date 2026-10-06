import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Profile } from "./schema";
import { openBlockers } from "./blockers";
import { taskRef, workerRef, type AssignmentRecord, type Store } from "./store";

/**
 * T136: a replacement coordinator's first message is a handover written by GPT-6 Luna High
 * from recent activity. The plugin builds a bounded packet from its own records and the old
 * coordinator's recent messages; a short-lived Codex thread turns it into the handover; the
 * text is kept only as the new coordinator's first message. When Luna is unavailable, fails
 * or takes too long, a plain listing of the same packet is used instead.
 */
type Sdk = BbPluginApi["sdk"];

export const HANDOVER_PROFILE: Profile = { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" };
/** A writer still running after this long is abandoned for the plain listing. */
export const HANDOVER_TIMEOUT_MS = 10 * 60_000;
const PACKET_MAX = 60_000;
const REPORTS = 10;
const MESSAGES = 30;

export interface TranscriptMessage { role: "user" | "coordinator"; text: string }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const day = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const outcomeOf = (a: AssignmentRecord) => (a.report?.outcome === "succeeded" ? "done" : a.report?.outcome ?? a.state);
const reportText = (a: AssignmentRecord) =>
  a.report?.finalMessage ?? [a.report?.summary, a.report && a.report.handoff.summary !== a.report.summary ? a.report.handoff.summary : null].filter(Boolean).join("\n");

/** The packet sections, most essential first; the conversation is trimmed first when over budget. */
function sections(store: Store, projectId: string, transcript: TranscriptMessage[], note: string | null) {
  const project = store.project(projectId)!;
  const tasks = store.tasks(projectId);
  const assignments = store.assignments(projectId);
  const open = tasks.filter(t => !["done", "cancelled"].includes(t.status));
  const live = store.workers(projectId).filter(w => w.state !== "retired");
  const latest = (num: number) => assignments.filter(a => a.workerNum === num).at(-1) ?? null;
  const decisions = store.decisions(projectId);
  const questions = decisions.filter(d => d.status === "active" && d.humanAttention === "needs-opinion" && d.madeBy === null);
  const vetoes = decisions.filter(d => d.madeBy === "agent" && d.review === "pending" && d.status === "active");
  const blockers = openBlockers(
    assignments.map(a => ({ ...a, outcome: a.report?.outcome ?? null })),
    num => ["done", "cancelled"].includes(store.task(projectId, num)?.status ?? ""),
  );
  const reports = assignments.filter(a => a.report).sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0)).slice(0, REPORTS);
  const updates = store.updates(projectId, 5);
  const head = [
    `# Initiative "${project.name}"`,
    `Objective: ${project.objective}`,
    `## Open tasks (${open.length})`,
    open.length ? open.slice(0, 40).map(t => `- ${t.ref} [${t.status}] ${t.title}${t.progress ? ` — ${clip(t.progress, 200)}` : ""}`).join("\n") : "None.",
    `## Live workers (${live.length})`,
    live.length
      ? live.map(w => {
          const a = latest(w.num);
          const work = a ? `${a.ref} ${a.state}${a.taskNums.length ? ` on ${a.taskNums.map(taskRef).join(", ")}` : ""}${a.report ? `, report: ${clip(a.report.summary, 300)}` : ""}` : "no work yet";
          return `- ${w.ref} "${w.label}" (${w.role}, ${w.area}) — ${work}`;
        }).join("\n")
      : "None.",
    "## Waiting on the user",
    [
      ...questions.map(d => `- Question ${d.ref}: ${clip((d.body as { question?: string }).question ?? d.title, 400)}`),
      ...blockers.map(a => `- ${workerRef(a.workerNum)} is blocked (${a.ref}): ${a.report?.blocker?.question ?? a.report?.summary ?? ""}`),
      ...vetoes.slice(-10).map(d => `- Agent decision to check ${d.ref}: ${clip(d.description, 300)}`),
      ...(vetoes.length > 10 ? [`- ${vetoes.length - 10} older agent decisions to check (the user reviews them in the Inbox).`] : []),
    ].join("\n") || "Nothing.",
    note ? `## Note from the outgoing coordinator\n${clip(note, 6000)}` : null,
  ].filter(Boolean).join("\n\n");
  const reportBlock = reports.length
    ? `## Recent reports\n\n${reports.map(a => `### ${a.ref} · ${workerRef(a.workerNum)}${a.taskNums.length ? ` · ${a.taskNums.map(taskRef).join(", ")}` : ""} · ${a.role} · ${outcomeOf(a)} · ${day(a.reportedAt)}\n${clip(reportText(a), 1500)}`).join("\n\n")}`
    : "";
  const updateBlock = updates.length ? `## Recent updates\n${updates.map(u => `- ${u.ref} (${day(u.createdAt)}): ${clip(u.body, 600)}`).join("\n")}` : "";
  const conversation = transcript.slice(-MESSAGES).map(m => `**${m.role === "user" ? "User" : "Coordinator"}:** ${clip(m.text, m.role === "user" ? 2000 : 1500)}`);
  return { head, reportBlock, updateBlock, conversation };
}

/** The bounded packet the writer reads. */
export function handoverPacket(store: Store, projectId: string, transcript: TranscriptMessage[], note: string | null): string {
  const { head, reportBlock, updateBlock, conversation } = sections(store, projectId, transcript, note);
  const assemble = (lines: string[], reports: string) =>
    [head, reports, updateBlock, lines.length ? `## Recent conversation in the old coordinator thread\n\n${lines.join("\n\n")}` : ""].filter(Boolean).join("\n\n");
  let lines = conversation;
  let text = assemble(lines, reportBlock);
  while (text.length > PACKET_MAX && lines.length) {
    lines = lines.slice(1);
    text = assemble(lines, reportBlock);
  }
  return text.length > PACKET_MAX ? clip(assemble([], reportBlock), PACKET_MAX) : text;
}

export function handoverPrompt(name: string, packet: string): string {
  return [
    `Write the handover for the new coordinator of the Initiative "${name}". It replaces the previous coordinator and has no memory but this text. Under 600 words:`,
    "1) the objective and where things stand;",
    "2) work in flight, per live worker (W#): what it is doing and what comes next;",
    "3) what waits on the user: questions, blockers, agent decisions to check;",
    "4) the user's recent explicit instructions that still apply;",
    "5) the next three steps.",
    "Use W#/T#/A# refs. Don't invent anything; say when you're unsure. Don't run tools or read files: everything you need is below. Output only the handover.",
    "",
    "---",
    "",
    packet,
  ].join("\n");
}

/**
 * The plain listing used when Luna can't write the handover: the same packet, with the
 * user's recent messages ahead of the reports so the clip never drops their instructions.
 * Built when the writer starts, from the same messages its packet had.
 */
export function fallbackBody(store: Store, projectId: string, note: string | null, transcript: TranscriptMessage[] = []): string {
  const { head, reportBlock, updateBlock } = sections(store, projectId, transcript, note);
  const BUDGET = 24_000;
  // The user's own words come first and keep their room (up to a third); everything else
  // fills what is left, in order, so a large Initiative clips its reports and tasks instead.
  let said = transcript.filter(m => m.role === "user").slice(-15).map(m => `- ${clip(m.text, 1500)}`);
  while (said.join("\n").length > BUDGET / 3 && said.length > 1) said = said.slice(1);
  const parts: string[] = [];
  let left = BUDGET;
  for (const part of [said.length ? clip(`## The user's recent messages to the old coordinator\n${said.join("\n")}`, BUDGET / 3) : "", head, updateBlock, reportBlock]) {
    if (!part || left <= 200) continue;
    const piece = clip(part, left);
    parts.push(piece);
    left -= piece.length + 2;
  }
  return parts.join("\n\n");
}

export const withReason = (body: string, why: string) => `(Generated without Luna: ${why}.)\n\n${body}`;

/** The plain listing, ready to use. */
export function fallbackHandover(store: Store, projectId: string, note: string | null, why: string, transcript: TranscriptMessage[] = []): string {
  return withReason(fallbackBody(store, projectId, note, transcript), why);
}

type EventRow = { seq: number; type: string; createdAt?: number | string; data?: Record<string, any> };
const list = (sdk: Sdk, args: Record<string, unknown>) => sdk.threads.events.list(args as never) as Promise<EventRow[]>;
const inputText = (input: unknown) =>
  Array.isArray(input) ? (input as { type?: string; text?: string }[]).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";

/**
 * The thread's latest user and agent messages, oldest first. A user's turn input is recorded
 * as client/turn/requested (initiator user); some providers also emit userMessage items.
 */
export async function recentMessages(sdk: Sdk, threadId: string, limit = MESSAGES): Promise<TranscriptMessage[]> {
  const rows = await list(sdk, { threadId, types: ["item/completed", "client/turn/requested"], order: "desc", limit: "50" });
  const out: { seq: number; message: TranscriptMessage }[] = [];
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => b.seq - a.seq)) {
    let message: TranscriptMessage | null = null;
    if (row.type === "client/turn/requested") {
      const text = inputText(row.data?.input);
      if (row.data?.initiator === "user" && text.trim()) message = { role: "user", text: text.trim() };
    } else {
      const item = row.data?.item as Record<string, unknown> | undefined;
      if (item && !item.parentToolCallId) {
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) message = { role: "coordinator", text: item.text.trim() };
        if (item.type === "userMessage") {
          const text = inputText(item.content);
          if (text.trim()) message = { role: "user", text: text.trim() };
        }
      }
    }
    if (!message) continue;
    // A provider that records both forms of one user message lists it once.
    const key = `${message.role}:${message.text}`;
    if (message.role === "user" && seen.has(key)) continue;
    seen.add(key);
    out.push({ seq: row.seq, message });
    if (out.length >= limit) break;
  }
  return out.reverse().map(o => o.message);
}

export interface EndedTurn {
  status: "ended";
  /** The turn's own outcome: "completed" normally, otherwise interrupted, failed, ... */
  outcome: string;
  /** The turn's last agent message, or null when it has none or did not complete normally. */
  final: { text: string; seq: number } | null;
  /** The texts the turn received as input (briefs carry their op marker). */
  inputs: string[];
  startSeq: number;
  endSeq: number;
  startedAt: number | null;
  endedAt: number | null;
}
export type CompletedTurn = EndedTurn;

const timeOf = (row: EventRow | undefined) => {
  const value = row?.createdAt;
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The thread's latest turn: running, or ended with its outcome. Null when no turn is recorded.
 * A failed event read throws, so callers can tell "unknown" from a turn that ended.
 */
export async function latestTurn(sdk: Sdk, threadId: string): Promise<{ status: "running" } | EndedTurn | null> {
  const bounds = (await list(sdk, { threadId, types: ["turn/started", "turn/completed"], order: "desc", limit: "2" })).sort((a, b) => b.seq - a.seq);
  const end = bounds[0];
  if (!end) return null;
  if (end.type === "turn/started") return { status: "running" };
  const start = bounds.find(row => row.type === "turn/started" && row.seq < end.seq);
  if (!start) return null;
  const outcome = typeof end.data?.status === "string" ? end.data.status : "unknown";
  const inside = (row: EventRow) => row.seq > start.seq && row.seq < end.seq;
  const accepted = (await list(sdk, { threadId, types: ["turn/input/accepted"], afterSeq: String(start.seq), order: "asc", limit: "20" })).filter(inside);
  const ids = new Set(accepted.map(row => row.data?.clientRequestId).filter((id): id is string => typeof id === "string"));
  const requests = ids.size ? await list(sdk, { threadId, types: ["client/turn/requested"], order: "desc", limit: "50" }) : [];
  const inputs = requests.filter(row => ids.has(row.data?.requestId)).map(row => inputText(row.data?.input));
  let final: EndedTurn["final"] = null;
  if (outcome === "completed") {
    const items = (await list(sdk, { threadId, types: ["item/completed"], afterSeq: String(start.seq), order: "desc", limit: "50" })).filter(inside).sort((a, b) => b.seq - a.seq);
    const message = items.find(row => row.data?.item?.type === "agentMessage" && !row.data.item.parentToolCallId && typeof row.data.item.text === "string" && row.data.item.text.trim());
    if (message) final = { text: String(message.data!.item.text).trim(), seq: message.seq };
  }
  return { status: "ended", outcome, final, inputs, startSeq: start.seq, endSeq: end.seq, startedAt: timeOf(start), endedAt: timeOf(end) };
}

/** The latest turn when it completed normally; null while running, after any other outcome, or with none. */
export async function latestCompletedTurn(sdk: Sdk, threadId: string): Promise<EndedTurn | null> {
  const turn = await latestTurn(sdk, threadId);
  return turn?.status === "ended" && turn.outcome === "completed" ? turn : null;
}

/**
 * Where a brief entered the thread: the sequence number of the turn input that accepted the
 * request carrying `marker`. Null when the thread has not received it (yet).
 */
export async function briefBoundary(sdk: Sdk, threadId: string, marker: string): Promise<number | null> {
  const requests = await list(sdk, { threadId, types: ["client/turn/requested"], order: "desc", limit: "100" });
  const ids = new Set(requests.filter(row => inputText(row.data?.input).includes(marker)).map(row => row.data?.requestId).filter((id): id is string => typeof id === "string"));
  if (!ids.size) return null;
  const accepted = await list(sdk, { threadId, types: ["turn/input/accepted"], order: "desc", limit: "100" });
  const seqs = accepted.filter(row => ids.has(row.data?.clientRequestId)).map(row => row.seq);
  return seqs.length ? Math.min(...seqs) : null;
}

/**
 * The last agent message of the thread's latest turn, only when that turn completed normally.
 * The writer thread has one turn, so its final message is the handover.
 */
export async function finalAgentMessage(sdk: Sdk, threadId: string): Promise<{ text: string; seq: number } | null> {
  return (await latestCompletedTurn(sdk, threadId))?.final ?? null;
}
