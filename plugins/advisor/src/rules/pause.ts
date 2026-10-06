// Pause reasons (A144 §4). A watch holds a set of reasons; dispatch needs
// pending cards and an empty set. Each reason clears only its own way.
//
//   interrupted   Stop / interrupted turn     a later accepted request; or Resume
//   user-stopped  Initiatives userStopped        a later read showing false
//   failure       two consecutive failures    Resume only
//   manual        Pause in panel/CLI          Resume only
//   disabled      watch disabled              enable (new epoch)
//   budget        daily cap reached           day rollover or a raised cap

import { type EventRow, isInterrupt } from "./events.js";

export type PauseReason = "interrupted" | "user-stopped" | "failure" | "manual" | "disabled" | "budget";

export const CLEARED_BY_RESUME: ReadonlySet<PauseReason> = new Set(["manual", "failure", "interrupted"]);

export interface PauseLog {
  action: "pause" | "resume";
  via: string;
  caller: "unverified";
}

export class Watch {
  reasons = new Set<PauseReason>();
  pending = false;
  failures = 0;
  epoch = 1;
  log: PauseLog[] = [];

  observe(row: Pick<EventRow, "type" | "data">): void {
    if (isInterrupt(row as EventRow)) this.reasons.add("interrupted");
    else if (row.type === "turn/input/accepted") this.reasons.delete("interrupted"); // the watched work resumed
    if (row.type === "item/completed" || row.type === "turn/completed") this.pending = true;
  }

  projectsRead(userStopped: boolean): void {
    if (userStopped) this.reasons.add("user-stopped");
    else this.reasons.delete("user-stopped");
  }

  reviewFailed(): void {
    this.failures++;
    if (this.failures >= 2) this.reasons.add("failure");
  }

  reviewSucceeded(): void {
    this.failures = 0;
  }

  pause(via: string): void {
    this.reasons.add("manual");
    this.log.push({ action: "pause", via, caller: "unverified" });
  }

  /** Clears manual, failure and interrupted; never user-stopped, disabled or budget. The caller is unverified (U7). */
  resume(via: string): void {
    for (const r of CLEARED_BY_RESUME) this.reasons.delete(r);
    this.failures = 0;
    this.log.push({ action: "resume", via, caller: "unverified" });
  }

  disable(): void {
    this.reasons.add("disabled");
  }

  enable(): void {
    this.reasons.delete("disabled");
    this.epoch++;
  }

  budget(exhausted: boolean): void {
    if (exhausted) this.reasons.add("budget");
    else this.reasons.delete("budget");
  }

  mayDispatch(): boolean {
    return this.pending && this.reasons.size === 0;
  }
}
