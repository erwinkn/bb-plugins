import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ToolError } from "./config";

export type Operation = {
  id: string; keyHash: string; payloadHash: string; kind: string;
  /** The SDK call path that produced this receipt (ops.run only). */
  call?: string;
  projectId: string | null; hostId: string | null; threadId: string | null;
  related?: { threadId: string; projectId: string; hostId: string | null }[];
  state: "pending" | "accepted" | "failed" | "outcome_unknown";
  createdAt: number; updatedAt: number; response: Record<string, unknown> | null;
  error?: { code: string; message: string };
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof ArrayBuffer) return `ab:${createHash("sha256").update(Buffer.from(value)).digest("hex")}`;
  if (ArrayBuffer.isView(value)) return `ab:${createHash("sha256").update(Buffer.from(value.buffer, value.byteOffset, value.byteLength)).digest("hex")}`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (value instanceof Map) return `map:{${[...value.entries()].map(([k, v]) => `${canonical(k)}=>${canonical(v)}`).sort().join(",")}}`;
  if (value instanceof Set) return `set:[${[...value.values()].map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// A rejection is only "unknown" when the server may have committed — timeouts,
// disconnects, 5xx. ToolErrors are raised pre-dispatch, and HTTP 4xx is a
// definitive server-side rejection: record "failed" and let the key retry.
// The runtime's HTTP errors expose status/statusCode and an "HTTP <code>:"
// message prefix; accept all three shapes.
function isDefinitive(error: unknown): boolean {
  if (error instanceof ToolError) return true;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : e?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) return true;
  return typeof e?.message === "string" && /^HTTP 4\d\d\b/.test(e.message);
}

export function createStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE operations (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL)",
    "CREATE INDEX operations_created ON operations (json_extract(body, '$.createdAt'))",
  ]);
  const getBy = (column: "id" | "key_hash", value: string): Operation | undefined => {
    const row = db.prepare(`SELECT body FROM operations WHERE ${column} = ?`).get(value) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  };
  const save = (op: Operation) => db.prepare("UPDATE operations SET body = ? WHERE id = ?").run(JSON.stringify(op), op.id);
  // A previous generation may have dispatched but not recorded its result.
  db.prepare("UPDATE operations SET body = json_set(body, '$.state', 'outcome_unknown', '$.updatedAt', ?) WHERE json_extract(body, '$.state') = 'pending'").run(Date.now());
  // Receipts written before the call path was recorded cannot prove their
  // response is credential-free — null it out; state/id/threadId are
  // preserved, and reconciled rows carry call: "reconciled" so the strip
  // does not erase the operator-confirmed marker on the next load.
  db.prepare("UPDATE operations SET body = json_set(body, '$.response', json('null')) WHERE json_extract(body, '$.call') IS NULL AND json_extract(body, '$.response') IS NOT NULL").run();
  const inflight = new Map<string, Promise<Operation>>();
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  function claim(input: Omit<Operation, "id" | "state" | "createdAt" | "updatedAt" | "response" | "payloadHash" | "keyHash">, key: string | undefined, payload: unknown) {
    return db.transaction(() => {
      if (disposed) throw new ToolError("unavailable", "Plugin is reloading; retry with the same idempotency key.");
      let keyHash: string, payloadHash: string;
      try {
        keyHash = hash(key ?? randomUUID());
        payloadHash = hash(canonical(payload));
      } catch {
        throw new ToolError("invalid_arguments", "Payload contains a value that cannot be fingerprinted (BigInt, circular structure, or host object).");
      }
      const existing = getBy("key_hash", keyHash);
      if (existing && existing.state !== "failed") {
        // Receipts written before scope joined the fingerprint hashed
        // { kind, payload: {call, args} }. Accept them on identical call+args,
        // unless a supplied scope contradicts the stored receipt.
        const p = payload as { call?: unknown; args?: unknown; threadId?: unknown; projectId?: unknown } | null;
        const legacy = hash(canonical({ kind: existing.kind, payload: { call: p?.call, args: p?.args } }));
        const scoped = (typeof p?.threadId === "string" && p.threadId !== existing.threadId)
          || (typeof p?.projectId === "string" && p.projectId !== existing.projectId);
        if ((existing.payloadHash !== payloadHash && existing.payloadHash !== legacy) || (existing.payloadHash === legacy && scoped))
          throw new ToolError("idempotency_conflict", "This idempotency key was already used with different arguments.");
        return { op: existing, fresh: false };
      }
      if (existing) {
        // A failed attempt committed nothing: the key is free to retry, even
        // with corrected arguments. Keep the op id stable across attempts.
        const op: Operation = { ...input, id: existing.id, keyHash, payloadHash, state: "pending", createdAt: existing.createdAt, updatedAt: Date.now(), response: null, error: undefined };
        save(op);
        return { op, fresh: true };
      }
      const op: Operation = { ...input, id: `op_${randomUUID()}`, keyHash, payloadHash, state: "pending", createdAt: Date.now(), updatedAt: Date.now(), response: null };
      db.prepare("INSERT INTO operations (id, key_hash, body) VALUES (?, ?, ?)").run(op.id, keyHash, JSON.stringify(op));
      return { op, fresh: true };
    })();
  }
  return {
    get: (id: string) => getBy("id", id),
    reconcile(id: string, threadId: string) {
      return db.transaction(() => {
        const op = getBy("id", id);
        if (!op || op.state !== "outcome_unknown") throw new ToolError("conflict", "Only an outcome_unknown operation can be reconciled.");
        const resolved: Operation = { ...op, call: op.call ?? "reconciled", state: "accepted", threadId, updatedAt: Date.now(), response: { threadId, reconciliation: "operator_confirmed" } };
        save(resolved); return resolved;
      })();
    },
    list: () => (db.prepare("SELECT body FROM operations ORDER BY rowid DESC").all() as {body: string}[]).map(r => JSON.parse(r.body) as Operation),
    async run(input: Parameters<typeof claim>[0], key: string | undefined, payload: unknown, dispatch: () => Promise<Record<string, unknown>>): Promise<Operation> {
      const { op, fresh } = claim(input, key, payload);
      if (!fresh) return inflight.get(op.id) ?? op;
      // Defer dispatch so the promise is registered before concurrent callers join.
      const pending = Promise.resolve().then(async () => {
        try {
          if (disposed) throw new Error("disposed");
          const response = await dispatch();
          const accepted: Operation = { ...op, state: "accepted", response, threadId: typeof response.threadId === "string" ? response.threadId : op.threadId, updatedAt: Date.now() };
          if (!disposed) save(accepted);
          return disposed ? { ...op, state: "outcome_unknown" as const } : accepted;
        } catch (error) {
          const settled: Operation = { ...op, state: isDefinitive(error) ? "failed" : "outcome_unknown", updatedAt: Date.now(), error: errorView(error) };
          if (!disposed) save(settled);
          return settled;
        } finally { inflight.delete(op.id); }
      });
      inflight.set(op.id, pending);
      return pending;
    },
  };
}
export type Store = ReturnType<typeof createStore>;
export function errorView(error: unknown) {
  return { code: error instanceof ToolError ? error.code : "bb_error", message: error instanceof Error ? error.message : String(error) };
}
export function operationView(op: Operation) {
  const { keyHash: _key, payloadHash: _payload, ...view } = op;
  return {
    ...view,
    ...(op.state === "outcome_unknown" ? { recovery: "BB may have accepted this request. Inspect the target thread or recent BB threads; do not dispatch again with a new key until reconciled." } : {}),
    ...(op.state === "failed" ? { recovery: "BB definitively rejected this request — it did not commit. Retry under the same key with corrected arguments." } : {}),
  };
}
