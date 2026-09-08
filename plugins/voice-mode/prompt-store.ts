import type Database from "better-sqlite3";
import {
  COORDINATOR_INSTRUCTIONS,
  COORDINATOR_VOICE_PROMPT,
  DEFAULT_VOICE_PREFERENCES,
  realtimeInstructions,
} from "./coordinator/prompts.ts";
import { LEGACY_DEFAULT_PROMPT } from "./legacy-prompt.ts";

export type PromptRole = "live" | "coordinator";
export const PROMPT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS voice_role_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL, note TEXT, content TEXT NOT NULL)`,
];
export const promptDefault = (role: PromptRole) =>
  role === "live" ? COORDINATOR_VOICE_PROMPT : COORDINATOR_INSTRUCTIONS;
export const promptLimit = (role: PromptRole) =>
  role === "live" ? 20000 : 4096;

/** Full role prompts are used verbatim. Old preference edits remain visible on upgrade. */
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
        ![LEGACY_DEFAULT_PROMPT, DEFAULT_VOICE_PREFERENCES].includes(
          legacy.content,
        )
      )
        return realtimeInstructions(legacy.content);
    }
    return promptDefault(role);
  }
  save(role: PromptRole, content: string, note: string | null) {
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
