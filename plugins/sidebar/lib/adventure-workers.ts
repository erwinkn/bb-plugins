import { z } from "zod";

/**
 * Where a worker stands, in the Workers tab's terms (plugins/initiatives
 * lib/worker-group.ts): Needs you holds an open blocker nobody answered; Working a
 * running thread; Waiting a quiet thread with a live descendant (a review
 * running, queued or asking for input); Done a finished report; Stopped work
 * that ended without finishing and nothing picked up; Idle the quiet rest.
 */
export const WORKER_GROUPS = ["needs", "working", "waiting", "done", "stopped", "idle"] as const;
export type WorkerGroup = (typeof WORKER_GROUPS)[number];

/** The most Adventures one tree read asks worker facts for; clients send no more. */
export const MAX_WORKERS_OF = 64;

/** What the sidebar shows about one current worker beyond its BB thread. */
export const adventureWorkerSchema = z.object({
  ref: z.string().min(1).max(20),
  /** "provider / model / reasoning / tier", or null when unknown. */
  profile: z.string().max(300).nullable(),
  group: z.enum(WORKER_GROUPS),
  /** The group it would be in were its thread quiet, or failed; absent from facts cached by an older build. */
  quiet: z.enum(WORKER_GROUPS).optional(),
  errored: z.enum(WORKER_GROUPS).optional(),
});
export type AdventureWorker = z.infer<typeof adventureWorkerSchema>;

/**
 * The part of the Initiatives `overview` (summary tier) the sidebar reads; the rest is dropped.
 * `workerGroups` is the Workers tab's own derivation (plugins/initiatives lib/worker-group.ts),
 * so the sidebar never decides a group a second time.
 */
export const overviewSliceSchema = z.object({
  workers: z.object({
    current: z.array(z.object({ ref: z.string(), profile: z.string().nullable() })),
  }),
  // Absent from an Initiatives build that has not reloaded yet: its workers read as idle until it has.
  workerGroups: z.record(z.string(), z.object({ group: z.enum(WORKER_GROUPS), quiet: z.enum(WORKER_GROUPS), errored: z.enum(WORKER_GROUPS) })).optional(),
});
export type OverviewSlice = z.infer<typeof overviewSliceSchema>;

/** Each current worker's model and the group the Workers tab puts it in. */
export function adventureWorkers(overview: OverviewSlice): AdventureWorker[] {
  return overview.workers.current.map((w) => ({
    ref: w.ref,
    profile: w.profile,
    group: overview.workerGroups?.[w.ref]?.group ?? "idle",
    quiet: overview.workerGroups?.[w.ref]?.quiet ?? "idle",
    errored: overview.workerGroups?.[w.ref]?.errored ?? "stopped",
  }));
}

const capital = (word: string) =>
  `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`;

/**
 * The model and its reasoning level, as the Workers tab shows them:
 * "claude-code / claude-opus-5-5 / high / …" → "Opus 5.5 · high",
 * "codex / gpt-6.1-sol / xhigh" → "Sol 6.1 · xhigh"; other models keep their id.
 */
export function modelLabel(profile: string | null): string | null {
  if (!profile) return null;
  const parts = profile.split(" / ");
  const model = parts[1] ?? parts[0]!;
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(model);
  const gpt = /^gpt-(\d+(?:\.\d+)?)-(sol|luna|astra)$/i.exec(model);
  const name = claude
    ? `${capital(claude[1]!)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`
    : gpt
      ? `${capital(gpt[2]!)} ${gpt[1]}`
      : model;
  const level = parts[2];
  return level ? `${name} · ${level}` : name;
}
