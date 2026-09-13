import { documentSchema, type Note, type NoteDocument, type WriteResult } from "./model";

type Draft = { baseRevision: number; document: NoteDocument };
export interface DraftStorage { read(): Draft | null; write(draft: Draft | null): void }
export interface SessionState {
  note: Note; document: NoteDocument; dirty: boolean; saving: boolean;
  conflict: Note | null; error: string | null; storageWarning: boolean; editorEpoch: number;
}
const equal = (a: NoteDocument, b: NoteDocument) => JSON.stringify(a) === JSON.stringify(b);

/** Owns the save queue separately from the editor. In-flight responses must
 * never replace newer typing, and a stale base must never overwrite a peer. */
export class NoteSession {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  constructor(note: Note, private save: (revision: number, document: NoteDocument) => Promise<WriteResult>, private storage: DraftStorage) {
    this.state = { note, document: note.document, dirty: false, saving: false, conflict: null, error: null, storageWarning: false, editorEpoch: 0 };
    try {
      const draft = storage.read();
      if (draft && !equal(draft.document, note.document)) {
        this.state.document = documentSchema.parse(draft.document); this.state.dirty = true;
        if (draft.baseRevision !== note.revision) this.state.conflict = note;
      } else storage.write(null);
    } catch { this.state.storageWarning = true; }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private persist() {
    try { this.storage.write(this.state.dirty ? { baseRevision: this.state.note.revision, document: this.state.document } : null); }
    catch { this.update({ storageWarning: true }); }
  }
  change(document: NoteDocument) {
    // BlockNote includes undefined optional table fields. BB's RPC accepts
    // strict JSON only, so omit those fields before keeping the save snapshot.
    const parsed = documentSchema.safeParse(JSON.parse(JSON.stringify(document)));
    if (!parsed.success) { this.update({ error: parsed.error.issues[0]?.message || "Unable to save this document." }); return; }
    this.update({ document: parsed.data, dirty: !equal(parsed.data, this.state.note.document), error: null });
    this.persist(); this.schedule();
  }
  schedule() { clearTimeout(this.timer); if (!this.disposed) this.timer = setTimeout(() => { void this.flush(); }, 650); }
  receive(note: Note) {
    if (this.state.saving || note.revision <= Math.max(this.state.note.revision, this.state.conflict?.revision ?? -1)) return;
    if (this.state.dirty && !equal(this.state.document, note.document)) this.update({ conflict: note });
    else {
      this.update({ note, document: note.document, dirty: false, conflict: null, error: null, editorEpoch: this.state.editorEpoch + 1 });
      this.persist();
    }
  }
  report(error: unknown) { this.update({ error: error instanceof Error ? error.message : String(error) }); }
  flush = (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.inFlight) return this.inFlight;
    if (!this.state.dirty || this.state.conflict) return Promise.resolve();
    const submitted = this.state.document;
    const base = this.state.note.revision;
    this.update({ saving: true, error: null });
    this.inFlight = this.save(base, submitted).then((result) => {
      if (!result.ok) { this.update({ conflict: result.note }); return; }
      this.update({ note: result.note, dirty: !equal(this.state.document, submitted) });
      this.persist();
    }).catch((error) => this.report(error)).finally(() => {
      this.inFlight = null; this.update({ saving: false });
      if (this.state.dirty && !this.state.conflict && !this.state.error) this.schedule();
    });
    return this.inFlight;
  };
  /** The caller confirms replacement after inspecting the conflict. CAS still
   * applies: if another edit arrived meanwhile this produces another conflict. */
  keepDraft = () => {
    if (!this.state.conflict) return;
    this.update({ note: this.state.conflict, conflict: null, dirty: true, error: null });
    this.persist(); void this.flush();
  };
  useLatest = () => {
    const note = this.state.conflict;
    if (!note) return;
    this.update({ note, document: note.document, dirty: false, conflict: null, error: null, editorEpoch: this.state.editorEpoch + 1 });
    this.persist();
  };
  dispose() { this.disposed = true; clearTimeout(this.timer); this.persist(); this.listeners.clear(); }
}
