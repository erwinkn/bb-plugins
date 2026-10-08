import { useCallback, useRef, useState } from "react";
import { WRITE_SLOW_MS } from "./lib/write-timeout";

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * W239: one dashboard write's state, so a slow write says so instead of only spinning: busy,
 * then slow after WRITE_SLOW_MS. A write with no answer at all ends in the
 * WriteUnconfirmedError its RPC call raises (withWriteTimeout), shown like any error.
 */
export function useWrite() {
  const [phase, setPhase] = useState<"idle" | "busy" | "slow">("idle");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    const id = ++latest.current;
    const current = () => latest.current === id;
    setPhase("busy");
    setError(null);
    const slow = setTimeout(() => current() && setPhase("slow"), WRITE_SLOW_MS);
    try {
      return { ok: true, value: await work() };
    } catch (e) {
      if (current()) setError(text(e));
      return { ok: false };
    } finally {
      clearTimeout(slow);
      if (current()) setPhase("idle");
    }
  }, []);
  return { busy: phase !== "idle", slow: phase === "slow", error, setError, run };
}
