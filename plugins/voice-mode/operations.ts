import { createHash, randomUUID } from "node:crypto";
import { LiveStore, type OperationRow, type OperationStatus } from "./live-store.ts";
import type { ThreadHandoff } from "./thread-management.ts";

export interface Utterance { id: string; version: number; text: string; startedAt: number }
export interface EffectInput {
  nonce: string; conversationId: string; utterance: Utterance | null;
  responseOrigin: "user" | "background"; tool: string; args: unknown; occurrence: number;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export class Operations {
  constructor(readonly store: LiveStore) {}
  get(id: string) { return this.store.db.prepare("SELECT * FROM voice_operations WHERE id = ?").get(id) as OperationRow | undefined; }
  receipt(row: OperationRow): Record<string, unknown> { return JSON.parse(row.receipt_json); }
  begin(input: EffectInput) {
    if (!input.utterance) throw new Error("Not authorized: an effect needs a user utterance");
    const utterance = input.utterance;
    return this.store.db.transaction(() => {
      const existing = this.store.db.prepare(`SELECT * FROM voice_operations WHERE conversation_id = ? AND utterance_id = ?
        AND utterance_version = ? AND tool = ? AND args_hash = ? AND occurrence = ?`).get(input.conversationId, utterance.id, utterance.version, input.tool, hash(input.args), input.occurrence) as OperationRow | undefined;
      const textRow = this.store.db.prepare("SELECT utterance_text FROM voice_operations WHERE conversation_id = ? AND utterance_id = ? AND utterance_version = ? AND utterance_text IS NOT NULL").get(input.conversationId, utterance.id, utterance.version) as { utterance_text: string } | undefined;
      if (textRow && textRow.utterance_text !== utterance.text) throw new Error("Not authorized: utterance text changed without a new version");
      if (existing) return { row: existing, execute: false, text: textRow!.utterance_text };
      const id = randomUUID(), at = this.store.now();
      this.store.db.prepare(`INSERT INTO voice_operations (id, conversation_id, call_nonce, utterance_id, utterance_version, utterance_text,
        response_origin, tool, args_json, args_hash, occurrence, status, receipt_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`).run(id, input.conversationId, input.nonce, utterance.id, utterance.version,
        textRow ? null : utterance.text, input.responseOrigin, input.tool, canonical(input.args), hash(input.args), input.occurrence,
        JSON.stringify({ operationId: id, status: "accepted", asOf: at }), at, at);
      return { row: this.get(id)!, execute: true, text: textRow?.utterance_text ?? utterance.text };
    })();
  }
  finish(id: string, status: OperationStatus, data: Record<string, unknown> = {}) {
    const receipt = { ...this.receipt(this.get(id)!), ...data, operationId: id, status, asOf: this.store.now() };
    this.store.db.prepare("UPDATE voice_operations SET status = ?, receipt_json = ?, updated_at = ? WHERE id = ?").run(status, JSON.stringify(receipt), this.store.now(), id);
    return receipt;
  }
  forThread(conversationId: string, threadId: string) {
    return (this.store.db.prepare("SELECT * FROM voice_operations WHERE conversation_id = ? AND target_thread_id = ? ORDER BY created_at DESC LIMIT 30").all(conversationId, threadId) as OperationRow[]).map(row => this.receipt(row));
  }
  /** Handoff provenance outlives a call and remains available after later messages. */
  handoffForThread(threadId: string): ThreadHandoff | null {
    const row = this.store.db.prepare("SELECT receipt_json FROM voice_operations WHERE tool = 'create_thread' AND target_thread_id = ? AND json_type(receipt_json, '$.handoff') = 'object' ORDER BY created_at DESC LIMIT 1").get(threadId) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json).handoff : null;
  }
  recover() {
    for (const row of this.store.db.prepare("SELECT * FROM voice_operations WHERE status IN ('accepted','running') AND tool IN ('prepare_draft','control_ui') OR status = 'accepted'").all() as OperationRow[])
      this.finish(row.id, "unknown", { error: "Runtime restarted before the result was recorded. Do not repeat this effect." });
  }
}
