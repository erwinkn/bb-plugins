import { bytes } from "./tree";
import { senderParts } from "./sender-parts";

/**
 * D431: a scope's append-only memory log, one row per message across all of its threads. It is
 * read from BB's own thread events, which every provider writes the same way (Claude Code and
 * Codex alike), never from a provider's transcript files. Kinds follow the gist, with "agent" for
 * its "unii"; thoughts are never logged.
 */
export const MEMORY_KINDS = ["user", "agent", "tool", "echo", "work", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryMessage {
  i: number;
  kind: MemoryKind;
  text: string;
  size: number;
  /** When BB recorded it (ms). */
  at: number;
  threadId: string | null;
  seq: number | null;
  /** Stable semantic-entry ordinal in the source event, independent of sender labels and splits. */
  sourcePart?: number | null;
  /** Request whose acceptance logged this input; seq still names the canonical original. */
  requestId?: string | null;
  /**
   * W571: a group of tool uses in a row, from event seq through this one (null: one event, as
   * logged before groups).
   */
  endSeq?: number | null;
  /** W571: the number of tool uses in that group, so a zoom can tell when one is missing. */
  uses?: number | null;
}
export type LogEntry = Omit<MemoryMessage, "i" | "size">;

/** Tool output keeps its head and tail, 30,000 characters in all; other long text is split. */
export const CLIP = 30_000;
const SPLIT = 30_000;
/**
 * W571: a run of tool uses (those between two other entries) is logged as groups of at most
 * GROUP_USES uses or GROUP_BYTES bytes, whichever is reached first; a use larger than that is a
 * group alone. Uses within a group are separated by USES.
 */
export const GROUP_USES = 8;
export const GROUP_BYTES = 16_000;
export const USES = "\n\n";

export const clip = (s: string) =>
  s.length <= CLIP ? s : `${s.slice(0, CLIP / 2)}\n[... ${s.length - CLIP} chars clipped ...]\n${s.slice(-CLIP / 2)}`;

/** One entry per 30,000 characters, so no message is ever whole-summarized past that. */
export function splitEntry(entry: LogEntry): LogEntry[] {
  const text = entry.text.trim();
  if (!text) return [];
  const parts: LogEntry[] = [];
  for (let k = 0; k < text.length; k += SPLIT) parts.push({ ...entry, text: text.slice(k, k + SPLIT) });
  return parts;
}
export const withSize = (entry: LogEntry, i: number): MemoryMessage => ({ ...entry, i, size: bytes(entry.text) });

export interface EventRow {
  seq: number;
  type: string;
  createdAt?: number | string;
  data?: Record<string, any>;
}
/** The event types the log reads. */
export const LOG_EVENT_TYPES = ["client/turn/requested", "item/completed", "provider/error", "provider/unhandled", "turn/completed", "turn/input/accepted", "client/turn/rejected"] as const;
/** How an OptChat turn that could not get its memory fails (D458); BB records it in the turn's provider/error. */
export const UNAVAILABLE = "OptChat memory unavailable for this turn";
/** T143: a stopped turn's mark, after whatever it had said, so later views know its reply was cut off. */
export const STOPPED = "[bb] (stopped) This turn was stopped before it finished.";

/** What the log needs to know about the thread an event belongs to. */
export interface ThreadFacts {
  /** A plugin spawned it, so its first message is that plugin's brief or handover: a note. */
  spawnedByPlugin: boolean;
  /** A sending thread's short name, for "[name] …". */
  sender: (threadId: string) => string;
}

const CONTINUED = /^This session is being continued from a previous conversation/;
const timeOf = (row: EventRow) => {
  const v = row.createdAt;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};
const inputText = (input: unknown) =>
  Array.isArray(input) ? input.filter((c) => typeof c?.text === "string").map((c) => c.text as string).join("\n") : "";
const json = (value: unknown) => {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), omitBlobs); } catch { return value; }
  }
  return JSON.stringify(value, omitBlobs);
};
function omitBlobs(this: Record<string, unknown>, key: string, value: unknown) {
  const image = this.type === "image" || this.type === "image_url";
  return typeof value === "string" && ((image && ["data", "base64"].includes(key)) || (["url", "image_url"].includes(key) && value.startsWith("data:image/"))) ? "[attachment data; retrieve with memory_zoom]" : value;
}
const toolName = (name: unknown) => String(name ?? "tool").replace(/^mcp__bb-bridge__/, "");

/** Between a tool call and its result in one tool entry: "Bash git status\n→ exit 0\nclean". */
export const RESULT = "\n→ ";
/** The item types logged as a call and its result. */
export const TOOL_USES: ReadonlySet<string> = new Set(["toolCall", "commandExecution", "fileChange"]);

export interface EntryOptions {
  /** The source text unclipped, as zoom returns it. */
  original?: boolean;
  /**
   * W571: the entries as logged before, a tool entry for the call and an echo entry for its
   * result. Only zoom asks for them, to select a row logged that way.
   */
  legacy?: boolean;
}

/** One BB event of a thread as log entries (a tool use is one tool entry: its call and result), or none. Tool uses are grouped later (Runs). */
export function eventEntries(row: EventRow, threadId: string, facts: ThreadFacts, { original = false, legacy = false }: EntryOptions = {}): LogEntry[] {
  const output = original ? (s: string) => s : clip;
  const base = { at: timeOf(row), threadId, seq: row.seq };
  let sourcePart = 0;
  const entry = (kind: MemoryKind, text: string): LogEntry[] => (text.trim() ? [{ ...base, kind, text: text.trim(), sourcePart: sourcePart++, ...(row.type === "client/turn/requested" ? {requestId: row.data?.requestId ?? null} : {}) }] : []);
  // The result keeps its head and tail (clip); the call stays whole.
  const use = (call: string, result: string): LogEntry[] => {
    const out = output(result).trim();
    return legacy ? [...entry("tool", call), ...entry("echo", out)] : entry("tool", out ? `${call.trim()}${RESULT}${out}` : call);
  };
  const d = row.data ?? {};
  if (row.type === "client/turn/requested") {
    const text = [inputText(d.input).trim(), ...(Array.isArray(d.input) ? d.input.filter(c => ["localImage","localFile","image"].includes(c.type)).map(c => `[attachment: ${c.path ?? (typeof c.url === "string" && c.url.startsWith("data:") ? "inline image" : c.url) ?? c.type}]`) : [])].filter(Boolean).join("\n");
    // A retry re-submits a request that is logged already, or says "Please continue." after it.
    if (!text || d.retryOfRequestId) return [];
    if (d.initiator === "agent") {
      // One entry per sender: a turn may carry several agents' queued messages.
      return senderParts(d).flatMap(({ sender, input, batched }) => {
        const part = inputText(input).trim();
        const body = batched ? part : part.replace(/^\[bb message from thread:\S+\]\s*/, "");
        return entry("work", `[${sender === null ? "thread" : facts.sender(sender)}] ${body}`);
      });
    }
    if (d.initiator === "system") return entry("work", `[bb] ${text.replace(/^\[bb system\]\s*/, "")}`);
    // BB's /compact is the compaction itself, logged as a note when its summary appears.
    if (/^\/compact\b/.test(text)) return [];
    return entry(d.source === "spawn" && facts.spawnedByPlugin ? "note" : "user", text);
  }
  if (row.type === "provider/unhandled") {
    // Claude Code's compaction summary reaches BB only as an unhandled SDK user message.
    const content = d.rawEvent?.params?.message?.message?.content;
    return d.rawType === "sdk/user" && typeof content === "string" && CONTINUED.test(content) ? entry("note", content) : [];
  }
  if (row.type === "turn/completed") return d.status === "interrupted" ? entry("work", STOPPED) : [];
  if (row.type !== "item/completed") return [];
  const item = d.item as Record<string, any> | undefined;
  if (!item || item.parentToolCallId || item.presentation?.suppress === true) return [];
  switch (item.type) {
    case "agentMessage":
      return entry("agent", String(item.text ?? ""));
    case "reasoning":
    case "userMessage":
      return [];
    case "contextCompaction":
      return entry("note", "Context compacted: the agent's earlier context was replaced by a summary.");
    case "toolCall":
      return use(`${toolName(item.tool)} ${json(item.arguments ?? {})}`, [json(item.result), item.error ? `error: ${json(item.error)}` : ""].filter(Boolean).join("\n"));
    case "commandExecution":
      return use(`Bash ${String(item.command ?? "")}`, `${item.exitCode != null ? `exit ${item.exitCode}\n` : ""}${String(item.aggregatedOutput ?? "")}`);
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return use(
        `Edit ${changes.map((c: { kind?: string; path?: string }) => `${c.kind ?? "change"} ${c.path ?? "?"}`).join(", ")}`,
        changes.map((c: { diff?: string }) => c.diff ?? "").join("\n"),
      );
    }
    default: {
      const { type, id: _id, status: _status, presentation: _p, ...rest } = item;
      return entry("tool", output(`${type} ${json(rest)}`));
    }
  }
}

/**
 * A thread's completed turns (readTurns: its rows end with a turn/completed) as log entries, in
 * order. D502: the requests of a turn that failed with UNAVAILABLE, before any output, are left
 * out: the turn never reached the model, and BB keeps the text for the user to send again. Any
 * other failed turn keeps its requests, so after BB's automatic "Please continue." the memory
 * still holds the question.
 */
export function turnEntries(rows: readonly EventRow[], threadId: string, facts: ThreadFacts): LogEntry[] {
  // A run never spans a turn end, as in stableEntries: the entries come sorted by seq, so a group
  // closes at the first entry past a turn/completed.
  const ends = rows.filter((r) => r.type === "turn/completed").map((r) => r.seq).sort((a, b) => a - b);
  const runs = new Runs();
  let k = 0;
  for (const e of turnLog(rows, threadId, facts)) {
    if (k < ends.length && ends[k]! < (e.seq ?? 0)) runs.close();
    while (k < ends.length && ends[k]! < (e.seq ?? 0)) k++;
    runs.push(e);
  }
  runs.close();
  return runs.out.flatMap(splitEntry);
}
/** turnEntries' entries one by one, before tool uses are grouped and long text is split. */
function turnLog(rows: readonly EventRow[], threadId: string, facts: ThreadFacts): LogEntry[] {
  const entries: LogEntry[] = [];
  let turn: Array<{ request: boolean; entries: LogEntry[] }> = [];
  let unavailable = false;
  for (const row of rows) {
    const logged = eventEntries(row, threadId, facts);
    if (row.type === "provider/error" && String(row.data?.detail ?? "").includes(UNAVAILABLE)) unavailable = true;
    if (row.type !== "turn/completed") {
      turn.push({ request: row.type === "client/turn/requested", entries: logged });
      continue;
    }
    const unsent = unavailable && row.data?.status === "failed" && !turn.some((t) => !t.request && t.entries.length);
    for (const t of turn) if (!(unsent && t.request)) entries.push(...t.entries);
    entries.push(...logged);
    turn = [];
    unavailable = false;
  }
  return entries.sort((a,b) => (a.seq ?? 0)-(b.seq ?? 0));
}

/**
 * W571: groups the tool uses of a run as they come (GROUP_USES, GROUP_BYTES). Any other entry
 * closes the open group, and so does the end of a turn; a group is logged once closed, so no
 * logged row ever grows.
 */
class Runs {
  out: LogEntry[] = [];
  open: LogEntry[] = [];
  private bytes = 0;
  push(...entries: LogEntry[]) {
    for (const e of entries) {
      if (e.kind !== "tool") {
        this.close();
        this.out.push(e);
        continue;
      }
      const size = bytes(e.text);
      if (this.open.length && (this.open.length >= GROUP_USES || this.bytes + USES.length + size > GROUP_BYTES)) this.close();
      this.bytes += (this.open.length ? USES.length : 0) + size;
      this.open.push(e);
      // A full group is logged at once, not when the next entry comes (review r4 P2).
      if (this.open.length >= GROUP_USES || this.bytes >= GROUP_BYTES) this.close();
    }
  }
  close() {
    const [first] = this.open;
    if (first) this.out.push({ ...first, text: this.open.map((e) => e.text).join(USES), endSeq: this.open.at(-1)!.seq, uses: this.open.length });
    this.open = [];
    this.bytes = 0;
  }
}

/** Requests remain durable but invisible until the provider confirms acceptance. */
export interface IngestState {
  pending: EventRow[];
  buffered?: EventRow[];
  /** Pre-acceptance failures are recoverable by a later accepted retry, never by legacy completion. */
  unsent?: EventRow[];
  modern: boolean;
  /**
   * W571: the last seq whose requests and rejections this state holds. Set when a read parks: the
   * next read reads the parked range again and skips them.
   */
  through?: number;
}
/**
 * The entries of a read of rows after the thread's cursor, with the ingestion state to save
 * alongside them; `from` is left as it was.
 *
 * W571: a read that ends inside a run of tool uses logs what came before the run and parks the
 * cursor just before the row that opened it (`parked`), with the state as it stood there: the
 * next read reads the run again and logs it once it closes. Only a plain item/completed opens a
 * run, and an acceptance or a turn end closes one, so besides the run's uses a parked range holds
 * only entry-less events and requests or rejections. The state returned keeps those (review r2
 * P1: a request read before a scope move belongs to the old scope, parked or not) and marks them
 * read (`through`), so the next read of the range skips them.
 * The open group is logged at once instead when `final` (the thread was archived: no turn of it
 * goes on), or when parking would leave the cursor at or before `advance` (a read with more to
 * read must move it, or it would read the same range again forever).
 */
export function stableEntries(rows: readonly EventRow[], from: IngestState, threadId: string, facts: ThreadFacts, { final = false, advance = -Infinity } = {}) {
  const state: IngestState = structuredClone(from);
  const runs = new Runs();
  let park: number | null = null;
  const read = from.through ?? -Infinity;
  delete state.through;
  state.buffered ??= [];
  for (const row of rows) {
    if (row.type === "client/turn/requested") { if (row.seq > read) state.pending.push(row); continue; }
    if (row.type === "turn/input/accepted") {
      state.modern = true;
      runs.push(...state.buffered.flatMap(r => eventEntries(r, threadId, facts)));
      state.buffered = [];
      const id = row.data?.clientRequestId;
      const request = state.pending.find(r => r.data?.requestId === id);
      const originalId = request?.data?.retryOfRequestId;
      const original = originalId ? [...state.pending, ...(state.unsent ?? [])].find(r => r.data?.requestId === originalId) : null;
      if (original ?? request) runs.push(...eventEntries((original ?? request)!, threadId, facts).map(e => ({...e, requestId: id})));
      state.pending = state.pending.filter(r => r.data?.requestId !== id && (!original || r.data?.requestId !== originalId));
      if (original) state.unsent = state.unsent?.filter(r => r.data?.requestId !== originalId);
      runs.close();
    } else if (row.type === "client/turn/rejected") {
      const id = row.data?.requestId ?? row.data?.clientRequestId;
      state.pending = state.pending.filter(r => r.data?.requestId !== id);
    } else if (row.type === "provider/error" && String(row.data?.detail ?? "").includes(UNAVAILABLE)) {
      if (!state.modern) state.buffered.push(row);
    } else if (row.type === "turn/completed") {
      // Historical providers without acceptance events are recoverable at terminal boundaries.
      // Modern providers keep queued requests pending across somebody else's completed turn.
      if (!state.modern) {
        const unsent = row.data?.status === "failed"
          && state.buffered.some(r => r.type === "provider/error" && String(r.data?.detail ?? "").includes(UNAVAILABLE))
          && !state.buffered.some(r => eventEntries(r, threadId, facts).length);
        if (unsent) (state.unsent ??= []).push(...state.pending);
        runs.push(...turnLog([...state.pending, ...state.buffered, row].sort((a,b) => a.seq-b.seq), threadId, facts));
        state.pending = [];
        state.buffered = [];
      }
      if (state.modern) runs.push(...eventEntries(row, threadId, facts));
      runs.close();
    } else if (!state.modern) state.buffered.push(row);
    else {
      const first = runs.open[0];
      runs.push(...eventEntries(row, threadId, facts));
      // This row opened a new group: the cursor would park before it.
      if (runs.open[0] && runs.open[0] !== first) park = row.seq - 1;
    }
    if (!runs.open.length) park = null;
  }
  const parked = park !== null && !final && park > advance ? park : null;
  if (parked === null) runs.close();
  else state.through = rows.at(-1)!.seq;
  // Append in processing/acceptance order. seq is canonical provenance, so a queued input or
  // retry may point backward; sorting by it would move that input ahead of already acted-on output.
  return { entries: runs.out.flatMap(splitEntry), state, parked };
}
