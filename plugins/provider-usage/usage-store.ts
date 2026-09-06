import { usageRpcSuccessSchema, type UsageSnapshot } from "./usage-schema.js";

interface UsageStoreSnapshot {
  data: UsageSnapshot | null;
  error: string | null;
  isRefreshing: boolean;
}

export function createUsageStore() {
  const storeListeners = new Set<() => void>();
  let storeSnapshot: UsageStoreSnapshot = {
    data: null,
    error: null,
    isRefreshing: false,
  };
  let activeRefreshCount = 0;
  let latestRequestId = 0;

  function updateStore(next: UsageStoreSnapshot): void {
    storeSnapshot = next;
    for (const listener of storeListeners) listener();
  }

  function subscribeStore(listener: () => void): () => void {
    storeListeners.add(listener);
    return () => storeListeners.delete(listener);
  }

  function getStoreSnapshot(): UsageStoreSnapshot {
    return storeSnapshot;
  }

  function rpcErrorMessage(body: unknown): string | null {
    if (typeof body !== "object" || body === null) return null;
    const error = Reflect.get(body, "error");
    if (typeof error === "string") return error;
    if (typeof error !== "object" || error === null) return null;
    const message = Reflect.get(error, "message");
    return typeof message === "string" ? message : null;
  }

  function refreshUsage({
    force,
    machineIds,
    maxAgeMs,
    signal,
  }: {
    force: boolean;
    machineIds: string[] | null;
    maxAgeMs: number;
    signal?: AbortSignal;
  }): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    const requestId = ++latestRequestId;
    activeRefreshCount += 1;
    updateStore({ ...storeSnapshot, error: null, isRefreshing: true });
    return (async () => {
      try {
        const response = await fetch(
          "/api/v1/plugins/erwin-provider-usage/rpc/getUsage",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ force, machineIds, maxAgeMs }),
            signal,
          },
        );
        const body: unknown = await response.json();
        if (signal?.aborted || requestId !== latestRequestId) return;
        const parsed = usageRpcSuccessSchema.safeParse(body);
        if (!response.ok || !parsed.success) {
          throw new Error(
            rpcErrorMessage(body) ?? "Provider usage could not be loaded.",
          );
        }
        updateStore({
          data: parsed.data.result,
          error: null,
          isRefreshing: activeRefreshCount > 1,
        });
      } catch (cause) {
        if (signal?.aborted || requestId !== latestRequestId) {
          return;
        }
        updateStore({
          ...storeSnapshot,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        activeRefreshCount -= 1;
        if (activeRefreshCount === 0 && storeSnapshot.isRefreshing) {
          updateStore({ ...storeSnapshot, isRefreshing: false });
        }
      }
    })();
  }

  return { subscribeStore, getStoreSnapshot, refreshUsage };
}
