import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Names for the ids in the ledger: thread titles and projects from BB, Initiatives and their
// members from the Initiatives plugin's read-only context routes. Cached in memory: a page asks
// for every thread of its range, and a thread's title, project and Initiative rarely change.

const THREAD_TTL_MS = 10 * 60_000;
const INITIATIVES_TTL_MS = 60_000;
const CONCURRENCY = 8;
const INITIATIVES_PLUGIN_ID = "initiatives";
const CONTEXT_PATH = "/api/v1/plugins/initiatives/http/context/v1";
const MAX_CACHED_THREADS = 20_000;

export interface ThreadInfo {
  title: string;
  projectId: string | null;
  deleted: boolean;
}

export interface Membership {
  initiativeId: string;
  initiativeName: string;
  // "Coordinator", "W219", "Ad hoc".
  member: string;
}

export interface Directory {
  // Every requested id has an entry: "Deleted thread" when BB says it is gone, its id when BB could
  // not answer (not cached).
  threads(ids: string[]): Promise<Map<string, ThreadInfo>>;
  projects(): Promise<Map<string, string>>;
  // Thread id → its Initiative, for every Initiative's members. Empty without the plugin.
  memberships(): Promise<Map<string, Membership>>;
}

const initiativesSchema = z.object({
  initiatives: z.array(z.object({ initiativeId: z.string(), name: z.string() })),
});
const membersSchema = z.object({
  next: z.string().nullable(),
  members: z.array(
    z.object({
      threadId: z.string(),
      kind: z.string(),
      // "W219" for a worker.
      worker: z.string().nullable().optional(),
    }),
  ),
});

function memberLabel(member: z.infer<typeof membersSchema>["members"][number]): string {
  if (member.kind === "coordinator") return "Coordinator";
  if (member.worker) return member.worker;
  return member.kind === "adhoc" ? "Ad hoc" : member.kind;
}

export function bbDirectory(bb: Pick<BbPluginApi, "sdk" | "server">, now = Date.now): Directory {
  const threads = new Map<string, { info: ThreadInfo; at: number }>();
  let memberships: { at: number; value: Promise<Map<string, Membership>> } | null = null;

  // null when BB could not answer: the thread stays unnamed for this page and is asked again next
  // time. Only a 404 proves it deleted.
  async function readThread(threadId: string): Promise<ThreadInfo | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        title: thread.title ?? thread.titleFallback ?? threadId,
        projectId: thread.projectId,
        deleted: thread.deletedAt !== null,
      };
    } catch (error) {
      if ((error as { status?: number }).status === 404)
        return { title: "Deleted thread", projectId: null, deleted: true };
      return null;
    }
  }

  async function readInitiatives(): Promise<Map<string, Membership>> {
    const result = new Map<string, Membership>();
    let token: string;
    try {
      token = (await bb.sdk.plugins.token({ pluginId: INITIATIVES_PLUGIN_ID })).token;
    } catch {
      return result;
    }
    const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
      const response = await fetch(`${bb.server.loopbackBaseUrl}${CONTEXT_PATH}${path}`, {
        headers: { "x-bb-plugin-token": token, accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Initiatives answered ${response.status}`);
      return schema.parse(await response.json());
    };
    try {
      const { initiatives } = await get("/initiatives", initiativesSchema);
      for (const initiative of initiatives) {
        let after: string | null = null;
        do {
          const query = new URLSearchParams({ initiativeId: initiative.initiativeId, limit: "500" });
          if (after !== null) query.set("after", after);
          const page = await get(`/members?${query}`, membersSchema);
          for (const member of page.members)
            result.set(member.threadId, {
              initiativeId: initiative.initiativeId,
              initiativeName: initiative.name,
              member: memberLabel(member),
            });
          after = page.next;
        } while (after !== null);
      }
    } catch {
      // Whatever was read stays; the rest has no Initiative.
    }
    return result;
  }

  return {
    async threads(ids) {
      const at = now();
      const missing = [...new Set(ids)].filter((id) => {
        const cached = threads.get(id);
        return cached === undefined || at - cached.at > THREAD_TTL_MS;
      });
      const unresolved = new Map<string, ThreadInfo>();
      for (let index = 0; index < missing.length; index += CONCURRENCY) {
        const batch = missing.slice(index, index + CONCURRENCY);
        const infos = await Promise.all(batch.map(readThread));
        batch.forEach((id, position) => {
          const info = infos[position];
          threads.delete(id);
          if (info) threads.set(id, { info, at });
          else unresolved.set(id, { title: id, projectId: null, deleted: false });
        });
      }
      while (threads.size > MAX_CACHED_THREADS) {
        const oldest = threads.keys().next();
        if (oldest.done) break;
        threads.delete(oldest.value);
      }
      return new Map(ids.map((id) => [id, threads.get(id)?.info ?? unresolved.get(id)!]));
    },
    async projects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return new Map(projects.map((project) => [project.id, project.name]));
    },
    memberships() {
      const at = now();
      if (memberships === null || at - memberships.at > INITIATIVES_TTL_MS)
        memberships = { at, value: readInitiatives() };
      return memberships.value;
    },
  };
}
