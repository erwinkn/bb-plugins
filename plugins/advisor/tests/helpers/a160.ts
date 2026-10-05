// Shared raw inputs for the ported A160 reference cases. Inputs are the same
// raw text as the accepted fixtures (A160 fixtures/check.py): unified diffs
// produced by Python difflib (exported verbatim to difflib-patches.json, keyed
// by sha256 of path, base, current and context), BB-shaped event rows,
// installed-contract Projects and thread shapes, and the A141 probe inputs.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type { EventQuery, EventRow, EventSource } from "../../src/rules/events.js";

// Resolved from the package root (vitest's cwd): under jsdom, import.meta.url is not a file URL.
const DIR = `${process.cwd()}/tests/fixtures/a160/`;

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(DIR + name, "utf8")) as T;
}

let patches: Record<string, string> | null = null;

/** Python difflib.unified_diff(..., n) without the two file headers, exactly as the reference model made it. */
export function makePatch(path: string, base: string, cur: string, n = 3): string {
  patches ??= fixture<Record<string, string>>("difflib-patches.json");
  const key = createHash("sha256").update(`${path}\0${base}\0${cur}\0${n}`, "utf8").digest("hex");
  const out = patches[key];
  if (out === undefined) throw new Error(`no exported difflib patch for ${path} (n=${n}); re-export from the reference`);
  return out;
}

export const ROOT = "/home/exedev/Code/bb-plugins";

export function reqRow(seq: number, rid: string, text: string, sender: string | null = null, initiator?: string): EventRow {
  return {
    seq,
    type: "client/turn/requested",
    data: {
      requestId: rid,
      senderThreadId: sender,
      initiator: initiator ?? (sender ? "agent" : "user"),
      input: [{ type: "text", text }],
    },
  };
}

export function accRow(seq: number, rid: string): EventRow {
  return { seq, type: "turn/input/accepted", data: { clientRequestId: rid } };
}

export function rejRow(seq: number, rid: string): EventRow {
  return { seq, type: "client/turn/rejected", data: { requestId: rid } };
}

export function ownRow(seq: number, prev: string | null, next: string | null, md?: Record<string, unknown>): EventRow {
  return {
    seq,
    type: "system/operation",
    data: {
      operation: "ownership_change",
      operationId: `op${seq}`,
      status: "completed",
      message: "m",
      metadata: md ?? { action: "transfer", previousParentThreadId: prev, nextParentThreadId: next },
    },
  };
}

export function opRow(seq: number, operation = "compaction"): EventRow {
  return { seq, type: "system/operation", data: { operation, operationId: `op${seq}`, status: "completed", message: "m" } };
}

export const THREAD_EVENT_TYPES = new Set([
  "client/thread/start", "client/turn/rejected", "client/turn/requested", "client/turn/start", "item/agentMessage/delta",
  "item/backgroundTask/completed", "item/backgroundTask/progress", "item/commandExecution/outputDelta", "item/completed",
  "item/delegation/completed", "item/delegation/progress", "item/fileChange/outputDelta", "item/mcpToolCall/progress",
  "item/plan/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/started", "item/toolCall/progress",
  "provider.env-resolved", "provider/error", "provider/modelFallback", "provider/rateLimits/updated", "provider/unhandled",
  "provider/warning", "system/error", "system/interaction/lifecycle", "system/manager/user_message", "system/operation",
  "system/permissionGrant/lifecycle", "system/provider-turn-watchdog", "system/thread-provisioning", "system/thread/interrupted",
  "system/userQuestion/lifecycle", "thread/compacted", "thread/context/cleared", "thread/contextWindowUsage/updated",
  "thread/extensionState/updated", "thread/goal/cleared", "thread/goal/updated", "thread/identity", "thread/name/updated",
  "thread/started", "thread/tokenUsage/updated", "turn/completed", "turn/diff/updated", "turn/input/accepted", "turn/plan/updated",
  "turn/started",
]); // SDK 0.4.87 ThreadEventType (d.ts:280)

export class EventReadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const DIGITS = /^\d+$/u;
const EVENT_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * GET /threads/:id/events as installed (BB 0.43.1): digit-string cursors and
 * limit, limit 1..100 (default 100), strict afterSeq/beforeSeq, a types filter,
 * a bare row array, 413 over 8 MiB. Every issued query is logged.
 */
export class NativeEvents implements EventSource {
  rows: EventRow[];
  log: EventQuery[] = [];
  constructor(
    rows: EventRow[],
    private misbehave?: (args: EventQuery, page: EventRow[]) => EventRow[] | Promise<EventRow[]>,
    private responseBytes = EVENT_RESPONSE_BYTES,
  ) {
    this.rows = [...rows].sort((a, b) => a.seq - b.seq);
  }

  listSync(args: EventQuery): EventRow[] {
    for (const k of ["afterSeq", "beforeSeq", "limit"] as const) {
      const v = args[k];
      if (v !== undefined && !(typeof v === "string" && DIGITS.test(v))) throw new EventReadError(400, `${k} must be a digit string`);
    }
    if (args.limit !== undefined && Number(args.limit) > 100) throw new EventReadError(400, "Thread event limit cannot exceed 100");
    const limit = Math.min(Number(args.limit ?? 100), 100);
    if (limit <= 0) throw new EventReadError(400, "limit must be a positive integer");
    const order = args.order ?? "asc";
    const types = args.types;
    if (types !== undefined && (types.length === 0 || types.some((t) => !THREAD_EVENT_TYPES.has(t)))) {
      throw new EventReadError(400, "Invalid thread event types");
    }
    const sel = this.rows.filter(
      (r) =>
        (args.afterSeq === undefined || r.seq > Number(args.afterSeq)) &&
        (args.beforeSeq === undefined || r.seq < Number(args.beforeSeq)) &&
        (types === undefined || types.includes(r.type)),
    );
    const page = (order === "desc" ? [...sel].reverse() : sel).slice(0, limit);
    if (pyJsonBytes(page) > this.responseBytes) {
      throw new EventReadError(413, "Event response exceeds the 8 MiB limit");
    }
    return page;
  }

  async list(args: EventQuery): Promise<EventRow[]> {
    this.log.push({ ...args });
    // Opt-in: record every issued query so the installed BB schema can re-check them offline.
    if (process.env.ADVISOR_DUMP_QUERIES) appendFileSync(process.env.ADVISOR_DUMP_QUERIES, JSON.stringify(args) + "\n");
    const page = this.listSync(args);
    return this.misbehave ? await this.misbehave(args, page) : page;
  }
}


/** Bytes of Python's json.dumps(v): ", " and ": " separators, non-ASCII escaped (the reference fake's 413 measure). */
export function pyJsonBytes(v: unknown): number {
  const dump = (x: unknown): string => {
    if (Array.isArray(x)) return "[" + x.map(dump).join(", ") + "]";
    if (x && typeof x === "object") {
      return "{" + Object.entries(x).map(([k, val]) => dump(k) + ": " + dump(val)).join(", ") + "}";
    }
    if (typeof x === "string") return JSON.stringify(x).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return JSON.stringify(x ?? null);
  };
  return Buffer.byteLength(dump(v), "utf8");
}
