/**
 * The frontend's copy of one machine's load. A content script drives the
 * polling loop while the window is visible; the footer gauge and the detail
 * panel only read. The panel asks for process lists while it is open.
 */
import type { HistoryPoint, LoadResult } from "./contract.js";
import { HISTORY_MS } from "./load-service.js";

export interface LoadSnapshot {
  result: LoadResult | null;
  /** History of `result.machineId`, oldest first. */
  history: HistoryPoint[];
  /** The machine the user picked; null follows BB's primary machine. */
  selectedMachineId: string | null;
  error: string | null;
}

const RPC_URL = "/api/v1/plugins/machine-load/rpc/load";
const SELECTED_MACHINE_KEY = "machine-load:machine";
const DEFAULT_REFRESH_MS = 3_000;
/** Longer than the server's own 10 s host timeout, so its error usually arrives first. */
const POLL_TIMEOUT_MS = 15_000;

function storedMachineId(): string | null {
  try {
    return globalThis.localStorage?.getItem(SELECTED_MACHINE_KEY) ?? null;
  } catch {
    return null;
  }
}

function rpcErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = Reflect.get(body, "error");
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : null;
}

export function createLoadStore(fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  const listeners = new Set<() => void>();
  let snapshot: LoadSnapshot = {
    result: null,
    history: [],
    selectedMachineId: storedMachineId(),
    error: null,
  };
  let detailViewers = 0;
  let requestSequence = 0;
  let wake: (() => void) | null = null;

  function update(next: Partial<LoadSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }

  async function poll(signal?: AbortSignal): Promise<void> {
    const requestId = ++requestSequence;
    const machineId = snapshot.selectedMachineId ?? snapshot.result?.machineId ?? null;
    const continuing = machineId !== null && machineId === snapshot.result?.machineId;
    const since = continuing ? (snapshot.history.at(-1)?.t ?? 0) : 0;
    // A hung request must surface as an error, or the gauge would keep old bars.
    const attempt = new AbortController();
    const timer = setTimeout(
      () => attempt.abort(new Error("Machine load did not answer in time.")),
      POLL_TIMEOUT_MS,
    );
    const forwardAbort = () => attempt.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await fetchImpl(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId, since, processes: detailViewers > 0 }),
        signal: attempt.signal,
      });
      const body: unknown = await response.json();
      if (signal?.aborted || requestId !== requestSequence) return;
      if (!response.ok || typeof body !== "object" || body === null || !("result" in body)) {
        throw new Error(rpcErrorMessage(body) ?? "Machine load could not be read.");
      }
      const result = body.result as LoadResult;
      const sameMachine = result.machineId === snapshot.result?.machineId && since > 0;
      const merged = sameMachine ? [...snapshot.history, ...result.history] : result.history;
      // History times are the server's clock; trim against it, not this browser's.
      const cutoff = (merged.at(-1)?.t ?? 0) - HISTORY_MS;
      // A remembered machine that was removed falls back to the primary one.
      const selectedMachineId = result.machines.some((machine) => machine.id === snapshot.selectedMachineId)
        ? snapshot.selectedMachineId
        : null;
      update({ result, history: merged.filter((point) => point.t >= cutoff), selectedMachineId, error: null });
    } catch (cause) {
      if (signal?.aborted || requestId !== requestSequence) return;
      update({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /** Poll now, then every refresh interval, until the signal aborts. */
  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await poll(signal);
      const delay = snapshot.result?.settings.refreshMs ?? DEFAULT_REFRESH_MS;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, delay);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          wake = null;
          resolve();
        }
        wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: (): LoadSnapshot => snapshot,
    run,
    poll,
    /** Count an open detail panel; process lists are read while any is open. */
    openDetail(): () => void {
      detailViewers += 1;
      wake?.();
      return () => {
        detailViewers -= 1;
      };
    },
    selectMachine(machineId: string): void {
      try {
        globalThis.localStorage?.setItem(SELECTED_MACHINE_KEY, machineId);
      } catch {
        // The choice still holds for this window.
      }
      update({ selectedMachineId: machineId });
      wake?.();
    },
  };
}

export type LoadStore = ReturnType<typeof createLoadStore>;
