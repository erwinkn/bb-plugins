import { LIVE_PROMPT } from "./live-prompt.ts";
import { WORKER_BASE_PROMPT } from "./worker-prompt.ts";
import type Database from "better-sqlite3";
import { LEGACY_DEFAULT_PROMPT, LEGACY_VOICE_PROMPT, LEGACY_COORDINATOR_PROMPT, LEGACY_VOICE_PREFERENCES, legacyLiveInstructions } from "./legacy-prompt.ts";

export type PromptRole = "aide" | "live" | "worker" | "coordinator";
export const PROMPT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_role_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL, note TEXT, content TEXT NOT NULL)`,
];
export const promptDefault = (role: PromptRole) =>
  role === "aide" ? LIVE_PROMPT : role === "worker" ? WORKER_BASE_PROMPT : role === "live" ? LEGACY_VOICE_PROMPT : LEGACY_COORDINATOR_PROMPT;
export const promptLimit = (role: PromptRole) =>
  role === "coordinator" ? 4096 : 32000;

/** New calls read aide. The old live role is reserved for history and rollback. */
export class PromptStore {
  constructor(private db: Database.Database) {}
  read(role: PromptRole): string {
    const saved = this.db
      .prepare(
        "SELECT content FROM voice_role_prompts WHERE role=? ORDER BY id DESC LIMIT 1",
      )
      .get(role) as { content: string } | undefined;
    if (saved) return saved.content;
    if (role === "live") {
      const legacy = this.db
        .prepare("SELECT content FROM prompt_versions ORDER BY id DESC LIMIT 1")
        .get() as { content: string } | undefined;
      if (
        legacy &&
        ![LEGACY_DEFAULT_PROMPT, LEGACY_VOICE_PREFERENCES].includes(
          legacy.content,
        )
      )
        return legacyLiveInstructions(legacy.content);
    }
    return promptDefault(role);
  }
  save(role: PromptRole, content: string, note: string | null) {
    if (role === "live" || role === "coordinator") throw Error("Previous prompts are read only.");
    if (!content.trim()) throw Error("The prompt cannot be empty.");
    if (content.length > promptLimit(role))
      throw Error(
        `The ${role} prompt is limited to ${promptLimit(role)} characters.`,
      );
    this.db
      .prepare(
        "INSERT INTO voice_role_prompts(role,ts,source,note,content) VALUES (?,?, 'user',?,?)",
      )
      .run(role, Date.now(), note, content);
  }
  versions(role: PromptRole) {
    return this.db
      .prepare(
        "SELECT id,ts,source,note,content FROM voice_role_prompts WHERE role=? ORDER BY id DESC LIMIT 50",
      )
      .all(role) as {
      id: number;
      ts: number;
      source: string;
      note: string | null;
      content: string;
    }[];
  }
}
