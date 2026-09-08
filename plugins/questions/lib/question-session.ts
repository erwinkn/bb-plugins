import { DraftStore, type DraftTransport, createLocalStorageBackups } from "./draft-store";

// One plugin bundle runs in one BB browser runtime. Thread ids are unique
// there; RPC objects are not, because each mounted slot can have its own.
const sessions = new Map<string, QuestionSession>();

export class QuestionSession {
  readonly store: DraftStore;
  pendingSubmit: { id: string; key: string } | null = null;
  uploadQueue: Promise<void> = Promise.resolve();
  submitting = false;
  private listeners = new Set<() => void>();
  private owners = new Map<object, DraftTransport>();
  private transport: DraftTransport;

  constructor(readonly threadId: string, transport: DraftTransport) {
    this.transport = transport;
    this.store = new DraftStore({ threadId, backups: createLocalStorageBackups(), transport: {
      loadState: () => this.transport.loadState(),
      saveDraft: (...args) => this.transport.saveDraft(...args),
    } });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setSubmitting(value: boolean) {
    this.submitting = value;
    for (const listener of this.listeners) listener();
    if (!value && this.owners.size === 0) this.releaseWhenSettled();
  }

  retain(transport: DraftTransport): () => void {
    const owner = {};
    const first = this.owners.size === 0;
    this.owners.set(owner, transport);
    this.transport = transport;
    sessions.set(this.threadId, this);
    if (first) {
      this.store.activate();
      void this.store.load();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.owners.delete(owner);
      const remaining = this.owners.values().next().value;
      if (remaining) this.transport = remaining;
      else {
        this.store.dispose();
        this.releaseWhenSettled();
      }
    };
  }

  private releaseWhenSettled() {
    // Retain the store while saves/uploads settle, so an immediate reopen
    // joins those operations instead of racing a restored browser backup.
    void this.uploadQueue.then(() => this.store.flush()).catch(() => {
      // The store reports save failures and keeps edits in browser backups.
    }).finally(() => {
      if (this.owners.size === 0 && !this.submitting && !this.pendingSubmit
        && this.store.draftStatus === "saved" && sessions.get(this.threadId) === this) {
        sessions.delete(this.threadId);
      }
    });
  }
}

export function questionSession(threadId: string, transport: DraftTransport): QuestionSession {
  const existing = sessions.get(threadId);
  if (existing) return existing;
  const session = new QuestionSession(threadId, transport);
  sessions.set(threadId, session);
  return session;
}
