import { addAbortListener } from "node:events";

export interface LinkedSignal {
  readonly signal: AbortSignal;
  // Detaches the signal from its sources and clears its timer. Idempotent.
  dispose(): void;
}

// AbortSignal.any for sources that outlive the result: the signal aborts with the reason of the
// first source to abort, or after timeoutMs with AbortSignal.timeout's TimeoutError, and dispose()
// leaves nothing behind on the sources.
//
// Node 22's AbortSignal.any records every composite on each source, and each time a composite is
// garbage-collected it walks every composite still recorded on that source. With one composite
// per request on the plugin-lifetime signal, a GC that collects k of them while n are recorded
// costs k × n: 20,000 × 5,000 stalled the event loop for 3.1 s (14 ms with this). Node 24.16
// removed the walk (nodejs/node#62367); no Node 22 backport is known.
export function linkSignals(
  sources: readonly AbortSignal[],
  timeoutMs?: number,
): LinkedSignal {
  const controller = new AbortController();
  const unlinks: Array<() => void> = [];
  const dispose = () => {
    for (const unlink of unlinks.splice(0)) unlink();
  };
  const linked = { signal: controller.signal, dispose };
  // Take the first source in list order that is aborted. This matches AbortSignal.any when an
  // earlier source's listener aborts a later one, but not the reverse: if B's listener aborts an
  // earlier A, AbortSignal.any keeps B's reason and this picks A's. Native composites abort before
  // any listener runs, which a listener cannot replicate; callers only use the reason as a message.
  const firstAborted = () => sources.find((source) => source.aborted);
  const already = firstAborted();
  if (already !== undefined) {
    controller.abort(already.reason);
    return linked;
  }
  const abort = (reason: unknown) => {
    dispose();
    controller.abort(reason);
  };
  for (const source of sources) {
    // addAbortListener ignores stopImmediatePropagation() from earlier listeners, as AbortSignal.any
    // does.
    const listener = addAbortListener(source, () =>
      abort(firstAborted()?.reason),
    );
    unlinks.push(() => listener[Symbol.dispose]());
  }
  if (timeoutMs !== undefined) {
    const timer = setTimeout(
      () =>
        abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
    timer.unref();
    unlinks.push(() => clearTimeout(timer));
  }
  return linked;
}

// The operation's outcome, or the signal's reason once it aborts first. The operation keeps
// running; only the wait for it ends.
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
