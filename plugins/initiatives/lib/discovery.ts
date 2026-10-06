/** Parents one sweep lists per project; a larger graph rotates through them. */
export const DISCOVERY_PARENT_CAP = 300;
/** Parents an earlier sweep saw archived that are re-listed per sweep, oldest check first. */
export const DISCOVERY_RECHECK = 20;

type Row = { id: string; archivedAt: number | null; deletedAt: number | null };

/**
 * What this plugin instance has learned from discovery reads: member threads a
 * read saw natively archived, when each parent was last listed, and parents a
 * native event says must be listed again. Discovery alone consults it, to skip
 * reads whose only outcome on an archived thread is "nothing to associate or
 * attach" and to order a capped walk. No mutation, Stop, receipt or membership
 * path reads it, and it is never persisted, so a reload starts with a full scan.
 *
 * A created/unarchived event leaves a listing obligation on the member parent.
 * It overrides any archived observation, is planned right after the current
 * coordinator, and is discharged only by a completed listing that started
 * after the latest such event, so a failed, aborted or capped listing, or one
 * that raced a newer event, leaves it in place.
 *
 * Without an event (a live thread reparented under an archived parent), the
 * DISCOVERY_RECHECK rotation lists each archived seed within
 * ceil(archivedSeeds / DISCOVERY_RECHECK) sweeps whose listings succeed and
 * whose cap is not used up first by the coordinator, obligations and
 * never-listed parents. Live parents rotate likewise, within
 * ceil(liveParents / remaining budget) such sweeps. A burst of 300 never-listed
 * parents displaces both for a sweep, and sustained arrivals at that rate admit
 * no finite bound. These are bounds in sweeps, not minutes.
 *
 * Native child listings hide deleted threads, so a deleted seed is never
 * observed by a listing; only its own read (stranded-root or convergence get)
 * can mark it, otherwise it keeps being listed (with no rows) every sweep.
 */
export class DiscoveryMemory {
  private archived = new Set<string>();
  private listedOrder = new Map<string, Set<string>>();
  /** Parents a native event says must be listed, with the epoch of the latest such event. */
  private obligations = new Map<string, number>();
  private epoch = 0;

  /** A native event may have revived these member threads or given them children. */
  invalidate(...threadIds: (string | null | undefined)[]) {
    // Bumping the epoch voids archived observations from reads already in flight.
    this.epoch++;
    for (const id of threadIds)
      if (id) {
        this.archived.delete(id);
        this.obligations.set(id, this.epoch);
      }
  }

  /** Call before a read; pass the result to observe with its rows. */
  begin() {
    return this.epoch;
  }

  observe(rows: Row[], epoch: number, members: ReadonlySet<string>) {
    for (const row of rows)
      if (row.archivedAt === null && row.deletedAt === null) this.archived.delete(row.id);
      else if (epoch === this.epoch && members.has(row.id)) this.archived.add(row.id);
  }

  /**
   * One sweep's walk for a project: the current coordinator, then listing
   * obligations, then parents never listed in this instance in reverse seed
   * collection order (nested, project, worker, then coordinator threads; not a
   * creation-time sort), then the archived re-checks, then the rest least
   * recently listed first.
   */
  plan(projectId: string, seeds: readonly string[], coordinator: string | null) {
    const seedSet = new Set(seeds);
    const recheck = new Set<string>();
    for (const id of this.archived) {
      if (recheck.size >= DISCOVERY_RECHECK) break;
      if (seedSet.has(id)) recheck.add(id);
    }
    const earlier = new Set(this.archived);
    const skip = (id: string) =>
      !this.obligations.has(id) && earlier.has(id) && this.archived.has(id) && !recheck.has(id);
    const listed = this.listedOrder.get(projectId) ?? new Set<string>();
    for (const id of listed) if (!seedSet.has(id)) listed.delete(id);
    this.listedOrder.set(projectId, listed);
    const queue = new Set<string>();
    if (coordinator && seedSet.has(coordinator) && !skip(coordinator)) queue.add(coordinator);
    for (const id of this.obligations.keys()) if (seedSet.has(id)) queue.add(id);
    for (const id of [...seeds].reverse()) if (!listed.has(id) && !skip(id)) queue.add(id);
    for (const id of recheck) queue.add(id);
    for (const id of listed) if (!skip(id)) queue.add(id);
    return { queue: [...queue], skip, recheck };
  }

  /**
   * Records the start of a listing; a re-checked archived parent moves to the
   * back of its rotation. Returns the token to pass to completed.
   */
  listing(projectId: string, parentId: string, recheck: ReadonlySet<string>) {
    const listed = this.listedOrder.get(projectId);
    listed?.delete(parentId);
    listed?.add(parentId);
    if (recheck.has(parentId) && this.archived.delete(parentId)) this.archived.add(parentId);
    return this.obligations.get(parentId);
  }

  /** A listing finished; it discharges an obligation only if no newer event arrived meanwhile. */
  completed(parentId: string, token: number | undefined) {
    if (token !== undefined && this.obligations.get(parentId) === token) this.obligations.delete(parentId);
  }
}
