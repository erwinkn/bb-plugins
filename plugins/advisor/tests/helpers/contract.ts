// Installed-contract fixtures shared by the freshness cases (A160 raw/contract,
// copied verbatim): typed ThreadResponse shapes and real Projects workers and
// readRefs output. Fixtures change only the named fields.

import { Requests } from "../../src/rules/requests.js";
import { enc } from "../../src/rules/packet.js";
import { snapshot, classifyCompletion, ok as readOk, type Snapshot } from "../../src/rules/snapshot.js";
import type { EventRow } from "../../src/rules/events.js";
import { fixture } from "./a160.js";

export const TS = fixture("thread-shapes.json");
export const PS = fixture("projects-shapes.json");
export const SETTINGS = { epoch: 1, settingsRev: 7 };
export const CHILD = TS.childThread;
export const W_RUN = PS.workers_view_running.items[0];
export const W_REP = PS.workers_view_after_report.items[0];
export const A_RUN = PS.readRefs_detailed_running;
export const A_REP = PS.readRefs_detailed_after_report;
export const A_CAN = PS.readRefs_detailed_cancel_requested;
export const T_BRIEF = PS.readRefs_task_brief;

export function member(row: any = W_RUN, coordinator = "thr_coord", over: Record<string, unknown> = {}) {
  return readOk({ coordinatorThreadId: coordinator, worker: { ...row, ...over }, former: false });
}
export function editItems(result: any, over: Record<string, unknown>) {
  return { ...result, items: result.items.map((i: any) => ({ ...i, ...over })) };
}
export function snap(o: { thread?: any; settings?: typeof SETTINGS; proj?: any; arefs?: any; trefs?: any; refs?: Iterable<string> } = {}): Snapshot {
  const thread = o.thread && typeof o.thread === "object" && "ok" in o.thread ? o.thread : readOk(o.thread ?? CHILD);
  return snapshot(thread, o.settings ?? SETTINGS, o.proj ?? member(), o.arefs ?? readOk(A_RUN), o.trefs ?? readOk(T_BRIEF), o.refs ?? []);
}
export const SNAP = snap();
export function fresh(
  rowsAfter: EventRow[],
  o: { drained?: boolean; req?: Requests; now?: number; base?: Snapshot } & Parameters<typeof snap>[0] = {},
) {
  const b = o.base ?? SNAP;
  return classifyCompletion(
    b,
    snap({ ...o, refs: Object.keys(b.activeRow?.refs ?? {}) }),
    rowsAfter,
    o.drained ?? true,
    o.req ?? new Requests({ parent: "thr_coord", coordinator: "thr_coord" }),
    o.now ?? 0,
  );
}
export const work: EventRow[] = [{ seq: 70, type: "item/completed", data: { item: { type: "commandExecution" } } }];

export function textCard(i: number, n = 1536) {
  const t = `card ${i} ` + "y".repeat(n - 8);
  return { id: `C:${i}`, seq: i, text: t, encBytes: enc(t) };
}

