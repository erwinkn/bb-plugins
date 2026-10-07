// node --expose-gc scripts/bench-abort-signal-any.mjs <bug|fix> <live> <churn>
//
// One long-lived signal (`stopped`, like the Pooler's plugin-lifetime controller). `live` requests
// are in flight; `churn` requests start and finish. Then a full GC collects the finished ones and
// we measure the longest event-loop stall while the FinalizationRegistry callbacks run.
//
// bug: each request signal is AbortSignal.any([client, stopped]).
// fix: each request owns an AbortController, linked to both sources by "abort" listeners that are
//      removed when the request finishes.
import { addAbortListener } from "node:events";
import { setImmediate as tick } from "node:timers/promises";

const stopped = new AbortController();
let finalized = 0;
const observed = new FinalizationRegistry(() => finalized++);

function requestBug(client) {
  return { signal: AbortSignal.any([client, stopped.signal]), dispose() {} };
}

function requestFix(client) {
  const controller = new AbortController();
  const links = [client, stopped.signal].map((source) => {
    const listener = addAbortListener(source, () => controller.abort(source.reason));
    return () => listener[Symbol.dispose]();
  });
  return { signal: controller.signal, dispose: () => links.forEach((unlink) => unlink()) };
}

const [mode, live, churn] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const make = mode === "bug" ? requestBug : requestFix;

const inFlight = [];
for (let i = 0; i < live; i++) inFlight.push(make(new AbortController().signal));
for (let i = 0; i < churn; i++) {
  const request = make(new AbortController().signal);
  request.dispose();
  observed.register(request.signal, 0);
}
await tick();

// The stall includes the synchronous gc() itself, so both modes pay the collection they cause.
const started = performance.now();
let last = started;
globalThis.gc();
let stall = 0;
let quietUntil = Infinity; // keep watching after our own registry drains: Node's may run later
while (performance.now() < quietUntil && performance.now() - started < 60_000) {
  if (finalized >= churn - 1 && quietUntil === Infinity) quietUntil = performance.now() + 3_000;
  await tick();
  const now = performance.now();
  stall = Math.max(stall, now - last);
  last = now;
}
console.log(
  [process.version, mode, live, churn, finalized, Math.round(stall) + " ms"].join("\t"),
);
inFlight.forEach((request) => request.dispose());
