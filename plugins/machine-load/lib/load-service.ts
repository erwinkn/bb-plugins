/**
 * The server's view of every machine's load. Samples are taken only when a
 * client asks, and a sample younger than most of the refresh interval is
 * shared, so two open windows cost one read per machine per interval. The
 * history behind the sparklines lives here, in memory, for 30 minutes.
 */
import type { HistoryPoint, LoadResult, LoadSettings, Machine, Sample } from "./contract.js";

export const HISTORY_MS = 30 * 60_000;
/** Share a sample with a second client when it is this fraction of an interval old. */
const REUSE_FRACTION = 0.75;

interface MachineState {
  latest: Sample | null;
  history: HistoryPoint[];
  pending: { processes: boolean; promise: Promise<Sample> } | null;
  error: string | null;
}

export interface LoadServiceDeps {
  listMachines(): Promise<Machine[]>;
  sampleMachine(machineId: string, processes: boolean): Promise<Sample>;
  settings(): LoadSettings;
  now(): number;
}

export interface LoadRequest {
  machineId: string | null;
  since: number;
  processes: boolean;
}

export function historyPoint(sample: Sample): HistoryPoint {
  const { totalBytes, availableBytes } = sample.memory;
  return {
    t: sample.takenAt,
    cpu: sample.cpu.percent,
    memory: totalBytes === 0 ? 0 : ((totalBytes - availableBytes) / totalBytes) * 100,
    diskRead: sample.io.diskReadBps,
    diskWrite: sample.io.diskWriteBps,
    netReceive: sample.io.netReceiveBps,
    netSend: sample.io.netSendBps,
  };
}

export function createLoadService(deps: LoadServiceDeps) {
  const states = new Map<string, MachineState>();

  function stateFor(machineId: string): MachineState {
    let state = states.get(machineId);
    if (state === undefined) {
      state = { latest: null, history: [], pending: null, error: null };
      states.set(machineId, state);
    }
    return state;
  }

  /**
   * Keep a sample on the server's timeline. The host's own clock may be
   * skewed, so freshness, history, and the clients' cursors all use the time
   * the server received the reading, kept strictly increasing.
   */
  function record(state: MachineState, sample: Sample): void {
    const takenAt = Math.max(deps.now(), (state.history.at(-1)?.t ?? 0) + 1);
    const stamped = { ...sample, takenAt };
    state.latest = stamped;
    state.error = null;
    state.history.push(historyPoint(stamped));
    const cutoff = takenAt - HISTORY_MS;
    const firstKept = state.history.findIndex((point) => point.t >= cutoff);
    if (firstKept > 0) state.history.splice(0, firstKept);
  }

  async function fresh(machine: Machine, processes: boolean): Promise<void> {
    const state = stateFor(machine.id);
    // Waiters re-check after each pending read, so several detail requests
    // queued behind a plain read share one upgrade instead of each starting one.
    for (;;) {
      const maxAgeMs = deps.settings().refreshMs * REUSE_FRACTION;
      const latest = state.latest;
      if (
        latest !== null &&
        deps.now() - latest.takenAt < maxAgeMs &&
        (!processes || latest.processes !== null)
      ) {
        return;
      }
      const pending = state.pending;
      if (pending === null) break;
      await pending.promise.catch(() => undefined);
      if (state.error !== null && (!processes || pending.processes)) return;
    }
    const promise = deps.sampleMachine(machine.id, processes);
    state.pending = { processes, promise };
    try {
      record(state, await promise);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      state.error = `Could not read ${machine.name}: ${reason}`;
    } finally {
      if (state.pending?.promise === promise) state.pending = null;
    }
  }

  async function load(request: LoadRequest): Promise<LoadResult> {
    const machines = await deps.listMachines();
    const known = new Set(machines.map((machine) => machine.id));
    for (const id of states.keys()) if (!known.has(id)) states.delete(id);
    const machine =
      machines.find((candidate) => candidate.id === request.machineId) ??
      machines.find((candidate) => candidate.primary) ??
      machines.find((candidate) => candidate.connected) ??
      machines[0] ??
      null;
    const settings = deps.settings();
    if (machine === null) {
      return { machines, machineId: null, sample: null, history: [], error: "No machines are enrolled.", settings };
    }
    if (machine.connected) await fresh(machine, request.processes);
    const state = stateFor(machine.id);
    return {
      machines,
      machineId: machine.id,
      sample: state.latest,
      history: state.history.filter((point) => point.t > request.since),
      error: machine.connected ? state.error : `${machine.name} is offline.`,
      settings,
    };
  }

  return { load };
}
