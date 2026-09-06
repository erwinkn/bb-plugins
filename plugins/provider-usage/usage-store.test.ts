import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageStore } from "./usage-store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(name: string) {
  return new Response(JSON.stringify({ ok: true, result: { machines: [{
    id: "machine", displayName: name, status: "connected", providers: [], error: null,
  }] } }), { status: 200 });
}

const request = { force: false, machineIds: null, maxAgeMs: 0 };
afterEach(() => vi.unstubAllGlobals());

describe("usage refresh ownership", () => {
  it("keeps the newer result when an older response arrives last", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const store = createUsageStore();
    const older = store.refreshUsage(request);
    const newer = store.refreshUsage(request);
    second.resolve(response("new"));
    await newer;
    first.resolve(response("old"));
    await older;
    expect(store.getStoreSnapshot().data?.machines[0]?.displayName).toBe("new");
    expect(store.getStoreSnapshot().isRefreshing).toBe(false);
  });

  it("does not replace the current error with an older success", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const store = createUsageStore();
    const older = store.refreshUsage(request);
    const newer = store.refreshUsage(request);
    second.reject(new Error("current failure"));
    await newer;
    first.resolve(response("old"));
    await older;
    expect(store.getStoreSnapshot().error).toBe("current failure");
    expect(store.getStoreSnapshot().data).toBeNull();
  });

  it("does not replace current data with an older error", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const store = createUsageStore();
    const older = store.refreshUsage(request);
    const newer = store.refreshUsage(request);
    second.resolve(response("new"));
    await newer;
    first.reject(new Error("old failure"));
    await older;
    expect(store.getStoreSnapshot().error).toBeNull();
    expect(store.getStoreSnapshot().data?.machines[0]?.displayName).toBe("new");
  });

  it("ignores a body that finishes parsing after cancellation", async () => {
    const body = deferred<unknown>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => body.promise }));
    const store = createUsageStore();
    const controller = new AbortController();
    const pending = store.refreshUsage({ ...request, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    body.resolve(await response("cancelled").json());
    await pending;
    expect(store.getStoreSnapshot()).toEqual({ data: null, error: null, isRefreshing: false });
  });

  it("does not issue an already-cancelled request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await createUsageStore().refreshUsage({ ...request, signal: controller.signal });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])("accepts an older background result when the newer request aborts %s it settles", async (order) => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const store = createUsageStore();
    const controller = new AbortController();
    const background = store.refreshUsage(request);
    const card = store.refreshUsage({ ...request, signal: controller.signal });
    if (order === "before") controller.abort();
    first.resolve(response("background"));
    await background;
    expect(store.getStoreSnapshot().data?.machines[0]?.displayName).toBe("background");
    controller.abort();
    second.reject(new DOMException("Cancelled", "AbortError"));
    await card;
    expect(store.getStoreSnapshot().data?.machines[0]?.displayName).toBe("background");
    expect(store.getStoreSnapshot().error).toBeNull();
    expect(store.getStoreSnapshot().isRefreshing).toBe(false);
  });

});
