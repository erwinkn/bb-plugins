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
