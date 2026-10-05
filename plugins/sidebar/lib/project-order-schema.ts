import { z } from "zod";

// Shared by the server and the frontend bundle. Keep this file free of
// `@get-bb/plugin-sdk` imports: only `/app` is available to the frontend.

/** Realtime channel carrying one `ProjectOrderDoc` per write. */
export const PROJECT_ORDER_CHANNEL = "project-order-changed";

/** A generous bound; the list only grows when durable projects exist. */
export const PROJECT_ORDER_MAX = 256;

const projectId = z.string().min(1).max(80);

/**
 * The persisted sidebar order for Projects mode. `order` may name durable
 * project ids that are absent from the current tree — an archived or briefly
 * unreachable project keeps its slot and reclaims it when it returns. The
 * frontend filters it down to present projects and appends any the doc has
 * not seen yet.
 */
export const projectOrderDocSchema = z.object({
  revision: z.number().int().nonnegative(),
  order: z.array(projectId).max(PROJECT_ORDER_MAX),
});
export type ProjectOrderDoc = z.infer<typeof projectOrderDocSchema>;

export const EMPTY_PROJECT_ORDER: ProjectOrderDoc = {
  revision: 0,
  order: [],
};

/** Dedupe and bound an order list; the first occurrence of an id wins. */
export function normalizeProjectOrder(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, PROJECT_ORDER_MAX);
}
