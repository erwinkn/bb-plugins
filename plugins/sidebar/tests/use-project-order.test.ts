// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useProjectOrder } from "../lib/use-project-order";
import type { ProjectOrderDoc } from "../lib/project-order-schema";

const doc = (revision: number, order: string[]): ProjectOrderDoc => ({
  revision,
  order,
});

const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

interface Call {
  name: string;
  args: unknown;
}

/**
 * The hook's state machine is what realtime, queued saves, and syncs share.
 * These cases replay the races a review caught by isolating call order.
 */
describe("useProjectOrder", () => {
  it("keeps a newer queued move when an earlier save's ack arrives", async () => {
    const first = deferred();
    const calls: Call[] = [];
    const api = {
      call: (name: string, args: unknown) => {
        calls.push({ name, args });
        if (name !== "saveProjectOrder") return Promise.resolve(null);
        if (calls.filter((c) => c.name === "saveProjectOrder").length === 1)
          return first.promise;
        const { expectedRevision, order } = args as {
          expectedRevision: number;
          order: string[];
        };
        return Promise.resolve({ revision: expectedRevision + 1, order });
      },
    };
    const h = renderHook(() =>
      useProjectOrder(api as never),
    );
    await act(async () =>
      h.result.current.applySnapshot(doc(1, ["a", "b", "c"])),
    );
    await act(async () => h.result.current.commit(["b", "a", "c"]));
    await act(async () => h.result.current.commit(["b", "c", "a"]));
    // The realtime publication of save 1 must not erase the queued move.
    await act(async () =>
      h.result.current.applySnapshot(doc(2, ["b", "a", "c"])),
    );
    expect(h.result.current.order).toEqual(["b", "c", "a"]);
    await act(async () => first.resolve(doc(2, ["b", "a", "c"])));
    await tick();
    // The rebased intent saved again on the fresh base.
    expect(h.result.current.order).toEqual(["b", "c", "a"]);
    expect(calls.filter((c) => c.name === "saveProjectOrder")).toHaveLength(2);
    expect(calls[1].args).toEqual({
      expectedRevision: 2,
      order: ["b", "c", "a"],
    });
    expect(h.result.current.error).toBeNull();
    h.unmount();
  });

  it("ignores a save reply that is older than an observed document", async () => {
    const first = deferred();
    const api = {
      call: (name: string) =>
        name === "saveProjectOrder" ? first.promise : Promise.resolve(null),
    };
    const h = renderHook(() => useProjectOrder(api as never));
    await act(async () =>
      h.result.current.applySnapshot(doc(1, ["a", "b", "c"])),
    );
    await act(async () => h.result.current.commit(["b", "a", "c"]));
    // Realtime delivers our own ack plus a newer foreign doc before the save
    // reply lands.
    await act(async () =>
      h.result.current.applySnapshot(doc(2, ["b", "a", "c"])),
    );
    await act(async () =>
      h.result.current.applySnapshot(doc(3, ["c", "b", "a"])),
    );
    expect(h.result.current.order).toEqual(["c", "b", "a"]);
    await act(async () => first.resolve(doc(2, ["b", "a", "c"])));
    await tick();
    expect(h.result.current.order).toEqual(["c", "b", "a"]);
    expect(h.result.current.error).toBeNull();
    h.unmount();
  });

  it("retries a failed move when a sync adds a project", async () => {
    let saves = 0;
    const api = {
      call: (name: string) => {
        if (name === "saveProjectOrder") {
          saves++;
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve({ order: doc(1, ["a", "b"]) });
      },
    };
    const h = renderHook(() => useProjectOrder(api as never));
    await act(async () =>
      h.result.current.applySnapshot(doc(1, ["a", "b"])),
    );
    await act(async () => h.result.current.commit(["b", "a"]));
    await tick();
    expect(h.result.current.order).toEqual(["b", "a"]);
    expect(h.result.current.error).toContain("offline");
    // The new-project sync keeps the failed intent on screen and retries it.
    await act(async () =>
      h.result.current.applySnapshot(doc(2, ["a", "b", "new"])),
    );
    await tick();
    expect(h.result.current.order).toEqual(["b", "a", "new"]);
    expect(saves).toBe(2);
    expect(h.result.current.error).toContain("offline");
    h.unmount();
  });

  it("chains a commit made after an earlier save's ack", async () => {
    const first = deferred();
    const calls: Call[] = [];
    const api = {
      call: (name: string, args: unknown) => {
        calls.push({ name, args });
        if (name !== "saveProjectOrder") return Promise.resolve(null);
        if (calls.filter((c) => c.name === "saveProjectOrder").length === 1)
          return first.promise;
        const { expectedRevision, order } = args as {
          expectedRevision: number;
          order: string[];
        };
        return Promise.resolve({
          revision: expectedRevision + 1,
          order,
        });
      },
    };
    const h = renderHook(() => useProjectOrder(api as never));
    await act(async () =>
      h.result.current.applySnapshot(doc(1, ["a", "b", "c"])),
    );
    await act(async () => h.result.current.commit(["b", "a", "c"]));
    await act(async () => first.resolve(doc(2, ["b", "a", "c"])));
    await tick();
    expect(h.result.current.order).toEqual(["b", "a", "c"]);
    // A commit after the ack is a fresh intent on the new base.
    await act(async () => h.result.current.commit(["c", "a", "b"]));
    await tick();
    expect(h.result.current.order).toEqual(["c", "a", "b"]);
    const saves = calls.filter((c) => c.name === "saveProjectOrder");
    expect(saves).toHaveLength(2);
    expect(saves[1].args).toEqual({
      expectedRevision: 2,
      order: ["c", "a", "b"],
    });
    h.unmount();
  });

  it("keeps an unsynced new project in its requested pending position", async () => {
    const api = {
      call: (name: string) =>
        name === "projectMode"
          ? Promise.resolve({ order: doc(1, ["a", "b"]) })
          : Promise.reject(new Error("offline")),
    };
    const h = renderHook(() => useProjectOrder(api as never));
    await act(async () =>
      h.result.current.applySnapshot(doc(1, ["a", "b"])),
    );
    // The sync failed before "new" entered the doc, but it is a visible row.
    await act(async () =>
      h.result.current.applySnapshot(null, "Could not sync: offline"),
    );
    await act(async () => h.result.current.commit(["new", "a", "b"]));
    await tick();
    // The pending sequence is shown verbatim — the unsynced id keeps its
    // requested slot instead of falling back to the tree's tail position.
    expect(h.result.current.order).toEqual(["new", "a", "b"]);
    expect(h.result.current.error).toBe("offline");
    h.unmount();
  });
});
