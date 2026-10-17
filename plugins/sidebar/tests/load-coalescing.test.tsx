// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import { buildThreadTree } from "../lib/thread-tree";
import { parseState, updateState } from "../lib/client-state";
import { thread } from "./fixtures";
import { READ_TIMEOUT_MS } from "../lib/read-timeout";

vi.mock("../lib/thread-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/thread-tree")>();
  return { ...actual, buildThreadTree: vi.fn(actual.buildThreadTree) };
});

const app = await loadPluginApp(() => import("../app"));
const { useArchives } = await import("../lib/use-archives");
const { useBranchPullRequestEligibility } = await import(
  "../lib/use-branch-pull-request-eligibility"
);
const { withQueries } = await import("../lib/queries");

const mounted: ReturnType<typeof renderSlot>[] = [];
const mount = <Props extends object>(
  component: ComponentType<Props>,
  props: Props,
  rpc: NonNullable<Parameters<typeof renderSlot>[2]>["rpc"],
) => {
  const slot = renderSlot({ component }, props, { rpc });
  mounted.push(slot);
  return slot;
};
// A query settles over a few macrotasks: its retry, then the batched notify.
const tick = () =>
  act(async () => {
    for (let hop = 0; hop < 8; hop++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
// A beat longer than the 250 ms debounce window.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

const archiveRow = (id: string) => ({
  id,
  projectId: "project-1",
  title: `Archived ${id}`,
  titleFallback: null,
  parentThreadId: null,
  providerId: "codex",
  createdAt: 1,
  updatedAt: 1,
  environmentId: null,
  environmentName: null,
  environmentBranchName: null,
  environmentWorkspaceDisplayKind: "other",
});

const ArchivesProbe = withQueries(function ArchivesProbe({ enabled }: { enabled: boolean }) {
  const { threads } = useArchives(enabled);
  return <>{threads.map((entry) => entry.id).join(",")}</>;
});

const EligibilityProbe = withQueries(function EligibilityProbe({ ids }: { ids: string[] }) {
  const eligible = useBranchPullRequestEligibility(ids);
  return <>{[...eligible.keys()].sort().join(",")}</>;
});

beforeEach(() => {
  window.localStorage.clear();
  updateState(() => parseState(null));
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  cleanup();
  await tick();
});

describe("archive loading", () => {
  it("coalesces a burst of archive signals into one pagination", async () => {
    const listArchived = vi.fn(async () => [archiveRow("old")]);
    const slot = mount(ArchivesProbe, { enabled: true }, { listArchived });
    await waitFor(() => expect(listArchived).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(slot.container.textContent).toBe("old"));
    // Five signals inside one debounce window reload once, not five times.
    for (let i = 0; i < 5; i++)
      await slot.behavior.emitRealtime("archives-changed", {});
    expect(listArchived).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listArchived).toHaveBeenCalledTimes(2));
    // A later, separate signal still refetches.
    await slot.behavior.emitRealtime("archives-changed", {});
    await waitFor(() => expect(listArchived).toHaveBeenCalledTimes(3));
  });

  it("gives up on a page that never answers, so the next read can run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listArchived = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue([archiveRow("old")]);
      const slot = mount(ArchivesProbe, { enabled: true }, { listArchived });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 100);
      });
      // Its quiet retry answers.
      await waitFor(() => expect(slot.container.textContent).toBe("old"));
      expect(listArchived).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops paging when the list closes mid-read, keeping the last complete list", async () => {
    const full = Array.from({ length: 200 }, (_, n) => archiveRow(`a${n}`));
    let release!: (page: unknown) => void;
    const listArchived = vi
      .fn()
      .mockResolvedValueOnce([archiveRow("old")])
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValue([]);
    const slot = mount(ArchivesProbe, { enabled: true }, { listArchived });
    await waitFor(() => expect(slot.container.textContent).toBe("old"));
    await slot.behavior.emitRealtime("archives-changed", {});
    await waitFor(() => expect(listArchived).toHaveBeenCalledTimes(2));
    slot.rerender(<ArchivesProbe enabled={false} />);
    await act(async () => release(full));
    await settle();
    // Page 0 answered a full page, but the closed list asks for no more.
    expect(listArchived).toHaveBeenCalledTimes(2);
    slot.rerender(<ArchivesProbe enabled />);
    expect(slot.container.textContent).toBe("old");
  });

  it("ignores signals while disabled and loads once when enabled", async () => {
    const listArchived = vi.fn(async () => [archiveRow("old")]);
    const slot = mount(ArchivesProbe, { enabled: false }, { listArchived });
    await slot.behavior.emitRealtime("archives-changed", {});
    await settle();
    expect(listArchived).not.toHaveBeenCalled();
    slot.rerender(<ArchivesProbe enabled />);
    await waitFor(() => expect(listArchived).toHaveBeenCalledTimes(1));
    expect(slot.container.textContent).toBe("old");
  });
});

describe("branch pull request eligibility reconcile", () => {
  it("coalesces a burst of id-set changes into one bulk call", async () => {
    const branchPullRequestEligibility = vi.fn(async (input: unknown) => ({
      eligible: Object.fromEntries(
        (input as { threadIds: string[] }).threadIds
          .filter((id) => id === "c")
          .map((id) => [id, true]),
      ),
    }));
    const slot = mount(
      EligibilityProbe,
      { ids: ["a"] },
      { branchPullRequestEligibility },
    );
    await waitFor(() =>
      expect(branchPullRequestEligibility).toHaveBeenCalledTimes(1),
    );
    expect(branchPullRequestEligibility).toHaveBeenLastCalledWith({
      threadIds: ["a"],
    });
    // A burst of list updates settles into one call with the latest ids.
    slot.rerender(<EligibilityProbe ids={["a", "b"]} />);
    slot.rerender(<EligibilityProbe ids={["a", "b", "c"]} />);
    slot.rerender(<EligibilityProbe ids={["b", "c"]} />);
    expect(branchPullRequestEligibility).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(branchPullRequestEligibility).toHaveBeenCalledTimes(2),
    );
    expect(branchPullRequestEligibility).toHaveBeenLastCalledWith({
      threadIds: ["b", "c"],
    });
    await waitFor(() => expect(slot.container.textContent).toBe("c"));
    // A reordered identical set does not refetch.
    slot.rerender(<EligibilityProbe ids={["c", "b"]} />);
    await settle();
    expect(branchPullRequestEligibility).toHaveBeenCalledTimes(2);
  });
});

describe("branch pull request eligibility input", () => {
  it("never calls with no ids", async () => {
    const branchPullRequestEligibility = vi.fn(async () => ({ eligible: {} }));
    mount(EligibilityProbe, { ids: [] }, { branchPullRequestEligibility });
    await settle();
    await tick();
    expect(branchPullRequestEligibility).not.toHaveBeenCalled();
  });

  it("splits more than 1,000 ids into calls the contract accepts", async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `t${String(i).padStart(4, "0")}`);
    const branchPullRequestEligibility = vi.fn(async (input: unknown) => ({
      eligible: Object.fromEntries(
        (input as { threadIds: string[] }).threadIds
          .filter((id) => id === "t2400")
          .map((id) => [id, true]),
      ),
    }));
    const slot = mount(EligibilityProbe, { ids }, { branchPullRequestEligibility });
    await waitFor(() => expect(slot.container.textContent).toBe("t2400"));
    const calls = branchPullRequestEligibility.mock.calls.map(
      ([input]) => (input as unknown as { threadIds: string[] }).threadIds,
    );
    expect(calls.map((chunk) => chunk.length)).toEqual([1000, 1000, 500]);
    expect(calls.flat().sort()).toEqual(ids);
  });
});

describe("branch pull request eligibility revalidation", () => {
  it("reads a set seen before again, showing its last answer meanwhile", async () => {
    let aEligible = false;
    const branchPullRequestEligibility = vi.fn(async (input: unknown) => ({
      eligible: Object.fromEntries(
        (input as { threadIds: string[] }).threadIds.map((id) => [id, id === "a" ? aEligible : true]),
      ),
    }));
    const Probe = withQueries(function Probe({ ids }: { ids: string[] }) {
      const eligible = useBranchPullRequestEligibility(ids);
      return <>{String(eligible.get("a"))}</>;
    });
    const slot = mount(Probe, { ids: ["a"] }, { branchPullRequestEligibility });
    await waitFor(() => expect(slot.container.textContent).toBe("false"));
    // Thread a's checkout changes; the next set's answer says so.
    aEligible = true;
    slot.rerender(<Probe ids={["a", "b"]} />);
    await waitFor(() => expect(slot.container.textContent).toBe("true"));
    slot.rerender(<Probe ids={["a"]} />);
    await waitFor(() => expect(branchPullRequestEligibility).toHaveBeenCalledTimes(3));
    await settle();
    expect(slot.container.textContent).toBe("true");
  });
});

describe("branch pull request eligibility after a failed read", () => {
  it("keeps the last answer when a changed set's read fails", async () => {
    const branchPullRequestEligibility = vi
      .fn()
      .mockResolvedValueOnce({ eligible: { a: false } })
      .mockRejectedValue(new Error("down"));
    const Probe = withQueries(function Probe({ ids }: { ids: string[] }) {
      const eligible = useBranchPullRequestEligibility(ids);
      return <>{String(eligible.get("a"))}</>;
    });
    const slot = mount(Probe, { ids: ["a"] }, { branchPullRequestEligibility });
    await waitFor(() => expect(slot.container.textContent).toBe("false"));
    slot.rerender(<Probe ids={["a", "b"]} />);
    // The read and its quiet retry fail.
    await waitFor(() => expect(branchPullRequestEligibility).toHaveBeenCalledTimes(3));
    await settle();
    expect(slot.container.textContent).toBe("false");
  });
});

describe("branch pull request eligibility when a set returns", () => {
  it("keeps the newest answer when a returning set's read fails", async () => {
    const branchPullRequestEligibility = vi
      .fn()
      .mockResolvedValueOnce({ eligible: { a: false } })
      .mockResolvedValueOnce({ eligible: { a: true, b: true } })
      .mockRejectedValue(new Error("down"));
    const Probe = withQueries(function Probe({ ids }: { ids: string[] }) {
      const eligible = useBranchPullRequestEligibility(ids);
      return <>{String(eligible.get("a"))}</>;
    });
    const slot = mount(Probe, { ids: ["a"] }, { branchPullRequestEligibility });
    await waitFor(() => expect(slot.container.textContent).toBe("false"));
    slot.rerender(<Probe ids={["a", "b"]} />);
    await waitFor(() => expect(slot.container.textContent).toBe("true"));
    // Back to {a}: its cached answer is older, and both reads of it fail.
    slot.rerender(<Probe ids={["a"]} />);
    await waitFor(() => expect(branchPullRequestEligibility).toHaveBeenCalledTimes(4));
    await settle();
    expect(slot.container.textContent).toBe("true");
  });
});

describe("branch pull request eligibility from an abandoned set", () => {
  it("drops a late answer for a set the list moved away from", async () => {
    let late!: (value: unknown) => void;
    const branchPullRequestEligibility = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (late = resolve)))
      .mockResolvedValueOnce({ eligible: { a: true, b: true } })
      .mockRejectedValue(new Error("down"));
    const Probe = withQueries(function Probe({ ids }: { ids: string[] }) {
      const eligible = useBranchPullRequestEligibility(ids);
      return <>{String(eligible.get("a"))}</>;
    });
    const slot = mount(Probe, { ids: ["a"] }, { branchPullRequestEligibility });
    await waitFor(() => expect(branchPullRequestEligibility).toHaveBeenCalledTimes(1));
    slot.rerender(<Probe ids={["a", "b"]} />);
    await waitFor(() => expect(slot.container.textContent).toBe("true"));
    // {a}'s slow read answers only now, after {a,b}'s.
    await act(async () => late({ eligible: { a: false } }));
    await settle();
    expect(slot.container.textContent).toBe("true");
    // Back to {a}: nothing late was cached for it, and both its reads fail.
    slot.rerender(<Probe ids={["a"]} />);
    await waitFor(() => expect(branchPullRequestEligibility).toHaveBeenCalledTimes(4));
    await settle();
    expect(slot.container.textContent).toBe("true");
  });
});

describe("thread tree memoization", () => {
  const props = {
    activeThreadId: null,
    activeProjectId: "project-1",
    isCompactViewport: false,
    searchQuery: "",
    onNavigate: vi.fn(),
    Original: () => <p>BB fallback</p>,
  };
  const rpc = {
    listArchived: async () => [],
    archiveTree: async () => ({ ok: true }),
    getSnoozes: async () => ({ revision: 0, entries: [] }),
    getSnoozePresets: async () => ({ revision: 0, presets: [] }),
    branchPullRequestEligibility: async () => ({ eligible: {} }),
  };
  const projects = [
    { id: "project-1", name: "One", isPersonal: false },
    { id: "project-2", name: "Two", isPersonal: false },
  ];
  it.each(["status", "project"] as const)(
    "does not rebuild trees on an unrelated re-render in %s view",
    async (groupBy) => {
      updateState((state) => ({ ...state, groupBy }));
      const threads = [
        thread({ id: "parent", title: "Parent", indicator: "runtime" }),
        thread({
          id: "child",
          title: "Child",
          parentThreadId: "parent",
          isUnread: true,
        }),
        thread({ id: "other", title: "Other", projectId: "project-2" }),
      ];
      const slot = renderSlot(app.threadLists[0], props, {
        sidebarThreads: { threads, projects },
        rpc,
      });
      mounted.push(slot);
      await tick();
      await tick();
      const calls = vi.mocked(buildThreadTree).mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      const Component = app.threadLists[0].component;
      slot.rerender(<Component {...props} />);
      await act(async () => {});
      expect(vi.mocked(buildThreadTree).mock.calls.length).toBe(calls);
    },
  );
});
