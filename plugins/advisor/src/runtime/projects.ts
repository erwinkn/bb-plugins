// Initiative context through the Initiatives plugin's public, token-authenticated
// read routes (T96/A222 context contract v1). Read-only: no Initiatives
// database, no Initiatives code, no writes.
//
//   GET /api/v1/plugins/<id>/http/context/v1/thread?threadId=…
//   GET /api/v1/plugins/<id>/http/context/v1/record?initiativeId=…&ref=…&part=brief
//
// <id> is `initiatives`, or `projects` until the plugin's one-time move: the
// running one, else the installed one (see initiativesPluginId).
//
// A response without `version: 1` is unknown context. When the route itself
// does not exist (BB's own 404 without `version`, or no Initiatives plugin
// installed), the source reports itself unavailable and threads are treated as
// standalone, exactly as without Initiatives (D356). Everything else is a
// failed read, never "standalone": a timeout, a 500, an unparseable body, BB's
// 503 while the plugin is not running (a reload or a crash is not absence), and
// its own 503 while it is paused for its one-time import.

import { z } from "zod";
import { failed, ok, type AssignmentRecord, type Membership, type Read, type RefsResult, type TaskBriefRecord } from "../rules/snapshot.js";
import type { InitiativeSource, Listing } from "./initiatives.js";
import { unavailableInitiatives } from "./initiatives.js";
import type { FetchLike } from "../transport/types.js";

/** The Initiatives plugin's ID, then the one it had until its one-time move. Drop `projects` once retired. */
export const INITIATIVE_PLUGIN_IDS = ["initiatives", "projects"] as const;

/**
 * Which plugin answers context reads: the running one of INITIATIVE_PLUGIN_IDS,
 * else an installed one (its 503 is a failed read, never absence), else none
 * (standalone). Cached briefly: every watched thread reads context.
 */
export function initiativesPluginId(
  list: () => Promise<{ plugins: { id: string; enabled?: boolean; status?: string }[] }>,
  now: () => number = Date.now,
  ttlMs = 5000,
): () => Promise<string | null> {
  let cached: { id: string | null; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.id;
    const { plugins } = await list();
    const installed = INITIATIVE_PLUGIN_IDS.filter((id) => plugins.some((p) => p.id === id));
    const running = installed.find((id) => plugins.some((p) => p.id === id && p.enabled && p.status === "running"));
    cached = { id: running ?? installed[0] ?? null, at: now() };
    return cached.id;
  };
}
const TIMEOUT_MS = 2000;
const BRIEF_MAX_CHARS = 64 * 1024;

const assignmentContext = z
  .object({
    ref: z.string(),
    tasks: z.array(z.string()),
    phase: z.enum(["pending", "active", "reported", "accepted", "rejected", "cancelled", "failed"]),
    state: z.string(),
    cancelRequested: z.boolean(),
    updatedAt: z.number(),
  })
  .passthrough();

const threadContext = z
  .object({
    version: z.literal(1),
    threadId: z.string(),
    membership: z
      .object({
        initiativeId: z.string(),
        coordinator: z.object({ threadId: z.string().nullable(), generation: z.number().nullable().optional() }).passthrough(),
        kind: z.string(),
        role: z.string(),
        worker: z.string().nullable(),
        generation: z.number().nullable(),
        state: z.enum(["active", "stopped", "retired", "former"]),
        former: z.boolean(),
        stopped: z.boolean(),
        assignment: assignmentContext.nullable(),
        next: assignmentContext.nullable(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const recordPage = z
  .object({
    version: z.literal(1),
    ref: z.string(),
    updatedAt: z.number(),
    meta: z.record(z.string(), z.unknown()),
    totalChars: z.number(),
    nextOffset: z.number().nullable(),
    text: z.string(),
    textVersion: z.string().optional(), // v1.1
  })
  .passthrough();

const initiativesPage = z
  .object({
    version: z.literal(1),
    initiatives: z.array(
      z
        .object({
          initiativeId: z.string(),
          name: z.string(),
          paused: z.boolean(),
          coordinator: z.object({ threadId: z.string().nullable() }).passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const membersPage = z
  .object({
    version: z.literal(1),
    initiativeId: z.string(),
    name: z.string(),
    archived: z.boolean(),
    // Paged by thread id since contract v1 members was added; absent next means one complete page.
    next: z.string().nullable().optional(),
    members: z.array(
      z
        .object({
          threadId: z.string(),
          kind: z.string(),
          role: z.string(),
          worker: z.string().nullable(),
          generation: z.number().nullable(),
          state: z.enum(["active", "stopped", "retired", "former"]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const PHASE_STATE: Record<string, string> = {
  pending: "queued",
  active: "running",
  reported: "reported",
  accepted: "accepted",
  rejected: "rejected",
  cancelled: "cancelled",
  failed: "failed",
};

export interface ProjectsDeps {
  fetch: FetchLike;
  loopbackBaseUrl: () => string;
  /** bb.sdk.plugins.token({ pluginId }); throws when that plugin is not installed. */
  token: (pluginId: string) => Promise<string>;
  /** The plugin to read; null when no Initiatives plugin is installed. Defaults to `initiatives`. */
  pluginId?: () => Promise<string | null>;
}

class Unavailable extends Error {}

export function projectsInitiatives(d: ProjectsDeps): InitiativeSource {
  let available = true;
  let reason = "";
  const initiativeOf = new Map<string, string>(); // threadId -> initiativeId, from the last thread read
  const context = new Map<string, z.infer<typeof threadContext>>(); // threadId -> last thread context

  async function get(path: string, signal: AbortSignal): Promise<unknown> {
    const pluginId = d.pluginId ? await d.pluginId() : INITIATIVE_PLUGIN_IDS[0];
    if (pluginId === null) throw new Unavailable("no Initiatives plugin is installed");
    let token: string;
    try {
      token = await d.token(pluginId);
    } catch (err) {
      throw new Unavailable(`Initiatives plugin token unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const res = await d.fetch(`${d.loopbackBaseUrl()}/api/v1/plugins/${pluginId}/http/context/v1/${path}`, {
      method: "GET",
      headers: { "x-bb-plugin-token": token },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`unparseable Initiatives response (${res.status})`);
    }
    if (body?.version !== 1) {
      // BB's own envelope: only a 404 says the route or the plugin is not there.
      if (res.status === 404) throw new Unavailable(`Initiatives context route unavailable (404: ${String(body?.error ?? "").slice(0, 120)})`);
      throw new Error(`unknown Initiatives context (${res.status}, no version 1${typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : ""})`);
    }
    if (!res.ok) throw new Error(`Initiatives ${res.status} ${String(body?.error?.code ?? "")}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
    return body;
  }

  /**
   * Page a record's text. Contract v1.1: every page carries `textVersion`;
   * pages from different versions are never stitched. A change mid-read
   * restarts once from offset 0; a second change is a failed read (unknown).
   * A v1 server without the field is read as before.
   */
  async function readRecord(initiativeId: string, ref: string, signal: AbortSignal): Promise<{ text: string; meta: Record<string, unknown> } | "missing"> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let offset = 0;
      let text = "";
      let meta: Record<string, unknown> = {};
      let version: string | undefined;
      let changed = false;
      for (;;) {
        let raw: unknown;
        try {
          raw = await get(`record?initiativeId=${encodeURIComponent(initiativeId)}&ref=${encodeURIComponent(ref)}&part=brief&offset=${offset}&limit=16000`, signal);
        } catch (err) {
          if (err instanceof Error && / 404 not-found/u.test(err.message)) return "missing";
          throw err;
        }
        const page = recordPage.parse(raw);
        if (offset === 0) version = page.textVersion;
        else if (page.textVersion !== version) {
          changed = true;
          break;
        }
        text += page.text;
        meta = page.meta;
        if (page.nextOffset === null) return { text, meta };
        if (text.length > BRIEF_MAX_CHARS) throw new Error(`brief ${ref} over ${BRIEF_MAX_CHARS} characters`);
        offset = page.nextOffset;
      }
      if (!changed) break;
    }
    throw new Error(`record ${ref} changed while it was read twice (textVersion)`);
  }

  /** A listing never changes `available`: an Initiatives build without these routes still serves thread context. */
  async function listing<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<Listing<T>> {
    try {
      const parsed = schema.safeParse(await get(path, signal));
      return parsed.success ? { status: "ok", value: parsed.data } : { status: "failed", error: `Initiatives ${path.split("?")[0]} does not match contract v1` };
    } catch (err) {
      return { status: err instanceof Unavailable ? "unavailable" : "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  const source: InitiativeSource = {
    async initiatives(signal) {
      const r = await listing("initiatives", initiativesPage, signal);
      if (r.status !== "ok") return r;
      return { status: "ok", value: r.value.initiatives.map((i) => ({ id: i.initiativeId, name: i.name, paused: i.paused, coordinatorThreadId: i.coordinator.threadId })) };
    },
    async members(initiativeId, after, signal) {
      const r = await listing(`members?initiativeId=${encodeURIComponent(initiativeId)}&limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`, membersPage, signal);
      if (r.status !== "ok") return r;
      const v = r.value;
      return {
        status: "ok",
        value: {
          id: v.initiativeId,
          name: v.name,
          archived: v.archived,
          next: v.next ?? null,
          members: v.members.map((m) => ({ threadId: m.threadId, kind: m.kind, role: m.role, worker: m.worker, generation: m.generation, state: m.state })),
        },
      };
    },
    get available() {
      return available;
    },
    get label() {
      return available ? "Initiative context from the Initiatives plugin (read-only context contract v1)." : `${unavailableInitiatives.label} ${reason}`.trim();
    },
    async membership(threadId, signal): Promise<Read<Membership | null>> {
      let raw: unknown;
      try {
        raw = await get(`thread?threadId=${encodeURIComponent(threadId)}`, signal);
      } catch (err) {
        if (err instanceof Unavailable) {
          available = false;
          reason = err.message;
          return ok(null);
        }
        return failed(err instanceof Error ? err.message : String(err));
      }
      available = true;
      const parsed = threadContext.safeParse(raw);
      if (!parsed.success) return failed("Initiatives thread context does not match contract v1");
      const m = parsed.data.membership;
      context.set(threadId, parsed.data);
      if (m === null) {
        initiativeOf.delete(threadId);
        return ok(null);
      }
      initiativeOf.set(threadId, m.initiativeId);
      // The last delivered assignment stays canonical in every phase: a reported
      // or accepted brief is still this thread's brief, a cancelled or rejected
      // one is history. `next` was not delivered: shown, never a requirement.
      const delivered = m.assignment;
      return ok({
        coordinatorThreadId: m.coordinator.threadId ?? "",
        former: m.former || m.state === "former",
        queued: m.next ? m.next.ref : null,
        initiative: { id: m.initiativeId, name: typeof m.initiativeName === "string" ? m.initiativeName : m.initiativeId, kind: m.kind, role: m.role, worker: m.worker, state: m.state },
        worker: {
          ref: m.worker ?? `${m.kind}`,
          role: m.role,
          generation: m.generation ?? 0,
          userStopped: m.stopped,
          assignments: delivered ? [{ ref: delivered.ref, state: PHASE_STATE[delivered.phase]!, cancelled: delivered.cancelRequested, tasks: delivered.tasks }] : [],
        },
      });
    },
    async assignments(threadId, refs, signal): Promise<Read<RefsResult<AssignmentRecord>>> {
      const initiativeId = initiativeOf.get(threadId);
      if (!initiativeId) return failed("no Initiative membership read for this thread");
      const ctx = context.get(threadId)?.membership;
      const items: AssignmentRecord[] = [];
      const missingRefs: string[] = [];
      try {
        for (const ref of refs) {
          const r = await readRecord(initiativeId, ref, signal);
          if (r === "missing") {
            missingRefs.push(ref);
            continue;
          }
          const live = [ctx?.assignment, ctx?.next].find((a) => a?.ref === ref);
          // Branch on phase (contract v1): the raw stored state is informational.
          const phase = live?.phase ?? String(r.meta.phase ?? "");
          items.push({
            ref,
            state: PHASE_STATE[phase] ?? phase,
            workerNum: Number(String(r.meta.worker ?? ctx?.worker ?? "W0").replace(/^W/u, "")) || 0,
            generation: ctx?.generation ?? 0,
            cancelRequested: live?.cancelRequested ?? false,
            briefText: r.text,
            taskNums: (Array.isArray(r.meta.tasks) ? r.meta.tasks : live?.tasks ?? []).map((t: unknown) => Number(String(t).replace(/^T/u, ""))),
          });
        }
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
      return ok({ items, missingRefs });
    },
    async tasks(threadId, refs, signal): Promise<Read<RefsResult<TaskBriefRecord>>> {
      const initiativeId = initiativeOf.get(threadId);
      if (!initiativeId) return failed("no Initiative membership read for this thread");
      const items: TaskBriefRecord[] = [];
      const missingRefs: string[] = [];
      try {
        for (const ref of refs) {
          const r = await readRecord(initiativeId, ref, signal);
          if (r === "missing") missingRefs.push(ref);
          else items.push({ ref, brief: r.text });
        }
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
      return ok({ items, missingRefs });
    },
  };
  return source;
}
