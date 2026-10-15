import { z } from "zod";

/**
 * Where a worker stands, in the Workers tab's terms (plugins/initiatives
 * workerView): Needs you holds an open blocker nobody answered; Working a
 * running thread or one waiting on a running child; Done a finished report;
 * Stopped work that ended without finishing and nothing picked up; Idle the
 * quiet rest.
 */
export const WORKER_GROUPS = ["needs", "working", "done", "stopped", "idle"] as const;
export type WorkerGroup = (typeof WORKER_GROUPS)[number];

/** The most Adventures one tree read asks worker facts for; clients send no more. */
export const MAX_WORKERS_OF = 64;

/** What the sidebar shows about one current worker beyond its BB thread. */
export const adventureWorkerSchema = z.object({
  ref: z.string().min(1).max(20),
  /** "provider / model / reasoning / tier", or null when unknown. */
  profile: z.string().max(300).nullable(),
  group: z.enum(WORKER_GROUPS),
});
export type AdventureWorker = z.infer<typeof adventureWorkerSchema>;

/** The part of the Initiatives `overview` (summary tier) the sidebar reads; the rest is dropped. */
export const overviewSliceSchema = z.object({
  workers: z.object({
    current: z.array(
      z.object({
        ref: z.string(),
        profile: z.string().nullable(),
        runtime: z.string(),
        open: z.unknown().nullable(),
        stopReason: z.string().nullable(),
        latestReport: z.object({ outcome: z.string() }).nullable(),
      }),
    ),
  }),
  blockers: z.array(
    z.object({
      owner: z.object({ worker: z.string() }),
      answer: z.unknown().optional(),
    }),
  ),
  workerWaiting: z
    .record(z.string(), z.object({ on: z.unknown().nullable() }))
    .optional(),
});
export type OverviewSlice = z.infer<typeof overviewSliceSchema>;

const BUSY_THREAD = new Set(["active", "starting", "stopping"]);
const FAILED_THREAD = new Set(["error", "failed"]);

/** Each current worker's model and group, by the Workers tab's rules. */
export function adventureWorkers(overview: OverviewSlice): AdventureWorker[] {
  const blocked = new Set(
    overview.blockers.filter((b) => !b.answer).map((b) => b.owner.worker),
  );
  return overview.workers.current.map((w) => {
    const report = w.latestReport;
    const group: WorkerGroup = blocked.has(w.ref)
      ? "needs"
      : BUSY_THREAD.has(w.runtime) || overview.workerWaiting?.[w.ref]?.on
        ? "working"
        : FAILED_THREAD.has(w.runtime) || w.open || w.stopReason
          ? "stopped"
          : report?.outcome === "done"
            ? "done"
            : report
              ? "stopped"
              : "idle";
    return { ref: w.ref, profile: w.profile, group };
  });
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
