import { bytes } from "./tree";

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
}
export type LogEntry = Omit<MemoryMessage, "i" | "size">;

/** Tool output keeps its head and tail, 30,000 characters in all; other long text is split. */
export const CLIP = 30_000;
const SPLIT = 30_000;

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
export const LOG_EVENT_TYPES = ["client/turn/requested", "item/completed", "provider/unhandled", "turn/completed"] as const;
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
const json = (value: unknown) => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value));
const toolName = (name: unknown) => String(name ?? "tool").replace(/^mcp__bb-bridge__/, "");

/** One BB event of a thread as log entries (a tool call is a tool entry and an echo entry), or none. */
export function eventEntries(row: EventRow, threadId: string, facts: ThreadFacts): LogEntry[] {
  const base = { at: timeOf(row), threadId, seq: row.seq };
  const entry = (kind: MemoryKind, text: string): LogEntry[] => (text.trim() ? [{ ...base, kind, text: text.trim() }] : []);
  const d = row.data ?? {};
  if (row.type === "client/turn/requested") {
    const text = inputText(d.input).trim();
    // A retry re-submits a request that is logged already.
    if (!text || d.retryOfRequestId) return [];
    if (d.initiator === "agent") {
      const sender = typeof d.senderThreadId === "string" ? facts.sender(d.senderThreadId) : "thread";
      return entry("work", `[${sender}] ${text.replace(/^\[bb message from thread:\S+\]\s*/, "")}`);
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
      return [
        ...entry("tool", `${toolName(item.tool)} ${json(item.arguments ?? {})}`),
        ...entry("echo", clip([json(item.result), item.error ? `error: ${json(item.error)}` : ""].filter(Boolean).join("\n"))),
      ];
    case "commandExecution":
      return [
        ...entry("tool", `Bash ${String(item.command ?? "")}`),
        ...entry("echo", clip(`${item.exitCode != null ? `exit ${item.exitCode}\n` : ""}${String(item.aggregatedOutput ?? "")}`)),
      ];
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return [
        ...entry("tool", `Edit ${changes.map((c: { kind?: string; path?: string }) => `${c.kind ?? "change"} ${c.path ?? "?"}`).join(", ")}`),
        ...entry("echo", clip(changes.map((c: { diff?: string }) => c.diff ?? "").join("\n"))),
      ];
    }
    default: {
      const { type, id: _id, status: _status, presentation: _p, ...rest } = item;
      return entry("tool", clip(`${type} ${JSON.stringify(rest)}`));
    }
  }
}
