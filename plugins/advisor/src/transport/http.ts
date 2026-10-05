// One bounded HTTP exchange (A140 §5.4): 30 s to headers, 90 s in total, the
// body read through a 256 KiB cap (16 KiB for errors), all under a
// plugin-owned AbortSignal. Late responses after abort are ignored. A signal
// already aborted when the exchange starts never reaches fetch (A230 #1). An
// event stream keeps only its final events: text deltas are read and dropped,
// under their own total cap (A230 #3).

import type { FetchLike } from "./types.js";

export const HEADERS_DEADLINE_MS = 30_000;
export const TOTAL_DEADLINE_MS = 90_000;
export const BODY_READ_CAP = 256 * 1024;
export const ERROR_READ_CAP = 16 * 1024;

export type Exchange =
  | { kind: "response"; status: number; headers: Headers; text: string; truncated: boolean; why?: string }
  | { kind: "not-sent"; reason: string }
  | { kind: "aborted-before-headers"; reason: string }
  | { kind: "failed-before-headers"; error: string }
  | { kind: "cut-after-headers"; status: number; headers: Headers; reason: string };

export interface Deadlines {
  headersMs: number;
  totalMs: number;
}

function reasonOf(signal: AbortSignal): string {
  const r = signal.reason;
  if (typeof r === "string") return r;
  if (r instanceof Error) return r.message;
  return "aborted";
}

/** Read a successful event stream incrementally: keep only these event types, under a total cap. */
export interface SseRead {
  keep: ReadonlySet<string>;
  totalCap: number;
}

export async function exchange(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  parent: AbortSignal,
  deadlines: Deadlines = { headersMs: HEADERS_DEADLINE_MS, totalMs: TOTAL_DEADLINE_MS },
  sse?: SseRead,
): Promise<Exchange> {
  // Checked after every pre-send wait (secret, Pooler token) and right before fetch: nothing left.
  if (parent.aborted) return { kind: "not-sent", reason: reasonOf(parent) };
  const ctl = new AbortController();
  const onParent = () => ctl.abort(reasonOf(parent));
  if (parent.aborted) onParent();
  else parent.addEventListener("abort", onParent, { once: true });
  const headersTimer = setTimeout(() => ctl.abort("headers-deadline"), deadlines.headersMs);
  const totalTimer = setTimeout(() => ctl.abort("total-deadline"), deadlines.totalMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: ctl.signal });
    } catch (err) {
      if (ctl.signal.aborted) return { kind: "aborted-before-headers", reason: reasonOf(ctl.signal) };
      return { kind: "failed-before-headers", error: err instanceof Error ? err.message : String(err) };
    }
    clearTimeout(headersTimer);
    if (ctl.signal.aborted) {
      void res.body?.cancel().catch(() => {});
      return { kind: "cut-after-headers", status: res.status, headers: res.headers, reason: reasonOf(ctl.signal) };
    }
    const cap = res.ok ? BODY_READ_CAP : ERROR_READ_CAP;
    try {
      const { text, truncated, why } = res.ok && sse ? await readSse(res, sse, BODY_READ_CAP, ctl.signal) : await readCapped(res, cap, ctl.signal);
      if (ctl.signal.aborted) return { kind: "cut-after-headers", status: res.status, headers: res.headers, reason: reasonOf(ctl.signal) };
      return { kind: "response", status: res.status, headers: res.headers, text, truncated, ...(why ? { why } : {}) };
    } catch (err) {
      const reason = ctl.signal.aborted ? reasonOf(ctl.signal) : err instanceof Error ? err.message : String(err);
      return { kind: "cut-after-headers", status: res.status, headers: res.headers, reason };
    }
  } finally {
    clearTimeout(headersTimer);
    clearTimeout(totalTimer);
    parent.removeEventListener("abort", onParent);
  }
}

async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean; why?: string }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error(reasonOf(signal));
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new Error(reasonOf(signal));
      size += value.byteLength;
      if (size > cap) {
        void reader.cancel().catch(() => {});
        chunks.push(value.subarray(0, value.byteLength - (size - cap)));
        return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

/**
 * Server-sent events, one block at a time: blocks of a kept type are retained
 * (at most `retainCap` bytes), everything else is dropped as it arrives. The
 * whole stream is bounded by `totalCap`; an unfinished block is bounded by
 * `retainCap`. Either bound cuts the read.
 */
async function readSse(res: Response, o: SseRead, retainCap: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean; why?: string }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  let pending = "";
  let kept = "";
  let total = 0;
  const cut = (why: string) => {
    void reader.cancel().catch(() => {});
    return { text: kept, truncated: true, why };
  };
  const take = (block: string) => {
    const type = sseType(block);
    if (type !== null && o.keep.has(type)) kept += block + "\n\n";
  };
  try {
    for (;;) {
      if (signal.aborted) throw new Error(reasonOf(signal));
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new Error(reasonOf(signal));
      total += value.byteLength;
      if (total > o.totalCap) return cut(`stream over ${Math.floor(o.totalCap / 1024)} KiB (lunaStreamCapKiB)`);
      pending += decoder.decode(value, { stream: true });
      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = blocks.pop()!;
      for (const b of blocks) take(b);
      if (Buffer.byteLength(kept) > retainCap) return cut(`kept stream events over ${retainCap / 1024} KiB`);
      if (Buffer.byteLength(pending) > retainCap) return cut(`one stream event over ${retainCap / 1024} KiB`);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  pending += decoder.decode();
  if (pending.trim()) take(pending);
  if (Buffer.byteLength(kept) > retainCap) return { text: kept, truncated: true, why: `kept stream events over ${retainCap / 1024} KiB` };
  return { text: kept, truncated: false };
}

/** An event block's type: its `event:` line, else the `type` of its JSON data. */
function sseType(block: string): string | null {
  const lines = block.split(/\r?\n/u);
  const ev = lines.find((l) => l.startsWith("event:"));
  if (ev) return ev.slice(6).trim();
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
  try {
    const t = (JSON.parse(data) as { type?: unknown }).type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

const REJECTED = new Set([400, 401, 403, 404, 413, 422, 429]);

/** Vendor status after a request left (direct-key routes, or Pooler-stamped "sent"). */
export function vendorOutcome(status: number): "rejected" | "ambiguous" | "ok" {
  if (status >= 200 && status < 300) return "ok";
  if (REJECTED.has(status)) return "rejected";
  return "ambiguous";
}

/** BB's own pre-handler rejections on plugin HTTP routes (start-server.js 2265fa22, A154 §6.3). */
const BB_PRE_HANDLER: Array<[number, RegExp]> = [
  [401, /^missing or invalid plugin token/u],
  [404, /^unknown plugin "/u],
  [404, /^plugin "[^"]+" has no [A-Z]+ route for "/u],
  [503, /^plugin "[^"]+" is not running \(status: /u],
  [503, /^plugin "[^"]+" reloaded during the request/u],
];

/**
 * Pooler advisor routes stamp every handler response with
 * x-account-pool-dispatch: none | sent. Unstamped responses are BB's: its only
 * response made after the handler started is the 500, so only exact
 * pre-handler messages prove that nothing was sent.
 */
export function poolProvenance(status: number, headers: Headers, text: string): "none" | "sent" | "bb-pre-handler" | "unknown" {
  const stamp = headers.get("x-account-pool-dispatch");
  if (stamp === "none") return "none";
  if (stamp === "sent") return "sent";
  if (status === 500) return "unknown";
  try {
    const body = JSON.parse(text) as { ok?: unknown; error?: unknown };
    if (body && body.ok === false && typeof body.error === "string") {
      const msg = body.error;
      if (BB_PRE_HANDLER.some(([s, re]) => s === status && re.test(msg))) return "bb-pre-handler";
    }
  } catch {
    // not BB's envelope
  }
  return "unknown";
}
