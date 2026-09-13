import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteSession, type DraftStorage } from "./session";
import { emptyDocument, type Note, type NoteDocument, type WriteResult } from "./model";
const document = (text: string) => { const doc = emptyDocument("env_one"); doc[0].content = [{ type: "text", text, styles: {} }]; return doc; };
const note = (revision: number, text: string): Note => ({ environmentId: "env_one", revision, document: document(text), updatedAt: revision, author: "You", schemaVersion: 1 });
function storage() {
  let value: { baseRevision: number; document: NoteDocument } | null = null;
  return { read: () => value, write: (draft) => { value = draft; } } satisfies DraftStorage;
}
test("typing during an in-flight save is retained and saved against the acknowledged revision", async () => {
  const calls: number[] = []; let complete!: (value: WriteResult) => void;
  const session = new NoteSession(note(0, ""), (revision) => { calls.push(revision); return new Promise((resolve) => { complete = resolve; }); }, storage());
  session.change(document("first")); const saving = session.flush();
  session.change(document("second")); complete({ ok: true, note: note(1, "first") }); await saving;
  assert.equal(session.getSnapshot().dirty, true); assert.deepEqual(session.getSnapshot().document, document("second"));
  const next = session.flush(); complete({ ok: true, note: note(2, "second") }); await next;
  assert.deepEqual(calls, [0, 1]); assert.equal(session.getSnapshot().dirty, false); session.dispose();
});
test("a conflicting save preserves the local draft until explicitly resolved", async () => {
  const persisted = storage();
  const session = new NoteSession(note(0, ""), async () => ({ ok: false, note: note(1, "agent") }), persisted);
  session.change(document("mine")); await session.flush();
  assert.deepEqual(session.getSnapshot().document, document("mine")); assert.equal(session.getSnapshot().conflict?.revision, 1);
  assert.deepEqual(persisted.read()?.document, document("mine"));
  session.useLatest(); assert.deepEqual(session.getSnapshot().document, document("agent")); assert.equal(persisted.read(), null); session.dispose();
});
test("a draft recovered against a changed base cannot autosave over the latest revision", async () => {
  const persisted = storage(); persisted.write({ baseRevision: 0, document: document("mine") });
  let saves = 0;
  const session = new NoteSession(note(1, "agent"), async () => { saves++; return { ok: true, note: note(2, "mine") }; }, persisted);
  await session.flush(); assert.equal(saves, 0); assert.equal(session.getSnapshot().conflict?.revision, 1); session.dispose();
});
test("network failure retains a recoverable draft, retry succeeds", async () => {
  let fail = true; const persisted = storage();
  const session = new NoteSession(note(0, ""), async () => { if (fail) throw new Error("Offline"); return { ok: true, note: note(1, "mine") }; }, persisted);
  session.change(document("mine")); await session.flush();
  assert.equal(session.getSnapshot().dirty, true); assert.equal(session.getSnapshot().error, "Offline"); assert.ok(persisted.read());
  fail = false; await session.flush(); assert.equal(session.getSnapshot().dirty, false); assert.equal(persisted.read(), null); session.dispose();
});
test("a clean editor receives peer updates, a dirty editor receives a conflict", () => {
  const session = new NoteSession(note(0, ""), async () => ({ ok: true, note: note(1, "") }), storage());
  session.receive(note(1, "agent")); assert.deepEqual(session.getSnapshot().document, document("agent"));
  session.change(document("mine")); session.receive(note(2, "new agent")); assert.deepEqual(session.getSnapshot().document, document("mine")); assert.equal(session.getSnapshot().conflict?.revision, 2);
  session.receive(note(1, "old")); assert.equal(session.getSnapshot().conflict?.revision, 2); session.dispose();
});
test("BlockNote's optional table fields become strict JSON before reaching BB RPC", async () => {
  let submitted: NoteDocument | undefined;
  const session = new NoteSession(note(0, ""), async (_revision, document) => {
    submitted = document;
    assert.deepEqual(document, JSON.parse(JSON.stringify(document)), "RPC input must have no undefined values");
    return { ok: true, note: { ...note(1, ""), document } };
  }, storage());
  const table: NoteDocument = [{ id: "table", type: "table", props: {}, children: [], content: {
    type: "tableContent", headerCols: undefined, headerRows: 1,
    columnWidths: [null, null], rows: [{ cells: [[], []] }],
  } }];
  session.change(table); await session.flush();
  assert.ok(submitted); assert.equal(session.getSnapshot().error, null); assert.equal(session.getSnapshot().dirty, false); session.dispose();
});
