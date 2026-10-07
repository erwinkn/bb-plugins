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

vi.mock("../lib/thread-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/thread-tree")>();
  return { ...actual, buildThreadTree: vi.fn(actual.buildThreadTree) };
});

const app = await loadPluginApp(() => import("../app"));
const { useArchives } = await import("../lib/use-archives");
const { useBranchPullRequestEligibility } = await import(
  "../lib/use-branch-pull-request-eligibility"
);

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
const tick = () =>
  act(async () => {
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

function ArchivesProbe({ enabled }: { enabled: boolean }) {
  const { threads } = useArchives(enabled);
  return <>{threads.map((entry) => entry.id).join(",")}</>;
}

function EligibilityProbe({ ids }: { ids: string[] }) {
  const eligible = useBranchPullRequestEligibility(ids);
  return <>{[...eligible.keys()].sort().join(",")}</>;
}

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
    getSpaces: async () => ({ revision: 0, spaces: [] }),
    getLibrary: async () => ({ revision: 0, ids: [] }),
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
