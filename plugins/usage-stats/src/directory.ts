import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Names for the ids in the ledger: thread titles and projects from BB, Initiatives and their
// members from the Initiatives plugin's read-only context routes. Cached in memory: a page asks
// for every thread of its range, and a thread's title, project and Initiative rarely change.
// Both reads take seconds (BB answers one thread at a time, ~1.5 ms each, 4,000 for 30 days; the
// Initiatives plugin pages ~10,000 members), so a page waits only for names it has never had:
// past their TTL, cached names answer at once and are read again in the background.

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
  // The stale threads being read again in the background.
  const refreshing = new Set<string>();
  let memberships: { at: number; value: Map<string, Membership> } | null = null;
  let readingMemberships: Promise<Map<string, Membership>> | null = null;

  // null when BB could not answer: the thread keeps the name it had (none, for this page, if it
  // had none) and is asked again next time. Only a 404 proves it deleted.
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

  // complete is false when a read failed: what was read stays, the rest has no Initiative.
  async function readInitiatives(): Promise<{ value: Map<string, Membership>; complete: boolean }> {
    const value = new Map<string, Membership>();
    let token: string;
    try {
      token = (await bb.sdk.plugins.token({ pluginId: INITIATIVES_PLUGIN_ID })).token;
    } catch {
      // No Initiatives plugin: no Initiatives.
      return { value, complete: true };
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
            value.set(member.threadId, {
              initiativeId: initiative.initiativeId,
              initiativeName: initiative.name,
              member: memberLabel(member),
            });
          after = page.next;
        } while (after !== null);
      }
    } catch {
      return { value, complete: false };
    }
    return { value, complete: true };
  }

  // Reads ids CONCURRENCY at a time. A failed read leaves the cache as it was: unnamed, or named as
  // before.
  async function readThreads(ids: string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += CONCURRENCY) {
      const batch = ids.slice(index, index + CONCURRENCY);
      const infos = await Promise.all(batch.map(readThread));
      const at = now();
      batch.forEach((id, position) => {
        const info = infos[position];
        if (!info) return;
        threads.delete(id);
        threads.set(id, { info, at });
      });
    }
    while (threads.size > MAX_CACHED_THREADS) {
      const oldest = threads.keys().next();
      if (oldest.done) break;
      threads.delete(oldest.value);
    }
  }

  function readMemberships(): Promise<Map<string, Membership>> {
    readingMemberships ??= readInitiatives()
      .then(({ value, complete }) => {
        // An incomplete read stands in only for nothing, and is read again on the next call.
        if (complete) memberships = { at: now(), value };
        else if (memberships === null) memberships = { at: -Infinity, value };
        return memberships?.value ?? value;
      })
      .finally(() => {
        readingMemberships = null;
      });
    return readingMemberships;
  }

  return {
    async threads(ids) {
      const at = now();
      const unique = [...new Set(ids)];
      const stale = unique.filter((id) => {
        const cached = threads.get(id);
        return cached !== undefined && at - cached.at > THREAD_TTL_MS && !refreshing.has(id);
      });
      // What is known now, should the reads below evict it.
      const known = new Map(unique.map((id) => [id, threads.get(id)?.info]));
      if (stale.length > 0) {
        for (const id of stale) refreshing.add(id);
        void readThreads(stale).finally(() => {
          for (const id of stale) refreshing.delete(id);
        });
      }
      // Never waits on another page's reads: a page reads the names it lacks itself.
      await readThreads(unique.filter((id) => known.get(id) === undefined));
      return new Map(ids.map((id) => [id, threads.get(id)?.info ?? known.get(id) ?? { title: id, projectId: null, deleted: false }]));
    },
    async projects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return new Map(projects.map((project) => [project.id, project.name]));
    },
    async memberships() {
      if (memberships === null) return readMemberships();
      if (now() - memberships.at > INITIATIVES_TTL_MS) void readMemberships();
      return memberships.value;
    },
  };
}
