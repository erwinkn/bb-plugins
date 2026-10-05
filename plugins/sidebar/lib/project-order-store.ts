import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  EMPTY_PROJECT_ORDER,
  PROJECT_ORDER_CHANNEL,
  PROJECT_ORDER_MAX,
  normalizeProjectOrder,
  projectOrderDocSchema,
  type ProjectOrderDoc,
} from "./project-order-schema";

export const PROJECT_ORDER_KEY = "project-order";

export class ProjectOrderConflictError extends Error {
  constructor() {
    super("Project order changed on another client. Reload and retry.");
  }
}

/**
 * The stored document exists but does not parse. Sync and save must not
 * overwrite it — losing the user's order silently is worse than refusing to
 * persist until the document is repaired or cleared by hand.
 */
export class ProjectOrderInvalidError extends Error {
  constructor() {
    super(
      "The stored project order is unreadable; reordering stays local until it is repaired.",
    );
  }
}

/**
 * Fit an order under the durable bound. Ids the current view does not list
 * (archived or briefly unreachable projects) are placeholders only — evict
 * them from the tail first so visible projects always keep their slots.
 */
const capOrder = (
  merged: readonly string[],
  visible: ReadonlySet<string>,
): string[] => {
  if (merged.length <= PROJECT_ORDER_MAX) return [...merged];
  const out = merged.slice();
  for (let i = out.length - 1; i >= 0 && out.length > PROJECT_ORDER_MAX; i--)
    if (!visible.has(out[i])) out.splice(i, 1);
  return out.slice(0, PROJECT_ORDER_MAX);
};

/**
 * One kv document orders the flat Projects rows. It is the only place the
 * displayed order lives, so activity, selection, polling, and reloads never
 * move a project the user did not move. `sync` runs inside the read path: it
 * keeps ids the current tree no longer lists and appends never-seen ids in
 * tree order, writing only when the appended set is non-empty.
 */
export function createProjectOrderStore(bb: BbPluginApi) {
  // The plugin server is one process; a promise chain makes every
  // read-modify-write atomic without a database transaction.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (): Promise<ProjectOrderDoc> => {
    const stored = await bb.storage.kv.get<unknown>(PROJECT_ORDER_KEY);
    if (stored === undefined || stored === null) return EMPTY_PROJECT_ORDER;
    const parsed = projectOrderDocSchema.safeParse(stored);
    if (!parsed.success) throw new ProjectOrderInvalidError();
    return parsed.data;
  };
  const write = async (
    current: ProjectOrderDoc,
    order: readonly string[],
  ): Promise<ProjectOrderDoc> => {
    const next: ProjectOrderDoc = {
      revision: current.revision + 1,
      order: normalizeProjectOrder(order),
    };
    await bb.storage.kv.set(PROJECT_ORDER_KEY, next);
    // The payload is the document, so clients need no follow-up fetch.
    bb.realtime.publish(PROJECT_ORDER_CHANNEL, next);
    return next;
  };
  return {
    read,
    sync: (ids: readonly string[]): Promise<ProjectOrderDoc> =>
      serialized(async () => {
        const current = await read();
        const known = new Set(current.order);
        // Presence is computed over every id the tree lists. Normalizing to
        // the cap here would mark the overflow tail absent, so at the bound a
        // same-set snapshot shuffle would evict a different id on each read.
        const visibleIds = [...new Set(ids)];
        const appended = visibleIds.filter((id) => !known.has(id));
        if (!appended.length) return current;
        // At the bound, new projects still land: remembered slots for absent
        // projects yield before a visible project goes unordered.
        const merged = capOrder(
          [...current.order, ...appended],
          new Set(visibleIds),
        );
        // A full visible list over the cap: appended ids are cut back to the
        // same document, so there is nothing to publish.
        if (
          merged.length === current.order.length &&
          merged.every((id, index) => id === current.order[index])
        )
          return current;
        return write(current, merged);
      }),
    save: (
      expectedRevision: number,
      order: readonly string[],
    ): Promise<ProjectOrderDoc> =>
      serialized(async () => {
        const current = await read();
        if (current.revision !== expectedRevision)
          throw new ProjectOrderConflictError();
        const normalized = normalizeProjectOrder(order);
        const submitted = new Set(normalized);
        // Walk the stored order: each id the client submitted takes the next
        // submitted slot, while an id the client could not see (archived,
        // briefly unreachable) holds its exact slot and reclaims it on
        // return. Submitted ids the doc never saw append at the end.
        const merged: string[] = [];
        let cursor = 0;
        for (const id of current.order) {
          if (submitted.has(id)) {
            if (cursor < normalized.length) merged.push(normalized[cursor++]);
          } else {
            merged.push(id);
          }
        }
        while (cursor < normalized.length) merged.push(normalized[cursor++]);
        return write(current, capOrder(merged, submitted));
      }),
  };
}

export type ProjectOrderStore = ReturnType<typeof createProjectOrderStore>;
