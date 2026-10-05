import type { WarmingTimers } from "../warming.js";

// A manual clock for warming tests: timers fire only when a test advances time, in due order,
// with pending promise work flushed after each one.
export async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

export function fakeClock(start: number) {
  let now = start;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: WarmingTimers = {
    setTimeout(callback, milliseconds) {
      const id = nextId++;
      pending.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    pendingAt: () => [...pending.values()].map((timer) => timer.at - start),
    async advanceTo(offset: number) {
      const target = start + offset;
      while (true) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
        await flush();
      }
      now = Math.max(now, target);
      await flush();
    },
    jumpTo(offset: number) {
      now = start + offset;
    },
  };
}
