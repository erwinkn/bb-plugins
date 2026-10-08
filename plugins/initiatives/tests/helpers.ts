import Database from "better-sqlite3";
import { MIGRATIONS, Store } from "../lib/store";
import type { Brief } from "../lib/schema";

export function memoryStore(start = 1_700_000_000_000) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const clock = { now: start };
  const store = new Store(db, () => clock.now);
  return { db, store, clock };
}

export const brief = (
  bbProjectId = "proj_a",
  paths: string[] = ["src"],
): Brief => ({
  objective: "Make the thing work",
  acceptanceCriteria: ["It works"],
  contextRefs: [],
  areas: [{ bbProjectId, paths }],
  constraints: [],
  verification: ["npm test"],
});

/** T136: new work on a held task or checkout is warned about, never refused. */
export async function expectWarned(dispatch: Promise<{ warnings?: string[] }[]>, pattern: RegExp) {
  const [result] = await dispatch;
  if (!(result!.warnings ?? []).some((w) => pattern.test(w)))
    throw new Error(`expected a warning matching ${pattern}, got ${JSON.stringify(result!.warnings ?? [])}`);
}

/**
 * W248: a mocked command RPC answering as the server does: a keyed send (sendWrite) gets its
 * answer as a WriteAnswer. A mock that throws stays a thrown error.
 */
export const answersLikeServer =
  (command: (input: any) => unknown) =>
  async (input: unknown) => {
    const answer = await command(input);
    return (input as { key?: string } | null)?.key ? { write: "done", answer } : answer;
  };
