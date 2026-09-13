import { describe, expect, it } from "vitest";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  attentionWorthyPullRequest,
  mergePullRequests,
  pullRequestKey,
  pullRequestRepo,
} from "../components/pull-request";
import {
  LINKED_PULL_REQUESTS_CHANNEL,
  readLinkedPullRequests,
  type LinkedPullRequest,
} from "../lib/pull-requests-schema";

const branch = (
  overrides: Partial<PluginSidebarPullRequest> = {},
): PluginSidebarPullRequest => ({
  number: 1,
  title: "Branch PR",
  url: "https://github.com/acme/widgets/pull/1",
  state: "open",
  attention: "none",
  ...overrides,
});

const link = (overrides: Partial<LinkedPullRequest> = {}): LinkedPullRequest => ({
  repo: "acme/widgets",
  number: 1,
  url: "https://github.com/acme/widgets/pull/1",
  title: "Linked PR",
  state: "open",
  ...overrides,
});

describe("readLinkedPullRequests", () => {
  it("drops malformed entries and defaults missing fields", () => {
    expect(
      readLinkedPullRequests([
        { repo: "acme/widgets", number: 1, url: "https://github.com/acme/widgets/pull/1" },
        { repo: "acme/widgets", number: "2", url: "https://x" },
        { repo: "acme/widgets", url: "https://x" },
        { number: 2, url: "https://x" },
        { repo: "", number: 2, url: "https://x" },
        { repo: "acme/widgets", number: 0, url: "https://x" },
        "nope",
        null,
      ]),
    ).toEqual([
      {
        repo: "acme/widgets",
        number: 1,
        url: "https://github.com/acme/widgets/pull/1",
        title: null,
        state: null,
      },
    ]);
    expect(readLinkedPullRequests(undefined)).toEqual([]);
    expect(readLinkedPullRequests({ pullRequests: [] })).toEqual([]);
  });
});

describe("mergePullRequests", () => {
  it("dedupes the branch PR against its linked copy by URL", () => {
    expect(
      mergePullRequests(branch(), [
        link(), // same url, older metadata copy
        link({
          repo: "other/repo",
          number: 9,
          url: "https://github.com/other/repo/pull/9",
        }),
      ]),
    ).toEqual([
      branch(),
      expect.objectContaining({
        number: 9,
        title: "Linked PR",
        state: "open",
        attention: "none",
      }),
    ]);
  });

  it("lists metadata links on their own and normalizes state and title", () => {
    expect(
      mergePullRequests(null, [
        link({ state: "MERGED" }),
        link({
          repo: "other/repo",
          number: 9,
          url: "https://github.com/other/repo/pull/9",
          title: null,
          state: null,
        }),
        link({
          repo: "third/repo",
          number: 3,
          url: "https://github.com/third/repo/pull/3",
          state: "not-a-state",
        }),
      ]),
    ).toEqual([
      expect.objectContaining({ state: "merged", attention: "none" }),
      expect.objectContaining({
        state: "open",
        title: "other/repo#9",
      }),
      expect.objectContaining({ state: "open" }),
    ]);
  });
});

describe("attentionWorthyPullRequest", () => {
  it("ranks needs-you open, then open, draft, merged, closed", () => {
    const merged = branch({ state: "merged" });
    const closed = branch({ state: "closed" });
    const open = branch({ state: "open" });
    const draft = branch({ state: "draft" });
    const needsYou = branch({ state: "open", attention: "checks_failed" });
    expect(attentionWorthyPullRequest([merged, open, closed])).toBe(open);
    expect(attentionWorthyPullRequest([merged, needsYou, open])).toBe(
      needsYou,
    );
    expect(attentionWorthyPullRequest([merged, draft])).toBe(draft);
    expect(attentionWorthyPullRequest([closed, merged])).toBe(merged);
    expect(attentionWorthyPullRequest([])).toBeNull();
  });
});

describe("pull request URLs", () => {
  it("derives repo and a stable dedupe key", () => {
    expect(pullRequestRepo("https://github.com/acme/widgets/pull/7")).toBe(
      "acme/widgets",
    );
    expect(pullRequestRepo("https://example.com/pr/7")).toBeNull();
    expect(
      pullRequestKey("https://github.com/Acme/Widgets/pull/7?diff=split"),
    ).toBe("acme/widgets#7");
    expect(pullRequestKey("https://example.com/x")).toBe(
      "https://example.com/x",
    );
  });
});

describe("pull requests RPC", () => {
  it("reads github-prs metadata in bulk and republishes change bumps", async () => {
    const metadata: Record<string, Record<string, unknown>> = {
      "thr-a": {
        pullRequests: [
          link(),
          { repo: "acme/widgets", number: 2, url: "https://x", extra: 1 },
        ],
      },
      "thr-b": { pullRequests: [] },
      "thr-c": {},
    };
    const h = createFakePluginHost({
      pluginId: "sidebar",
      sdk: {
        threads: {
          getPluginMetadata: async ({
            threadId,
            pluginId,
          }: {
            threadId: string;
            pluginId?: string;
          }) => {
            if (threadId === "thr-missing") throw new Error("gone");
            expect(pluginId).toBe("github-prs");
            return metadata[threadId] ?? {};
          },
        },
      },
    });
    plugin(h.bb);
    try {
      const result = (await h.harness.behavior.callRpc(
        "linkedPullRequests",
        { threadIds: ["thr-a", "thr-b", "thr-c", "thr-missing", "thr-a"] },
      )) as { pullRequests: Record<string, LinkedPullRequest[]> };
      expect(Object.keys(result.pullRequests)).toEqual(["thr-a"]);
      expect(result.pullRequests["thr-a"]).toEqual([
        link(),
        expect.objectContaining({
          repo: "acme/widgets",
          number: 2,
          url: "https://x",
          title: null,
          state: null,
        }),
      ]);

      expect(
        await h.harness.behavior.callRpc("pullRequestsChanged", {
          threadId: "thr-a",
        }),
      ).toEqual({ ok: true });
      expect(h.harness.inspection.realtimeSignals).toContainEqual({
        channel: LINKED_PULL_REQUESTS_CHANNEL,
        payload: { threadId: "thr-a" },
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
