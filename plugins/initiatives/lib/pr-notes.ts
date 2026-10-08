// D442: an append-only log of notes per pull request. Whatever the coordinator
// tells the user about a PR (a caveat, a question, a comment on its review) and
// each worker report about it lands here, so it outlives the chat. Notes are
// never edited or removed; a question is marked answered once.
import type Database from "better-sqlite3";

export const PR_NOTE_KINDS = ["note", "question", "comment"] as const;
export type PrNoteKind = (typeof PR_NOTE_KINDS)[number];

export interface PrNote {
  /** 1, 2, …: its place in this PR's log; the coordinator answers a question by it. */
  n: number;
  at: number;
  /** "coordinator", a worker ref (W12), or "user" from a terminal. */
  author: string;
  kind: PrNoteKind;
  text: string;
  /** Where it came from: an assignment (A301), a BB thread id or a URL. */
  link: string | null;
  /** Questions only: when and by whom it was answered, and the answer if given. */
  answered: { at: number; by: string; text: string | null } | null;
}

/** What the queue carries per PR; the whole log is read on demand (prNotes). */
export interface PrNotesSummary {
  count: number;
  /** The last few, oldest first. */
  recent: PrNote[];
  /** Unanswered questions, oldest first: they drive the "?" marker. */
  open: PrNote[];
}

export const NO_NOTES: PrNotesSummary = { count: 0, recent: [], open: [] };
/** How many notes the queue carries per PR (the hover card's "last few"). */
export const RECENT_NOTES = 3;

export const PR_NOTE_MIGRATIONS = [
  `CREATE TABLE pr_notes (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    author TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    link TEXT,
    answered_at INTEGER,
    answered_by TEXT,
    answer TEXT,
    PRIMARY KEY (project_id, url, n)
  )`,
];

type Row = Record<string, unknown>;
const note = (row: Row): PrNote => ({
  n: Number(row.n),
  at: Number(row.at),
  author: String(row.author),
  kind: (PR_NOTE_KINDS as readonly string[]).includes(row.kind as string) ? (row.kind as PrNoteKind) : "note",
  text: String(row.text),
  link: (row.link as string | null) ?? null,
  answered: row.answered_at === null ? null
    : { at: Number(row.answered_at), by: String(row.answered_by), text: (row.answer as string | null) ?? null },
});

/** The notes table, on the plugin's one connection. URLs are canonical (canonicalPrUrl). */
export class PrNotes {
  constructor(private readonly db: Database.Database) {}

  /** Appends one note and returns its number in the PR's log. */
  append(projectId: string, url: string, entry: Omit<PrNote, "n" | "answered">): number {
    const { n } = this.db.prepare("SELECT coalesce(max(n), 0) + 1 AS n FROM pr_notes WHERE project_id = ? AND url = ?")
      .get(projectId, url) as { n: number };
    this.db.prepare("INSERT INTO pr_notes (project_id, url, n, at, author, kind, text, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(projectId, url, n, entry.at, entry.author, entry.kind, entry.text, entry.link);
    return n;
  }

  /** Marks question `n` answered; false when no such question exists. Answering again keeps the first answer. */
  answer(projectId: string, url: string, n: number, answer: { at: number; by: string; text: string | null }): boolean {
    const row = this.db.prepare("SELECT kind, answered_at FROM pr_notes WHERE project_id = ? AND url = ? AND n = ?")
      .get(projectId, url, n) as Row | undefined;
    if (!row || row.kind !== "question") return false;
    if (row.answered_at === null)
      this.db.prepare("UPDATE pr_notes SET answered_at = ?, answered_by = ?, answer = ? WHERE project_id = ? AND url = ? AND n = ?")
        .run(answer.at, answer.by, answer.text, projectId, url, n);
    return true;
  }

  /** One PR's whole log, oldest first. */
  list(projectId: string, url: string): PrNote[] {
    return (this.db.prepare("SELECT * FROM pr_notes WHERE project_id = ? AND url = ? ORDER BY n").all(projectId, url) as Row[]).map(note);
  }

  /** Every PR's count, last few notes and open questions, in one indexed read. */
  summaries(projectId: string): Map<string, PrNotesSummary> {
    const rows = this.db.prepare(`SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY url ORDER BY n DESC) AS back, count(*) OVER (PARTITION BY url) AS total
        FROM pr_notes WHERE project_id = ?
      ) WHERE back <= ? OR (kind = 'question' AND answered_at IS NULL) ORDER BY url, n`)
      .all(projectId, RECENT_NOTES) as Row[];
    const out = new Map<string, PrNotesSummary>();
    for (const row of rows) {
      const url = String(row.url);
      let summary = out.get(url);
      if (!summary) out.set(url, (summary = { count: Number(row.total), recent: [], open: [] }));
      const entry = note(row);
      if (Number(row.back) <= RECENT_NOTES) summary.recent.push(entry);
      if (entry.kind === "question" && !entry.answered) summary.open.push(entry);
    }
    return out;
  }
}
