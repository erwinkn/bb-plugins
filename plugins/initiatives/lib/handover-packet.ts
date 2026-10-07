import { openBlockers } from "./blockers";
import { redactCredentials as safe, redactDeep } from "./redact";
import { taskRef, workerRef, type AssignmentRecord, type RefStatus, type Store, type TaskRecord } from "./store";

/**
 * The handover packet (W191 audit, F2–F4): what a replacement coordinator's writer reads.
 * Everything here is pure: the native facts arrive as a dated snapshot gathered beforehand
 * (lib/handover-snapshot.ts), so a packet can be rebuilt and tested from fixtures. A fact
 * that could not be read says so; it is never shown as empty.
 */

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string };
export const unavailable = <T>(reason: string): Read<T> => ({ ok: false, reason });
export const available = <T>(value: T): Read<T> => ({ ok: true, value });

export interface ConversationMessage {
  /** The BB event id; a message is identified by it, never by its text. */
  id: string;
  seq: number;
  at: number | null;
  /** user: the user's own input. coordinator: the thread's own agent. agent/system: messages from other threads or BB. */
  from: "user" | "coordinator" | "agent" | "system";
  /** The sending thread, when a message came from another thread. */
  sender: string | null;
  text: string;
}

/** A command the coordinator ran that changed something outside the ledger. */
export interface CoordinatorAction { seq: number; at: number | null; command: string; exitCode: number | null }

export interface WorkerLive {
  threadId: string;
  /** Native status: idle, active, error, ...; queued and background counts. */
  status: Read<{ status: string; queued: number; background: number }>;
  /** The worker's latest substantive messages, oldest first. */
  /** complete: false when the scan bound stopped before it found enough messages. */
  tail: Read<{ messages: ConversationMessage[]; complete: boolean }>;
  /** The pull request of the worker's own branch, when it has one. */
  pullRequest?: Read<{ number: number | null; state: string; title: string | null } | null>;
}

export interface NativeChild { threadId: string; title: string | null; status: string; createdAt: number | null }

export interface CheckoutState {
  environmentId: string;
  path: string | null;
  hostId: string | null;
  branch: string | null;
  headSha: string | null;
  defaultBranch: string | null;
  ahead: number | null;
  behind: number | null;
  changedFiles: number;
  sampleFiles: string[];
  commits: { shortSha: string; subject: string; at: number | null }[];
}

export interface HandoverSnapshot {
  capturedAt: number;
  /** home: the checkout the outgoing coordinator ran in, to compare with the destination. */
  incumbent: { threadId: string | null; status: Read<string>; home?: Read<{ environmentId: string; path: string | null; hostId: string | null } | null> };
  /** taskMentions: the coordinator's latest message naming each open task, from as far back as the scan went. */
  /** answers: the final coordinator answer each user message received, keyed by the user message's id. */
  /** actions: commands the coordinator ran that change things outside the ledger, oldest first. */
  conversation: Read<{ messages: ConversationMessage[]; complete: boolean; taskMentions?: Record<string, ConversationMessage>; answers?: Record<string, ConversationMessage>; actions?: CoordinatorAction[] }>;
  /** Keyed by W#. */
  workers: Record<string, WorkerLive>;
  /** Native children of the coordinator that are not registered workers. */
  children: Read<NativeChild[]>;
  /** Where the new coordinator will run. */
  checkout: Read<CheckoutState> | null;
}

export const PACKET_MAX = 60_000;
export const FALLBACK_MAX = 24_000;

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "unknown time" : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** A long text keeps both its start and its end: conclusions usually come last. */
export function headTail(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${t.slice(0, head).trimEnd()}\n[… ${t.length - head - tail} characters omitted …]\n${t.slice(-tail).trimStart()}`;
}

const TASK_STATUS: Record<string, string> = {
  planned: "planned", in_progress: "in progress", blocked: "blocked", awaiting_acceptance: "reported, still open",
};
const ASSIGNMENT_STATE: Record<string, string> = {
  dispatching: "starting", queued: "queued", running: "running", idle_no_report: "turn ended without a report",
  reported: "reported", accepted: "done", rejected: "superseded", stopped: "stopped", cancelled: "cancelled", failed: "failed",
};
const outcomeOf = (a: AssignmentRecord) =>
  a.report ? (a.report.outcome === "succeeded" ? "done" : a.report.outcome) : ASSIGNMENT_STATE[a.state] ?? a.state;
function reportText(a: AssignmentRecord) {
  return safe(rawReportText(a));
}
function rawReportText(a: AssignmentRecord) {
  const r = a.report;
  if (!r) return "";
  if (r.finalMessage) return unheaded(r.finalMessage);
  const h = r.handoff;
  return [
    r.summary,
    h.summary !== r.summary ? h.summary : null,
    r.blocker ? `Blocked: ${r.blocker.question}` : null,
    h.nextSteps.length ? `Next steps: ${h.nextSteps.join("; ")}` : null,
    h.openQuestions.length ? `Open questions: ${h.openQuestions.join("; ")}` : null,
    r.evidence.filter(e => e.kind === "artifact" && e.ref).length ? `Artifacts: ${r.evidence.filter(e => e.kind === "artifact" && e.ref).map(e => e.ref).join(", ")}` : null,
  ].filter(Boolean).join("\n");
}
const describeRead = <T>(read: Read<T>, show: (value: T) => string) => (read.ok ? show(read.value) : `unavailable (${read.reason})`);
const who = (m: ConversationMessage) =>
  m.from === "user" ? "User" : m.from === "coordinator" ? "Coordinator" : m.from === "agent" ? `Message from ${m.sender ?? "another thread"}` : "BB notice";
/** Headings inside a message or report would read as packet sections: keep their text, drop the marks. */
const unheaded = (text: string) => text.replace(/^#{1,6}[ \t]+/gm, "");
const renderMessage = (m: ConversationMessage, max: number, author = who(m)) => `[${iso(m.at)} · ${author}] ${headTail(unheaded(m.text), max)}`;

/** Fit lines into a budget, keeping the newest (the end of the list). */
function fitNewest(lines: string[], budget: number) {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i]!.length + 2;
    if (used + cost > budget) break;
    kept.unshift(lines[i]!);
    used += cost;
  }
  return { kept, dropped: lines.length - kept.length, used };
}

/** The status of a question or decision ref as current metadata (not a digest of the log, D402). */
function refStatus(r: RefStatus) {
  if (r.status === "superseded") return `superseded${r.supersededBy ? ` by D${r.supersededBy}` : ""}; not open, don't raise it`;
  if (r.status === "answered") return "answered; not open";
  if (r.status === "closed") return r.question ? "closed by the user without an answer; not open, don't ask again" : "closed; not open";
  if (r.status === "withdrawn") return "withdrawn; not open";
  if (r.status === "removed" || r.status === "rejected") return `${r.status}; not open`;
  if (r.status === "active" && r.question && r.madeBy === null) return "open question, waiting for the user";
  if (r.status === "active" && r.madeBy === "user") return "a recorded user choice";
  if (r.status === "active" && r.madeBy === "agent") return r.review === "pending" ? "an agent decision, an optional check in the user's Inbox" : `an agent decision, reviewed (${r.review ?? "no review"})`;
  // Older ledger states (proposed, rejected, …) are history, not questions for the user.
  return r.status === "active" ? (r.kind === "decision" ? "a recorded decision" : r.kind) : `${r.status} (an older ledger state); not open`;
}

/**
 * Build the packet within `budget`. The fixed sections (header, workers, threads, checkout,
 * tasks, what waits on the user, updates) are sized first; the conversation and the user's
 * older messages share what is left, with room kept for the user's last ten messages and for
 * the latest reports.
 */
export function handoverPacket(store: Store, projectId: string, unsafeSnapshot: HandoverSnapshot, unsafeNote: string | null, budget = PACKET_MAX): string {
  // W194 #5: credentials are removed from every input before anything is budgeted, so the
  // limits hold on the text the writer actually gets.
  const snapshot = redactDeep(unsafeSnapshot);
  const note = unsafeNote === null ? null : safe(unsafeNote);
  const project = store.project(projectId)!;
  const tasks = store.tasks(projectId);
  const assignments = store.assignments(projectId);
  const decisions = store.decisions(projectId, { includeHistory: true });
  const live = store.workers(projectId).filter(w => w.state !== "retired");
  const messages = snapshot.conversation.ok ? snapshot.conversation.value.messages : [];
  const newestMessage = messages.length ? Math.max(...messages.map(m => m.at ?? 0)) : null;
  const small = budget < PACKET_MAX;
  // The user's words and the coordinator's own conclusions get the room; messages from other
  // threads and BB notices repeat what reports and workers already say, so they stay short.
  const room = { user: small ? 1200 : 3000, coordinator: small ? 900 : 1800, agent: small ? 400 : 700, system: small ? 200 : 300 };

  // A. What this is, when it was captured, and from whom.
  const header = [
    `# Initiative "${project.name}"`,
    `Snapshot captured at ${iso(snapshot.capturedAt)}. Older dates below are history; prefer newer facts.`,
    `Objective: ${clip(safe(project.objective), 1500)}`,
    `Outgoing coordinator: ${snapshot.incumbent.threadId ?? "none"} (${describeRead(snapshot.incumbent.status, s => s)}).`,
    note ? `## Note from the outgoing coordinator or the user\n${headTail(note, 3000)}` : null,
  ].filter(Boolean).join("\n");

  // C. Live workers: native status, current work, latest report and their own latest messages.
  let workers = "## Live workers\nNone.";
  if (live.length) {
    const perWorker = Math.max(600, Math.min(4000, Math.floor((small ? budget / 3 : 16_000) / live.length)));
    const blocks = live.map(w => {
      const mine = assignments.filter(a => a.workerNum === w.num);
      const current = mine.find(a => ["dispatching", "queued", "running", "idle_no_report"].includes(a.state));
      const last = mine.filter(a => a.report).at(-1);
      const native = snapshot.workers[w.ref];
      const lines = [
        `### ${w.ref} "${safe(w.label)}" · ${w.role} · ${safe(w.area)}`,
        `Thread ${w.threadId ?? "none"}; native status: ${native ? describeRead(native.status, s => `${s.status}${s.queued ? `, ${s.queued} queued` : ""}${s.background ? `, ${s.background} background` : ""}`) : "unavailable (not read)"}.`,
        current ? `Current work: ${current.ref} (${ASSIGNMENT_STATE[current.state] ?? current.state}, since ${iso(current.createdAt)})${current.taskNums.length ? ` on ${current.taskNums.map(taskRef).join(", ")}` : ""}.` : "No open work recorded.",
        last ? `Latest report ${last.ref} (${outcomeOf(last)}, ${iso(last.reportedAt)}): ${headTail(reportText(last), Math.floor(perWorker * 0.5))}` : "No report yet.",
        native?.pullRequest ? `Pull request of its branch: ${describeRead(native.pullRequest, pr => (pr ? `#${pr.number ?? "?"} ${pr.state}${pr.title ? ` "${pr.title}"` : ""} (read at capture)` : "none"))}.` : null,
        native ? `Its latest messages: ${describeRead(native.tail, ({ messages: tail, complete }) => (tail.length ? `\n${tail.map(m => `  - ${renderMessage(m, Math.floor(perWorker * 0.3), m.from === "coordinator" ? w.ref : who(m))}`).join("\n")}${complete ? "" : "\n  (earlier messages not scanned)"}` : complete ? "none" : "none in its latest events scanned"))}` : null,
      ].filter(Boolean);
      return clip(lines.join("\n"), perWorker);
    });
    workers = `## Live workers (${live.length})\nA report is what a worker last filed; its latest messages and native status show what it is doing now.\n\n${blocks.join("\n\n")}`;
  }

  // D. Native threads under the coordinator that are not registered workers.
  const children = !snapshot.children.ok ? `## Other threads under the coordinator\nUnavailable: ${snapshot.children.reason}.`
    : snapshot.children.value.length ? `## Other threads under the coordinator (no W#; not registered workers)\n${snapshot.children.value.slice(0, 15).map(c => `- ${c.threadId} "${c.title ?? "untitled"}" · ${c.status} · started ${iso(c.createdAt)}`).join("\n")}`
    : null;

  // E. Where the new coordinator runs, next to where the old one ran (Red Metal's RM1).
  const home = snapshot.incumbent.home;
  const outgoing = !home ? null : describeRead(home, h => (h ? `${h.path ?? "unknown path"} on host ${h.hostId ?? "unknown"}` : "no checkout recorded"));
  const moved = home?.ok && home.value && snapshot.checkout?.ok && (home.value.path !== snapshot.checkout.value.path || home.value.hostId !== snapshot.checkout.value.hostId);
  const checkout = snapshot.checkout
    ? `## Destination checkout (where the new coordinator runs)\n${outgoing ? `The outgoing coordinator ran in ${outgoing}.${moved ? " The new coordinator runs in a different checkout:" : ""}\n` : ""}${describeRead(snapshot.checkout, c => [
      `${c.path ?? "unknown path"} on host ${c.hostId ?? "unknown"} (environment ${c.environmentId}).`,
      `Branch ${c.branch ?? "unknown"} at ${c.headSha?.slice(0, 12) ?? "unknown"}; default branch ${c.defaultBranch ?? "unknown"}${c.ahead !== null || c.behind !== null ? `; ${c.ahead ?? "?"} ahead, ${c.behind ?? "?"} behind` : ""}.`,
      `Working tree: ${c.changedFiles ? `${c.changedFiles} changed files${c.sampleFiles.length ? ` (${c.sampleFiles.slice(0, 8).join(", ")}${c.changedFiles > 8 ? ", …" : ""})` : ""}` : "clean"}.`,
      c.commits.length ? `Commits on the branch not on ${c.defaultBranch ?? "the default branch"}: ${c.commits.slice(0, 8).map(k => `${k.shortSha} ${clip(k.subject, 80)}`).join("; ")}.` : null,
    ].filter(Boolean).join("\n"))}\nPull request numbers in reports and messages are history unless their state appears above as read at capture.`
    : null;

  // F. Open tasks, with their latest progress dated.
  const open = tasks.filter(t => !["done", "cancelled"].includes(t.status));
  // A task's progress note can be older than what the coordinator said about it since.
  const mentions = snapshot.conversation.ok ? snapshot.conversation.value.taskMentions ?? {} : {};
  const latestWord = (t: TaskRecord) => {
    const m = mentions[t.ref];
    return m && (m.at ?? 0) > t.updatedAt ? `\n  Newer, from the coordinator (${iso(m.at)}): ${headTail(unheaded(m.text), small ? 300 : 600).replace(/\n+/g, " ")}` : "";
  };
  const openTasks = `## Open tasks (${open.length})\n${open.length ? open.slice(0, 40).map((t: TaskRecord) => `- ${t.ref} [${TASK_STATUS[t.status] ?? t.status}] ${clip(safe(t.title), 160)}${t.progress ? ` — ${clip(safe(t.progress), 220)} (as of ${iso(t.updatedAt)})` : ""}${latestWord(t)}`).join("\n") : "None."}`;

  // G. What waits on the user. Agent decisions are optional Inbox checks and block nothing.
  const questions = decisions.filter(d => d.status === "active" && d.humanAttention === "needs-opinion" && d.madeBy === null);
  const blockers = openBlockers(assignments.map(a => ({ ...a, outcome: a.report?.outcome ?? null })), num => ["done", "cancelled"].includes(store.task(projectId, num)?.status ?? ""));
  const checks = decisions.filter(d => d.madeBy === "agent" && d.review === "pending" && d.status === "active");
  const waiting = `## Waiting on the user\n${[
    ...questions.map(d => `- Open question ${d.ref} (asked ${iso(d.createdAt)}): ${clip(safe(("question" in d.body && d.body.question) || d.title), 400)}${d.blocks.length ? ` — holds ${d.blocks.map(taskRef).join(", ")}` : ""}`),
    ...blockers.map(a => `- ${workerRef(a.workerNum)} reported blocked (${a.ref}, ${iso(a.reportedAt)}): ${clip(safe(a.report?.blocker?.question ?? a.report?.summary ?? ""), 400)}`),
    checks.length ? `- ${checks.length} agent decision${checks.length > 1 ? "s" : ""} wait for the user's Okay or Not okay in the Inbox. They are optional checks and block no work.` : null,
  ].filter(Boolean).join("\n") || "Nothing."}`;

  // L. What the coordinator did outside the ledger, which its messages may not mention.
  const actions = snapshot.conversation.ok ? snapshot.conversation.value.actions ?? [] : [];
  const actionsSection = actions.length
    ? `## Commands the old coordinator ran that changed things outside the Initiative (oldest first)\n${actions.map(a => `- [${iso(a.at)}] ${clip(a.command.replace(/\s+/g, " "), small ? 120 : 200)}${a.exitCode === null ? " (exit status unknown)" : a.exitCode === 0 ? " (ran, exit 0, not verified)" : ` (failed, exit ${a.exitCode})`}`).join("\n")}`
    : null;

  // K. Updates: newer than the conversation are current; older ones are history.
  const updates = store.updates(projectId, 5);
  const fresh = updates.filter(u => newestMessage === null || u.createdAt > newestMessage);
  const historical = newestMessage === null ? updates.slice(0, 2).filter(u => !fresh.includes(u)) : [];
  const updatesSection = fresh.length || historical.length
    ? `## Updates\n${[...fresh.map(u => `- ${u.ref} (${iso(u.createdAt)}): ${clip(safe(u.body), 600)}`), ...historical.map(u => `- Historical, ${iso(u.createdAt)} — may be out of date: ${clip(safe(u.body), 400)}`)].join("\n")}`
    : null;

  // J. Recent reports not already shown under a live worker.
  const shown = new Set(live.map(w => assignments.filter(a => a.workerNum === w.num && a.report).at(-1)?.num));
  const reports = assignments.filter(a => a.report && !shown.has(a.num)).sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0)).slice(0, 10);

  // B and I. The conversation fills what is left, keeping room for the latest reports, the
  // ref statuses and the user's last ten messages; user messages older than the conversation
  // window are listed on their own, so none of them is shown twice.
  const fixed = [header, workers, children, checkout, openTasks, waiting, actionsSection, updatesSection].filter(Boolean).join("\n\n").length;
  const reportRoom = reports.length ? (small ? 2000 : 9000) : 0;
  const refRoom = small ? 800 : 2500;
  const flexible = Math.max(0, budget - fixed - reportRoom - refRoom - 400);
  const users = messages.filter(m => m.from === "user");
  // A user message older than the window carries the answer it got, so an instruction that was
  // carried out does not read as still to do.
  const answers = snapshot.conversation.ok ? snapshot.conversation.value.answers ?? {} : {};
  const answerOf = (m: ConversationMessage) => {
    const a = answers[m.id];
    return a ? `\n  Answered (${iso(a.at)}): ${headTail(unheaded(a.text), small ? 250 : 500).replace(/\n+/g, " ")}` : "";
  };
  const userLine = (m: ConversationMessage) => `- ${renderMessage(m, room.user)}${answerOf(m)}`;
  const userRoom = Math.min(users.slice(-10).reduce((n, m) => n + userLine(m).length + 1, 0), small ? budget / 4 : 14_000);
  // The newest twenty messages keep their full room; older ones keep a shorter start and end.
  // Inputs reach further back than the coordinator's own messages: mark where those begin, and
  // give a user message from before that point the answer it got.
  const ids = new Set(messages.map(m => m.id));
  const firstReply = messages.findIndex(m => m.from === "coordinator");
  // The replies the user actually read to their last five messages keep up to 8,000 characters
  // each (16,000 in all): long explanations the user asked for are rarely safe to cut.
  const answerRoom = new Map<string, number>();
  if (!small) {
    let left = 16_000;
    for (const u of [...users].reverse().slice(0, 5)) {
      const a = answers[u.id];
      if (!a || answerRoom.has(a.id) || left <= 0) continue;
      const take = Math.min(8000, left, Math.max(room.coordinator, a.text.length));
      answerRoom.set(a.id, take);
      left -= take;
    }
  }
  const lines = messages.map((m, i) => {
    const line = renderMessage(m, answerRoom.get(m.id) ?? (i >= messages.length - 20 ? room[m.from] : Math.ceil(room[m.from] * 0.4)));
    const answer = m.from === "user" && answers[m.id] && !ids.has(answers[m.id]!.id) ? answerOf(m) : "";
    const marker = i === firstReply && i > 0 ? "[The coordinator's own messages start here; before this point only messages to it and the answers they got are shown.]\n\n" : "";
    return `${marker}${line}${answer}`;
  });
  const conversation = fitNewest(lines, flexible - userRoom);
  const windowStart = messages.length - conversation.kept.length;
  const earlier = fitNewest(users.filter(m => messages.indexOf(m) < windowStart).map(userLine), flexible - conversation.used);
  const inWindow = users.length - users.filter(m => messages.indexOf(m) < windowStart).length;
  const userSection = !snapshot.conversation.ok ? `## The user's recent messages\nUnavailable: ${snapshot.conversation.reason}.`
    : !users.length ? "## The user's recent messages\nNone in the scanned conversation."
    : earlier.kept.length ? `## The user's earlier messages to the old coordinator (older than the conversation below; newest last${earlier.dropped ? `; ${earlier.dropped} older omitted` : ""})\n${earlier.kept.join("\n")}`
    : earlier.dropped ? `## The user's earlier messages\n${earlier.dropped} older than the conversation below are omitted for space.`
    : null;
  const conversationSection = conversation.kept.length
    ? `## Recent conversation in the old coordinator thread (oldest first; ${inWindow} from the user${conversation.dropped ? `; ${conversation.dropped} older omitted for space` : ""}${snapshot.conversation.ok && !snapshot.conversation.value.complete ? "; earlier history not scanned" : ""})\n${conversation.kept.join("\n\n")}`
    : null;

  const parts = [header, userSection, workers, children, checkout, openTasks, waiting, actionsSection, conversationSection].filter((p): p is string => !!p);
  let used = parts.join("\n\n").length;
  if (reports.length) {
    const left = budget - used - refRoom - (updatesSection?.length ?? 0) - 200;
    if (left > 500) {
      const per = Math.max(300, Math.min(1200, Math.floor((left - 200) / reports.length)));
      const section = `## Recent reports from other work (newest first)\n${reports.map(a => `- ${a.ref} · ${workerRef(a.workerNum)}${a.taskNums.length ? ` · ${a.taskNums.map(taskRef).join(", ")}` : ""} · ${outcomeOf(a)} · ${iso(a.reportedAt)}: ${headTail(reportText(a), per)}`).join("\n")}`;
      parts.push(clip(section, left));
    }
  }
  if (updatesSection) parts.push(updatesSection);

  // H. The current status of every question, decision or closed task the packet mentions, so an
  // old message never reads as current (K# is the old name of D#).
  let text = clip(parts.join("\n\n"), budget);
  const nums = [...new Set([...text.matchAll(/\b[DK](\d+)\b/g)].map(m => Number(m[1])))].sort((a, b) => a - b).slice(0, 60);
  const statuses = store.refStatuses(projectId, nums)
    .map(r => `- D${r.num}${new RegExp(`\\bK${r.num}\\b`).test(text) ? ` (also written K${r.num})` : ""}: ${refStatus(r)}.`);
  const openRefs = new Set(open.map(t => t.ref));
  const closedTasks = [...new Set([...text.matchAll(/\bT(\d+)\b/g)].map(m => Number(m[1])))].sort((a, b) => a - b)
    .map(n => store.task(projectId, n)).filter((t): t is TaskRecord => !!t && !openRefs.has(t.ref)).slice(0, 40)
    .map(t => `- ${t.ref} "${clip(safe(t.title), 100)}": ${t.status}, closed ${iso(t.updatedAt)}.`);
  statuses.push(...closedTasks);
  if (statuses.length) {
    const section = `## Current status of the refs mentioned above (questions, decisions, closed tasks)\n${statuses.join("\n")}`;
    text = text.length + section.length + 2 <= budget ? `${text}\n\n${section}` : `${clip(text, Math.max(0, budget - section.length - 2))}\n\n${section}`;
  }
  return text;
}

/** The writer's instructions (W191 audit, F4). */
export function handoverPrompt(name: string, packet: string): string {
  return [
    `Write a short handover for the new coordinator of the Initiative "${name}" from this dated snapshot. The new coordinator has no memory but your text.`,
    "",
    "- Carry the user's still-applicable instructions, current work and its owner (W#), genuine unanswered questions and blockers, and concrete next actions. Blockers include failures the latest messages show, such as errors, rate limits or disconnects.",
    "- Prefer later confirmed facts over older reports: a newer message saying something merged, shipped or resumed wins over an older report or task note. Mark conflicts and unavailable state with their source and date.",
    "- A question or decision ref is open only if the status list at the end says so. Never ask the user again about a closed, answered, withdrawn or superseded one.",
    "- The commands the old coordinator ran are evidence of what it attempted, for example after a report asked for it: mention them, but a command is not proof that something succeeded.",
    "- A worker saying it recorded no decisions applies only to that work.",
    "- Agent decisions waiting in the Inbox are optional checks; they block nothing.",
    "- Use the current protocol: send work or fixes with initiative_message, close tasks when done, retire finished workers. There is no acceptance step.",
    "- This coordinator replacement is complete once your text is read: don't propose another replacement or recreation.",
    "- Don't call an intact user message truncated because its answer was clipped.",
    "- Don't invent anything; say when you're unsure. Don't run tools or read files: everything you need is below.",
    "- About 600 words; add only the space needed to keep an instruction or an active workstream. Output only the handover.",
    "",
    "---",
    "",
    packet,
  ].join("\n");
}

/** The plain listing used when Luna can't write the handover: the same packet, smaller. */
export function fallbackBody(store: Store, projectId: string, snapshot: HandoverSnapshot, note: string | null): string {
  return handoverPacket(store, projectId, snapshot, note, FALLBACK_MAX);
}

export const withReason = (body: string, why: string) => `(Generated without Luna: ${why}.)\n\n${body}`;

/** A snapshot with nothing read natively: used when only the ledger is at hand. */
export const emptySnapshot = (capturedAt: number, incumbent: string | null, reason = "not read"): HandoverSnapshot => ({
  capturedAt,
  incumbent: { threadId: incumbent, status: unavailable(reason), home: unavailable(reason) },
  conversation: unavailable(reason),
  workers: {},
  children: unavailable(reason),
  checkout: null,
});
