// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planSchema } from "../contract";
import { changesPlanList } from "../lib/change-signal";

const host = vi.hoisted(() => ({ call: vi.fn(), signal: (_payload: unknown) => {} }));
vi.mock("../hooks/usePlansApi", () => ({ PLANS_CHANGED: "plans-changed", PLANS_PAGE_SIZE: 10, usePlansApi: () => host }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRealtime: (_channel: string, handler: typeof host.signal) => { host.signal = handler; } }));
import { usePlan } from "../hooks/usePlan";
import { usePlanList } from "../hooks/usePlanList";

beforeEach(() => { host.call.mockReset(); });
afterEach(cleanup);
const plans = Array.from({ length: 23 }, (_, i) => planSchema.parse({ id: `p${i}`, title: `Plan ${i}`, threadId: "target", projectId: null, projectName: null, status: "open", createdAt: 1, updatedAt: 100 - i,
  versions: [{ id: `v${i}`, number: 1, markdown: "Plan", createdAt: 1 }] }));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it("single-plan reads ignore unrelated IDs and accept matching, legacy and explicit global signals", async () => {
  host.call.mockResolvedValue(plans[0]);
  renderHook(() => usePlan("p0")); await act(async () => {});
  await act(async () => { host.signal({ id: "other", threadId: "target" }); });
  expect(host.call).toHaveBeenCalledTimes(1);
  for (const payload of [{ id: "p0" }, {}, null, { id: "other", global: true }]) {
    await act(async () => { host.signal(payload); });
  }
  expect(host.call).toHaveBeenCalledTimes(5);
});

it("lists use current/prior thread identity with conservative legacy and global fallback", async () => {
  host.call.mockResolvedValue(plans.slice(0, 3));
  renderHook(() => usePlanList("target")); await act(async () => {});
  for (const payload of [{ id: "other", threadId: "other" }, { id: "sample", threadId: null }]) {
    await act(async () => { host.signal(payload); });
  }
  expect(host.call).toHaveBeenCalledTimes(1);
  for (const payload of [{ id: "p", threadId: "target" }, { id: "p", threadId: "other", previousThreadId: "target" }, { id: "deleted", previousThreadId: "target" }, { id: "legacy" }, {}, { global: true, threadId: "other" }]) {
    await act(async () => { host.signal(payload); });
  }
  expect(host.call).toHaveBeenCalledTimes(7);
  expect(changesPlanList({ threadId: "other" }, "")).toBe(true);
  expect(changesPlanList({ threadId: 123 }, "target")).toBe(true);
  expect(changesPlanList({ threadId: "other", previousThreadId: 123 }, "target")).toBe(true);
});

it("global list views omit the thread predicate and refresh for any scoped change", async () => {
  host.call.mockResolvedValue(plans.slice(0, 3));
  renderHook(() => usePlanList("")); await act(async () => {});
  expect(host.call).toHaveBeenLastCalledWith("list", { offset: 0 });
  await act(async () => { host.signal({ id: "other", threadId: "other" }); });
  expect(host.call).toHaveBeenCalledTimes(2);
});

it("appends only the next page, prevents double append, and refreshes the opened range", async () => {
  host.call.mockImplementation(async (_method, input) => plans.slice(input.offset, input.offset + 10));
  const hook = renderHook(() => usePlanList("target")); await act(async () => {});
  await act(async () => { hook.result.current.loadMore(); hook.result.current.loadMore(); });
  expect(host.call.mock.calls.map(([, input]) => input.offset)).toEqual([0, 10]);
  expect(hook.result.current.plans).toHaveLength(20);
  await act(async () => { hook.result.current.loadMore(); });
  expect(host.call.mock.calls.map(([, input]) => input.offset)).toEqual([0, 10, 20]);
  expect(hook.result.current.plans).toEqual(plans);
  expect(hook.result.current.hasMore).toBe(false);
  await act(async () => { host.signal({ id: "p0", threadId: "target" }); });
  expect(host.call.mock.calls.map(([, input]) => input.offset)).toEqual([0, 10, 20, 0, 10, 20]);
});

it("a matching change invalidates an older append response", async () => {
  const append = deferred<typeof plans>();
  const latest = [{ ...plans[0]!, id: "new", updatedAt: 101 }, ...plans.slice(0, 9)];
  host.call.mockResolvedValueOnce(plans.slice(0, 10)).mockReturnValueOnce(append.promise).mockResolvedValueOnce(latest);
  const hook = renderHook(() => usePlanList("target")); await act(async () => {});
  act(() => hook.result.current.loadMore());
  await act(async () => { host.signal({ id: "new", threadId: "target" }); });
  await act(async () => { append.resolve(plans.slice(10, 20)); });
  expect(hook.result.current.plans).toEqual(latest);
  expect(hook.result.current.isLoadingMore).toBe(false);
});

it.each([
  ["overlap", plans.slice(9, 19)],
  ["duplicates within a page", [plans[10]!, plans[10]!, ...plans.slice(11, 19)]],
  ["newer rows", [{ ...plans[10]!, updatedAt: 101 }, ...plans.slice(11, 20)]],
])("reconciles %s instead of appending duplicates or out-of-order rows", async (_kind, batch) => {
  host.call.mockResolvedValueOnce(plans.slice(0, 10)).mockResolvedValueOnce(batch)
    .mockResolvedValueOnce(plans.slice(0, 10)).mockResolvedValueOnce(plans.slice(10, 20));
  const hook = renderHook(() => usePlanList("target")); await act(async () => {});
  await act(async () => { hook.result.current.loadMore(); });
  expect(host.call.mock.calls.map(([, input]) => input.offset)).toEqual([0, 10, 0, 10]);
  expect(hook.result.current.plans).toEqual(plans.slice(0, 20));
  expect(hook.result.current.isLoadingMore).toBe(false);
});

it("failed appends keep existing pages and retry the same offset", async () => {
  host.call.mockResolvedValueOnce(plans.slice(0, 10)).mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(plans.slice(10, 20));
  const hook = renderHook(() => usePlanList("target")); await act(async () => {});
  await act(async () => { hook.result.current.loadMore(); });
  expect(hook.result.current.error).toBe("Offline");
  expect(hook.result.current.plans).toEqual(plans.slice(0, 10));
  await act(async () => { hook.result.current.loadMore(); });
  expect(host.call.mock.calls.map(([, input]) => input.offset)).toEqual([0, 10, 10]);
  expect(hook.result.current.error).toBeNull();
});

it("thread changes and unmount discard old replies without further paging", async () => {
  const old = deferred<typeof plans>();
  host.call.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ ...plans[0]!, id: "other-plan", threadId: "other" }]);
  const hook = renderHook(({ threadId }) => usePlanList(threadId), { initialProps: { threadId: "target" } });
  hook.rerender({ threadId: "other" }); await act(async () => {});
  await act(async () => { old.reject(new Error("Old failure")); });
  expect(hook.result.current.plans?.[0]?.id).toBe("other-plan");
  expect(hook.result.current.error).toBeNull();
  const refresh = deferred<typeof plans>(); host.call.mockReturnValueOnce(refresh.promise);
  act(() => hook.result.current.refetch()); hook.unmount();
  await act(async () => { refresh.resolve(plans); });
  expect(host.call).toHaveBeenCalledTimes(3);
});
