/** Missing identity is a legacy/global invalidation, never proof of an unrelated change. */
function record(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : null;
}

export function changesPlan(payload: unknown, planId: string | null): boolean {
  const signal = record(payload);
  if (!signal || signal.global === true || typeof signal.id !== "string" || signal.id === "") return true;
  return signal.id === planId;
}

export function changesPlanList(payload: unknown, threadId: string): boolean {
  const signal = record(payload);
  if (!threadId || !signal || signal.global === true) return true;
  if (["threadId", "previousThreadId"].some(key => key in signal && signal[key] !== null
    && (typeof signal[key] !== "string" || signal[key] === ""))) return true;
  const identities = [signal.threadId, signal.previousThreadId]
    .filter((id): id is string | null => id === null || typeof id === "string" && id !== "");
  return identities.length === 0 || identities.includes(threadId);
}
