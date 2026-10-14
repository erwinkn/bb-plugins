import { useSyncExternalStore } from "react";
import { z } from "zod";
import type { CreatedInitiative } from "./project-mode-contract";

/** A new Initiative as typed in the dialog. */
export interface InitiativeDraft {
  /** The key of the listed submission it edits; null for a new one. */
  key: string | null;
  name: string;
  objective: string;
  /** Selection order; the first one hosts the coordinator. */
  memberProjectIds: string[];
}

export function newDraft(defaultProjectId: string | null): InitiativeDraft {
  return {
    key: null,
    name: "",
    objective: "",
    memberProjectIds: defaultProjectId ? [defaultProjectId] : [],
  };
}

const random = () => Math.random().toString(36).slice(2, 10);

/** Creating an Initiative takes a coordinator spawn; past this it is unconfirmed. */
export const CREATE_TIMEOUT_MS = 90_000;
const CREATE_TIMEOUT_MESSAGE =
  "Initiatives has not confirmed it yet. It may still appear; sending it again unchanged never creates a second one.";
/**
 * How long a key stays good for sending again: Initiatives' WRITE_RECEIPT_MS.
 * Its receipt is deleted a day later, so a later send of the key could run
 * the create a second time.
 */
export const RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;
const EXPIRED_MESSAGE =
  "First sent over 7 days ago without an answer, so sending it again could create a second one. Check whether it exists; if not, send it again.";

const storedSchema = z.object({
  key: z.string(),
  draft: z.object({
    name: z.string(),
    objective: z.string(),
    memberProjectIds: z.array(z.string()),
  }),
  sentAt: z.number(),
  /** Why the key is final, or null while sending it again is safe. */
  settled: z.string().nullable(),
});
type Stored = z.infer<typeof storedSchema>;

/**
 * One send of a draft under one key, from that send until it is created or
 * dismissed. Initiatives keeps a receipt per key, so sending the same draft
 * under the same key again runs it at most once. Once `settled` (a refusal,
 * unknown what an earlier send saved, or the key past RETRY_WINDOW_MS), only
 * sending it again on purpose, under a new key, writes again. `error` says
 * why it is not created yet, or is null while it is being sent.
 */
export type Submission = Stored & { error: string | null };

// Each submission is its own localStorage entry, named by its key, so a
// remount of the list or a reload keeps every unsettled key.
// An entry holds only what a key's answers decide, and each change moves it
// one way: sent, then settled or deleted. So two tabs sending at once write
// two entries, and a tab still holding an older view of an entry has nothing
// to write back that could undo another tab's answer. A send without an
// answer changes nothing durable: only this page shows it. A storage event
// shows this page what another tab changed.
const PREFIX = "bb-plugin-sidebar:initiative-submission:v1:";
/** The entries storage refused to write; only this page holds them. */
const memory = new Map<string, Stored>();
/** This page's sends of an unsettled key that got no answer, by key. */
const unanswered = new Map<string, string>();

const parse = (raw: string) => {
  try {
    return storedSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
};
function loadAll(): Stored[] {
  const all = new Map<string, Stored>();
  try {
    for (const [name, raw] of Object.entries(window.localStorage)) {
      const stored = name.startsWith(PREFIX) && parse(raw);
      if (stored) all.set(stored.key, stored);
    }
  } catch {
    // Unreadable storage: the entries in memory are all there is.
  }
  for (const s of memory.values()) all.set(s.key, s);
  return [...all.values()].sort((a, b) => a.sentAt - b.sentAt);
}
const load = (key: string) => loadAll().find((s) => s.key === key) ?? null;
/** Writes, or with null deletes, the entry of `key`. */
function save(key: string, stored: Stored | null) {
  memory.delete(key);
  if (!stored) unanswered.delete(key);
  try {
    if (stored) window.localStorage.setItem(PREFIX + key, JSON.stringify(stored));
    else window.localStorage.removeItem(PREFIX + key);
  } catch {
    if (stored) memory.set(key, stored);
  }
  publish();
}

interface Snapshot {
  submissions: Submission[];
  /** What the last create said about its coordinator, until dismissed. */
  notice: string | null;
}
let notice: string | null = null;
let snapshot: Snapshot = { submissions: [], notice };
let resumed = false;
const listeners = new Set<() => void>();
function publish() {
  snapshot = {
    submissions: loadAll().map((s) => ({
      ...s,
      error: s.settled ?? unanswered.get(s.key) ?? null,
    })),
    notice,
  };
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") {
  publish();
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(PREFIX)) publish();
  });
}

const EMPTY: Snapshot = { submissions: [], notice: null };
export function useSubmissions(): Snapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => EMPTY,
  );
}

export const dismissNotice = () => {
  notice = null;
  publish();
};
export const dismissSubmission = (key: string) => save(key, null);

export type CreateInitiative = (input: {
  name: string;
  objective: string;
  memberProjectIds: string[];
  key: string;
}) => Promise<CreatedInitiative>;
type OnCreated = (created: CreatedInitiative & { write: "done" }) => void;

const sameContent = (a: Stored["draft"], b: Stored["draft"]) =>
  JSON.stringify([a.name, a.objective, a.memberProjectIds]) ===
  JSON.stringify([b.name, b.objective, b.memberProjectIds]);

const expired = (s: Stored) => Date.now() - s.sentAt >= RETRY_WINDOW_MS;

/**
 * Sends a draft, new or edited from a listed submission. That submission at
 * this moment, not when its dialog opened, decides: the same content under an
 * unsettled key goes again under that key, unless the key is too old, which
 * settles it instead; anything else is a new submission under a new key,
 * which replaces it. A draft whose submission was created or dismissed
 * meanwhile sends nothing.
 */
export function submitDraft(
  { key: listedKey, ...draft }: InitiativeDraft,
  create: CreateInitiative,
  onCreated: OnCreated,
) {
  const listed = listedKey ? load(listedKey) : null;
  if (listedKey && !listed) return;
  let submission: Stored;
  if (listed && !listed.settled && sameContent(listed.draft, draft)) {
    if (expired(listed)) return save(listed.key, { ...listed, settled: EXPIRED_MESSAGE });
    submission = listed;
  } else {
    submission = {
      key: `sidebar-create:${random()}${random()}`,
      draft,
      sentAt: Date.now(),
      settled: null,
    };
    if (listed) save(listed.key, null);
    save(submission.key, submission);
  }
  notice = null;
  follow(submission, create, onCreated);
}

/**
 * Sends a submission's key and follows its write to the end, wherever the
 * list is by then: past CREATE_TIMEOUT_MS it shows as unconfirmed, and a later
 * answer still settles it. `onCreated` hears a success whose submission was
 * still listed.
 */
function follow(
  { key, draft }: Stored,
  create: CreateInitiative,
  onCreated: OnCreated,
) {
  unanswered.delete(key);
  publish();
  // No answer, so its effect is unknown: the key stays for the next send.
  const fail = (error: string) => {
    unanswered.set(key, error);
    publish();
  };
  const timer = setTimeout(() => fail(CREATE_TIMEOUT_MESSAGE), CREATE_TIMEOUT_MS);
  create({ ...draft, key })
    .then(
      (answer) => {
        unanswered.delete(key);
        // Only an entry still listed, settled or not, takes the answer.
        const listed = load(key);
        if (!listed) return publish();
        if (answer.write !== "done")
          return save(key, { ...listed, settled: answer.message });
        if (answer.note) notice = answer.note;
        save(key, null);
        onCreated(answer);
      },
      (cause: unknown) =>
        fail(cause instanceof Error ? cause.message : String(cause)),
    )
    .finally(() => clearTimeout(timer));
}

/**
 * Once per page: sends again, under their keys, the drafts a reload cut off
 * before an answer settled them, so each ends created or with its reason.
 * One whose key is past RETRY_WINDOW_MS is settled with a warning instead.
 */
export function resumeSubmissions(create: CreateInitiative, onCreated: OnCreated) {
  if (resumed) return;
  resumed = true;
  for (const s of loadAll()) {
    if (s.settled) continue;
    if (expired(s)) save(s.key, { ...s, settled: EXPIRED_MESSAGE });
    else follow(s, create, onCreated);
  }
}

/** Tests only: start over as a fresh page load would, from what is stored. */
export function reloadSubmissions() {
  memory.clear();
  unanswered.clear();
  notice = null;
  resumed = false;
  publish();
}
