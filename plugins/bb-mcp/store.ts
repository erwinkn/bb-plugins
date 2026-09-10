import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ToolError } from "./config";

export type Operation = {
  id: string; keyHash: string; payloadHash: string; kind: "create" | "send" | "handoff";
  projectId: string; hostId: string; threadId: string | null;
  related?: { threadId: string; projectId: string; hostId: string }[];
  state: "pending" | "accepted" | "outcome_unknown";
  createdAt: number; updatedAt: number; response: Record<string, unknown> | null;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

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
  const inflight = new Map<string, Promise<Operation>>();
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  function claim(input: Omit<Operation, "id" | "state" | "createdAt" | "updatedAt" | "response" | "payloadHash" | "keyHash">, key: string, payload: unknown, maxPending: number, createsPerHour: number) {
    return db.transaction(() => {
      if (disposed) throw new ToolError("unavailable", "Plugin is reloading; retry with the same idempotency key.");
      const keyHash = hash(key), payloadHash = hash(canonical({ kind: input.kind, payload }));
      const existing = getBy("key_hash", keyHash);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new ToolError("idempotency_conflict", "This idempotency key was already used with different arguments.");
        return { op: existing, fresh: false };
      }
      const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
      if (count("SELECT count(*) n FROM operations") >= 10000)
        throw new ToolError("operation_storage_full", "Operation history is full. Export and reconcile it in BB before accepting new requests.");
      if (count("SELECT count(*) n FROM operations WHERE json_extract(body, '$.state') = 'pending'") >= maxPending)
        throw new ToolError("capacity_limited", "Too many requests are dispatching. Retry later with the same key.");
      if (input.kind !== "send" && count("SELECT count(*) n FROM operations WHERE json_extract(body, '$.kind') IN ('create', 'handoff') AND json_extract(body, '$.createdAt') > ?", Date.now() - 3600000) >= createsPerHour)
        throw new ToolError("rate_limited", "The configured hourly new-thread limit has been reached.");
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
        const resolved: Operation = { ...op, state: "accepted", threadId, updatedAt: Date.now(), response: { threadId, reconciliation: "operator_confirmed" } };
        save(resolved); return resolved;
      })();
    },
    find(key: string, kind: Operation["kind"], payload: unknown) {
      const op = getBy("key_hash", hash(key));
      if (op && op.payloadHash !== hash(canonical({ kind, payload }))) throw new ToolError("idempotency_conflict", "This idempotency key was already used with different arguments.");
      return op;
    },
    forThread: (threadId: string) => {
      const row = db.prepare("SELECT body FROM operations WHERE json_extract(body, '$.threadId') = ? ORDER BY rowid DESC LIMIT 1").get(threadId) as { body: string } | undefined;
      return row ? JSON.parse(row.body) as Operation : undefined;
    },
    list: () => (db.prepare("SELECT body FROM operations ORDER BY rowid DESC LIMIT 50").all() as {body: string}[]).map(r => JSON.parse(r.body) as Operation),
    async run(input: Parameters<typeof claim>[0], key: string, payload: unknown, maxPending: number, createsPerHour: number, dispatch: () => Promise<Record<string, unknown>>): Promise<Operation> {
      const { op, fresh } = claim(input, key, payload, maxPending, createsPerHour);
      if (!fresh) return inflight.get(op.id) ?? op;
      // Defer dispatch so the promise is registered before concurrent callers join.
      const pending = Promise.resolve().then(async () => {
        try {
          if (disposed) throw new Error("disposed");
          const response = await dispatch();
          const accepted: Operation = { ...op, state: "accepted", response, threadId: typeof response.threadId === "string" ? response.threadId : op.threadId, updatedAt: Date.now() };
          if (!disposed) save(accepted);
          return disposed ? { ...op, state: "outcome_unknown" as const } : accepted;
        } catch {
          // A rejected SDK promise does not establish whether the server committed.
          const unknown: Operation = { ...op, state: "outcome_unknown", updatedAt: Date.now() };
          if (!disposed) save(unknown);
          return unknown;
        } finally { inflight.delete(op.id); }
      });
      inflight.set(op.id, pending);
      return pending;
    },
  };
}
export type Store = ReturnType<typeof createStore>;
export function operationView(op: Operation) {
  const { keyHash: _key, payloadHash: _payload, ...view } = op;
  return { ...view, ...(op.state === "outcome_unknown" ? { recovery: "BB may have accepted this request. Inspect the target thread or recent BB threads; do not dispatch again with a new key until reconciled." } : {}) };
}
