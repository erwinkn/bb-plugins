import { z } from "zod";
import { errorMessage, type Sdk } from "./bb";
import type { Store } from "./store";

export const CHAT_MEMORY_PLUGIN_ID = "chat-memory";
/**
 * The key, in this plugin's metadata on a thread it spawns, that names the memory scope the thread
 * will join: Chat memory reads it when the thread's first turn asks before its registration lands.
 */
export const MEMORY_SCOPE_KEY = "memoryScope";

/**
 * T145 (D446, D457): an Initiative's memory belongs to the Chat memory plugin: its log, summary
 * tree, mode, memory tools and turn hook. This plugin only tells it which threads share the
 * Initiative's memory, from the ledger: the coordinator, and a coordinator being started (its
 * first turn may come before its start is confirmed); D446's discussion threads join here.
 * Workers never do. An archived Initiative has none, which closes its memory. A paused one holds
 * its automatic compaction.
 *
 * One send per Initiative at a time; a sync while one is under way sends the ledger's state again
 * once it settles, so the latest one is always the last sent (A469). A failed send (the plugin
 * missing or reloading) goes again at the next sync, which every ledger change and every sweep runs.
 */
export class MemoryScopes {
  private accepted = new Map<string, string>();
  private draining = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private lastError = new Map<string, string>();

  constructor(
    private readonly deps: {
      store: Store;
      sdk: () => Sdk;
      log: (message: string) => void;
    },
  ) {}

  /** The threads that share the Initiative's memory, in order. */
  threads(projectId: string): string[] {
    const project = this.deps.store.project(projectId);
    if (!project || project.archivedAt !== null) return [];
    const starting = this.deps.store.db
      .prepare(`SELECT thread_id FROM coordinator_starts WHERE project_id = ? AND state IN ('pending', 'uncertain') AND thread_id IS NOT NULL`)
      .pluck()
      .get(projectId) as string | undefined;
    return [...new Set([project.coordinatorThreadId, starting].filter((id): id is string => !!id))];
  }

  /** What the memory should hold for the Initiative: its threads, and whether a pause holds its compaction. */
  scope(projectId: string) {
    return { key: projectId, threads: this.threads(projectId), hold: this.deps.store.project(projectId)?.paused ?? false };
  }

  /** Send the Initiative's latest state if the memory has not accepted it yet. Detached; resolves once the memory has it, or a send failed. */
  sync(projectId: string): Promise<void> {
    this.dirty.add(projectId);
    const running = this.draining.get(projectId);
    if (running) return running;
    const run = (async () => {
      // The entry is in the map before the first check, and leaves it in the same step as the last.
      await null;
      try {
        while (this.dirty.delete(projectId)) {
          const input = this.scope(projectId);
          const key = JSON.stringify(input);
          if (this.accepted.get(projectId) === key) continue;
          try {
            await this.deps.sdk().plugins.callRpc({ pluginId: CHAT_MEMORY_PLUGIN_ID, method: "setScope", input, outputSchema: z.object({ scope: z.string() }) });
            this.accepted.set(projectId, key);
            this.lastError.delete(projectId);
          } catch (error) {
            const message = errorMessage(error);
            if (this.lastError.get(projectId) !== message) this.deps.log(`Chat memory did not take ${projectId}'s threads (${message}); sending again at the next sweep.`);
            this.lastError.set(projectId, message);
            return;
          }
        }
      } finally {
        this.draining.delete(projectId);
      }
    })();
    this.draining.set(projectId, run);
    return run;
  }

  /** Every Initiative, archived ones included, so an archive closes its memory. */
  syncAll() {
    return Promise.all(this.deps.store.projects(true).map((p) => this.sync(p.id)));
  }
}
