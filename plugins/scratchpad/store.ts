import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANNEL, HISTORY_LIMIT, documentSchema, emptyDocument, noteSchema, type Note, type NoteDocument, type Scope, type WriteResult } from "./model";

export function createStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE scratchpads (environment_id TEXT PRIMARY KEY, scope TEXT NOT NULL, note TEXT NOT NULL)",
    "CREATE TABLE revisions (environment_id TEXT NOT NULL, revision INTEGER NOT NULL, note TEXT NOT NULL, PRIMARY KEY(environment_id, revision))",
  ]);
  const decode = (row: unknown): Note => {
    if (!row) throw new Error("Scratchpad not found.");
    return noteSchema.parse(JSON.parse((row as { note: string }).note));
  };
  const get = (environmentId: string) => decode(db.prepare("SELECT note FROM scratchpads WHERE environment_id = ?").get(environmentId));
  const open = (scope: Scope) => {
    const note: Note = { environmentId: scope.environmentId, document: emptyDocument(scope.environmentId), revision: 0, updatedAt: Date.now(), author: "Created", schemaVersion: 1 };
    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO scratchpads (environment_id, scope, note) VALUES (?, ?, ?)").run(scope.environmentId, JSON.stringify(scope), JSON.stringify(note));
      db.prepare("UPDATE scratchpads SET scope = ? WHERE environment_id = ?").run(JSON.stringify(scope), scope.environmentId);
      const current = get(scope.environmentId);
      db.prepare("INSERT OR IGNORE INTO revisions VALUES (?, ?, ?)").run(scope.environmentId, current.revision, JSON.stringify(current));
    })();
    return get(scope.environmentId);
  };
  const save = (environmentId: string, expectedRevision: number, document: NoteDocument, author: string): WriteResult => {
    const parsed = documentSchema.parse(document);
    const result = db.transaction((): WriteResult => {
      const current = get(environmentId);
      if (current.revision !== expectedRevision) return { ok: false, note: current };
      if (JSON.stringify(current.document) === JSON.stringify(parsed)) return { ok: true, note: current };
      const next: Note = { ...current, document: parsed, revision: current.revision + 1, updatedAt: Date.now(), author };
      const encoded = JSON.stringify(next);
      db.prepare("UPDATE scratchpads SET note = ? WHERE environment_id = ?").run(encoded, environmentId);
      db.prepare("INSERT INTO revisions VALUES (?, ?, ?)").run(environmentId, next.revision, encoded);
      db.prepare("DELETE FROM revisions WHERE environment_id = ? AND revision < ?").run(environmentId, next.revision - HISTORY_LIMIT + 1);
      return { ok: true, note: next };
    })();
    if (result.ok && result.note.revision !== expectedRevision) bb.realtime.publish(CHANNEL, { environmentId, revision: result.note.revision });
    return result;
  };
  const history = (environmentId: string) => (db.prepare("SELECT note FROM revisions WHERE environment_id = ? ORDER BY revision DESC LIMIT ?").all(environmentId, HISTORY_LIMIT)).map((row) => {
    const { document, ...meta } = decode(row); return meta;
  });
  const version = (environmentId: string, revision: number) => decode(db.prepare("SELECT note FROM revisions WHERE environment_id = ? AND revision = ?").get(environmentId, revision));
  const list = () => (db.prepare("SELECT scope, note FROM scratchpads ORDER BY json_extract(note, '$.updatedAt') DESC LIMIT 100").all() as { scope: string; note: string }[]).map((row) => {
    const { document, ...note } = noteSchema.parse(JSON.parse(row.note));
    return { scope: JSON.parse(row.scope) as Scope, ...note };
  });
  return { get, open, save, history, version, list };
}
