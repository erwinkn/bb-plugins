// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planSchema } from "../contract";

const host = vi.hoisted(() => ({ call: vi.fn(), signal: (_payload: unknown) => {} }));
vi.mock("../hooks/usePlansApi", () => ({
  PLANS_CHANGED: "plans-changed", usePlansApi: () => host,
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (_channel: string, handler: typeof host.signal) => { host.signal = handler; },
}));
import { usePlan } from "../hooks/usePlan";
import { useDeliveryStatus } from "../hooks/useDeliveryStatus";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => host.call.mockReset());
afterEach(cleanup);

it("keeps a realtime version when an older mutation arrives and refetches", async () => {
  const old = planSchema.parse({ id: "p", title: "Plan", threadId: null, projectId: null, projectName: null, status: "open", createdAt: 1, updatedAt: 1,
    versions: [{ id: "v1", number: 1, markdown: "First", createdAt: 1 }] });
  const latest = { ...old, revision: 2, updatedAt: 1, versions: [...old.versions,
    { ...old.versions[0]!, id: "v2", number: 2, markdown: "Latest" }] };
  const realtime = deferred<typeof old>();
  const refresh = deferred<typeof old>();
  host.call.mockResolvedValueOnce(old).mockReturnValueOnce(realtime.promise).mockReturnValueOnce(refresh.promise);
  const hook = renderHook(() => usePlan("p"));
  await act(async () => {});
  const mutation = deferred<typeof old>();
  const applyMutation = mutation.promise.then(hook.result.current.apply);
  act(() => host.signal({ id: "p" }));
  await act(async () => { realtime.resolve(latest); });
  await act(async () => { mutation.resolve({ ...old, revision: 1, updatedAt: 1 }); await applyMutation; });
  expect(hook.result.current.plan).toEqual(latest);
  expect(host.call).toHaveBeenCalledTimes(3);
  await act(async () => { refresh.resolve(latest); });
  hook.unmount();
  act(() => hook.result.current.apply(old));
  expect(host.call).toHaveBeenCalledTimes(3);
});

it("filters other plans and coalesces delivery bursts into two request rounds", async () => {
  const first = deferred<never[]>();
  const second = deferred<never[]>();
  host.call.mockImplementation(() => first.promise);
  const hook = renderHook(() => useDeliveryStatus("p"));
  act(() => { for (let i = 0; i < 20; i++) host.signal({ id: "other" }); });
  await act(async () => { first.resolve([]); });
  expect(host.call).toHaveBeenCalledTimes(2);
  host.call.mockClear().mockImplementation(() => second.promise);
  act(() => { for (let i = 0; i < 20; i++) host.signal({ id: "p" }); });
  expect(host.call).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve([]); });
  expect(host.call).toHaveBeenCalledTimes(4);
  expect(hook.result.current.approvalState).toBe("pending");
});

it("cancels delivery results and the trailing refresh on unmount", async () => {
  const request = deferred<never[]>();
  host.call.mockReturnValue(request.promise);
  const hook = renderHook(() => useDeliveryStatus("p"));
  act(() => host.signal({ id: "p" }));
  hook.unmount();
  await act(async () => { request.resolve([]); });
  expect(host.call).toHaveBeenCalledTimes(2);
  expect(hook.result.current.approvalState).toBe("pending");
});

it("waits for both delivery calls before refreshing after failure or approval", async () => {
  const annotations = deferred<never[]>();
  host.call.mockImplementation((method) => method === "deliveryStatus"
    ? Promise.reject(new Error("Offline")) : annotations.promise);
  const hook = renderHook(({ status }) => useDeliveryStatus("p", status), { initialProps: { status: "open" } });
  await act(async () => {});
  hook.rerender({ status: "approved" });
  act(() => { for (let i = 0; i < 20; i++) host.signal({ id: "p" }); });
  expect(host.call).toHaveBeenCalledTimes(2);
  host.call.mockResolvedValue([]);
  await act(async () => { annotations.resolve([]); });
  expect(host.call).toHaveBeenCalledTimes(4);
  expect(hook.result.current.approvalState).toBe("pending");
});
