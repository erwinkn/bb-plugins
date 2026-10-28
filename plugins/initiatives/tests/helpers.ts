import Database from "better-sqlite3";
import { MIGRATIONS, Store } from "../lib/store";
import type { Brief } from "../lib/schema";
import type { Cached, ChildPage } from "../lib/contract";
import { assignmentPrRefs } from "../lib/pr-refs";

export function memoryStore(start = 1_700_000_000_000) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const clock = { now: start };
  const store = new Store(db, () => clock.now);
  return { db, store, clock };
}

/** W506: a Store's PR ref lookups over these assignments, each indexed as Store does on a write. */
export function prRefsOf(rows: { num: number; workerNum: number; role: string; brief: string; report: string | null }[]) {
  const refs = (kind: "named" | "referenced") => [...rows].sort((a, b) => a.num - b.num).flatMap((row) =>
    assignmentPrRefs(row.brief, row.report)[kind].map((url) => ({ url, num: row.num, workerNum: row.workerNum, role: row.role })));
  return {
    prRefs: (_projectId: string, kind: "named" | "referenced") => refs(kind),
    workerPrRefs: (_projectId: string, workerNum: number) => refs("referenced").filter((r) => r.workerNum === workerNum).map((r) => r.url),
    latestPrRef: (_projectId: string, url: string, kind: "named" | "referenced") => refs(kind).filter((r) => r.url === url).at(-1) ?? null,
  };
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

/** childPage answers from the server's cache: ask again until its background read has landed. */
export async function settledChildPage(
  harness: { callRpc(method: string, input: unknown): Promise<unknown> },
  input: { projectId: string; threadId: string; offset?: number },
): Promise<Exclude<Cached<ChildPage>, { status: "loading" }>> {
  for (let n = 0; n < 100; n++) {
    const answer = (await harness.callRpc("childPage", input)) as Cached<ChildPage>;
    if (answer.status !== "loading") return answer;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("childPage is still loading");
}
