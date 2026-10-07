import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { isBranchPullRequestEnvironment } from "../lib/branch-pull-request";

describe("isBranchPullRequestEnvironment", () => {
  it("accepts a dedicated worktree on a feature branch only", () => {
    const worktree = { isWorktree: true, branchName: "feature", defaultBranch: "main" };
    expect(isBranchPullRequestEnvironment(worktree)).toBe(true);
    // A shared project checkout's branch moves independently of its threads.
    expect(isBranchPullRequestEnvironment({ ...worktree, isWorktree: false })).toBe(false);
    expect(isBranchPullRequestEnvironment({ ...worktree, branchName: "main" })).toBe(false);
    expect(isBranchPullRequestEnvironment({ ...worktree, branchName: null })).toBe(false);
    expect(isBranchPullRequestEnvironment({ ...worktree, defaultBranch: null })).toBe(true);
  });
});

describe("branch pull request eligibility RPC", () => {
  it("marks threads on a shared checkout or default branch as ineligible", async () => {
    const environmentOf: Record<string, string | null> = {
      "thr-shared": "env-shared",
      "thr-default": "env-default",
      "thr-worktree": "env-worktree",
      "thr-sibling": "env-worktree",
      "thr-none": null,
      "thr-missing": "env-worktree",
    };
    const environments: Record<string, { isWorktree: boolean; branchName: string | null; defaultBranch: string | null }> = {
      "env-shared": { isWorktree: false, branchName: "dev", defaultBranch: "dev" },
      "env-default": { isWorktree: true, branchName: "main", defaultBranch: "main" },
      "env-worktree": { isWorktree: true, branchName: "feature", defaultBranch: "main" },
    };
    const environmentReads: string[] = [];
    const h = createFakePluginHost({
      pluginId: "sidebar",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr-missing") throw new Error("gone");
            return { id: threadId, environmentId: environmentOf[threadId] ?? null };
          },
        },
        environments: {
          get: async ({ environmentId }: { environmentId: string }) => {
            environmentReads.push(environmentId);
            return { id: environmentId, ...environments[environmentId] };
          },
        },
      },
    });
    plugin(h.bb);
    try {
      const result = (await h.harness.behavior.callRpc("branchPullRequestEligibility", {
        threadIds: [...Object.keys(environmentOf), "thr-shared"],
      })) as { eligible: Record<string, boolean> };
      // No environment and a deleted thread stay absent: their rows keep
      // showing whatever branch PR BB reports.
      expect(result.eligible).toEqual({
        "thr-shared": false,
        "thr-default": false,
        "thr-worktree": true,
        "thr-sibling": true,
      });
      // Threads on the same environment share one lookup.
      expect(environmentReads.filter((id) => id === "env-worktree")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
