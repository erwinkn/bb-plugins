import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { PULL_REQUESTS_CHANGED } from "../contract";

let binDir: string;
const originalPath = process.env.PATH;

type PullOutcome =
  | { outcome: "available"; pullRequest: { url: string; title: string; state: string } }
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string };

function fakeGh(pullTitles: Record<string, { title: string; state: string; isDraft?: boolean }>) {
  const cases = Object.entries(pullTitles)
    .map(([key, value]) => `  "pr view ${key} --json title,state,isDraft") printf '%s\\n' '${JSON.stringify(value)}';;`)
    .join("\n");
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
case "$*" in
  "--version") echo "gh version 2.96.0 (fake)";;
  "auth status --hostname github.com --active") echo "authenticated";;
${cases}
  "pr view "*) echo "not found" >&2; exit 1;;
  *) printf '%s\\n' '[]';;
esac
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "bb-github-links-"));
  fakeGh({ "7 -R acme/widgets": { title: "Widget polish", state: "OPEN", isDraft: true }, "9 -R other/repo": { title: "Elsewhere", state: "MERGED" } });
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});
afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

function gitRepoWithOrigin(url: string): string {
  const dir = mkdtempSync(join(binDir, "repo-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
  return dir;
}

async function load(options: { branchPull?: PullOutcome; environmentPath?: string | null } = {}) {
  const branchPull: PullOutcome = options.branchPull ?? { outcome: "absent" };
  const metadata = new Map<string, Record<string, unknown>>();
  const host = createFakePluginHost({
    pluginId: "github",
    sdk: {
      projects: { list: async () => [] },
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: options.environmentPath === null ? null : "env-1", projectId: "proj-1" }),
        updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
          const current = metadata.get(threadId) ?? {};
          for (const key of remove ?? []) delete current[key];
          Object.assign(current, set ?? {});
          metadata.set(threadId, current);
          return { threadId, pluginId: "github", metadata: current };
        },
      },
      environments: {
        get: async () => ({ id: "env-1", path: options.environmentPath ?? null, hostId: "host-1" }),
        pullRequest: async () => branchPull,
      },
      plugins: {
        callRpc: async () => ({ ok: true }),
      },
    },
  });
  await plugin(host.bb);
  const changes = () => host.harness.realtimeSignals.filter((signal) => signal.channel === PULL_REQUESTS_CHANGED).length;
  return { ...host, metadata, changes };
}

describe("pull request links", () => {
  it("links by URL through the agent tool, mirrors metadata, and lists newest first", async () => {
    const { harness, metadata, changes } = await load();
    const first = JSON.parse(String(await harness.callAgentTool("github_link_pr", { reference: "https://github.com/acme/widgets/pull/7" }, { threadId: "thr-1" })));
    expect(first).toMatchObject({ status: "linked", link: { repo: "acme/widgets", number: 7, source: "agent", title: "Widget polish", state: "draft" } });
    const again = JSON.parse(String(await harness.callAgentTool("github_link_pr", { reference: "acme/widgets#7" }, { threadId: "thr-1" })));
    expect(again.status).toBe("already-linked");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = JSON.parse(String(await harness.callAgentTool("github_link_pr", { reference: "https://github.com/other/repo/pull/9?diff=split" }, { threadId: "thr-1" })));
    expect(second.link).toMatchObject({ repo: "other/repo", number: 9, state: "merged" });

    const listed = JSON.parse(String(await harness.callAgentTool("github_list_prs", {}, { threadId: "thr-1" })));
    expect(listed.pullRequests.map((entry: { number: number }) => entry.number)).toEqual([9, 7]);

    await harness.callRpc("listPullRequests", { threadId: "thr-1" });
    expect(metadata.get("thr-1")?.pullRequests).toEqual([
      { repo: "other/repo", number: 9, url: "https://github.com/other/repo/pull/9", source: "agent", title: "Elsewhere", state: "merged" },
      { repo: "acme/widgets", number: 7, url: "https://github.com/acme/widgets/pull/7", source: "agent", title: "Widget polish", state: "draft" },
    ]);
    expect(changes()).toBe(2);
    expect(harness.inspection.sdk.callsTo("threads.updatePluginMetadata").length).toBeGreaterThanOrEqual(2);
    // Every change nudges the sidebar through its `pullRequestsChanged` RPC
    // once the metadata mirror settled, so its chips refetch fresh data.
    await vi.waitFor(() =>
      expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(2),
    );
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([
      [
        expect.objectContaining({
          pluginId: "sidebar",
          method: "pullRequestsChanged",
          input: { threadId: "thr-1" },
        }),
      ],
      [
        expect.objectContaining({
          pluginId: "sidebar",
          method: "pullRequestsChanged",
          input: { threadId: "thr-1" },
        }),
      ],
    ]);
  });

  it("resolves a bare number against the checkout's origin remote", async () => {
    const path = gitRepoWithOrigin("git@github.com:acme/widgets.git");
    const { harness } = await load({ environmentPath: path });
    const result = JSON.parse(String(await harness.callAgentTool("github_link_pr", { reference: "#7" }, { threadId: "thr-2" })));
    expect(result.link).toMatchObject({ repo: "acme/widgets", number: 7, url: "https://github.com/acme/widgets/pull/7" });
  });

  it("refuses a bare number when no repository can be inferred", async () => {
    const { harness } = await load({ environmentPath: null });
    await expect(harness.callAgentTool("github_link_pr", { reference: "12" }, { threadId: "thr-3" })).rejects.toThrow(/needs a repository/);
    await expect(harness.callAgentTool("github_link_pr", { reference: "https://github.com/acme/widgets/issues/7" }, { threadId: "thr-3" })).rejects.toThrow(
      /not a github.com pull request URL/,
    );
  });

  it("links the branch PR automatically when first seen, on list and on thread.idle", async () => {
    const { harness, metadata, changes } = await load({
      branchPull: { outcome: "available", pullRequest: { url: "https://github.com/acme/widgets/pull/53", title: "Icon script", state: "open" } },
    });
    const listed = (await harness.callRpc("listPullRequests", { threadId: "thr-4" })) as { links: Array<Record<string, unknown>>; environmentId: string | null };
    expect(listed.environmentId).toBe("env-1");
    expect(listed.links).toEqual([expect.objectContaining({ repo: "acme/widgets", number: 53, source: "branch", title: "Icon script", state: "open" })]);
    expect(changes()).toBe(1);

    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr-4", environmentId: "env-1" }), lastAssistantText: null });
    await harness.callRpc("listPullRequests", { threadId: "thr-4" });
    expect(changes()).toBe(1); // already linked, nothing new to announce
    expect(metadata.get("thr-4")?.pullRequests).toEqual([
      { repo: "acme/widgets", number: 53, url: "https://github.com/acme/widgets/pull/53", source: "branch", title: "Icon script", state: "open" },
    ]);
  });

  it("keeps an unavailable lookup quiet and lists manual links", async () => {
    const { harness, changes } = await load({ branchPull: { outcome: "unavailable", message: "gh is missing" } });
    await harness.callRpc("linkPullRequest", { threadId: "thr-5", reference: "https://github.com/acme/widgets/pull/7" });
    const listed = (await harness.callRpc("listPullRequests", { threadId: "thr-5" })) as { links: Array<{ source: string }> };
    expect(listed.links.map((link) => link.source)).toEqual(["user"]);
    expect(changes()).toBe(1);
  });

  it("unlinks through the tool and the RPC, and clears metadata on the last removal", async () => {
    const { harness, metadata } = await load();
    await harness.callAgentTool("github_link_pr", { reference: "https://github.com/acme/widgets/pull/7" }, { threadId: "thr-6" });
    const removed = JSON.parse(String(await harness.callAgentTool("github_unlink_pr", { reference: "acme/widgets#7" }, { threadId: "thr-6" })));
    expect(removed).toEqual({ status: "unlinked", repo: "acme/widgets", number: 7 });
    expect(await harness.callRpc("unlinkPullRequest", { threadId: "thr-6", repo: "acme/widgets", number: 7 })).toEqual({ ok: true, removed: false });
    await vi.waitFor(() => expect(metadata.get("thr-6")?.pullRequests).toBeUndefined());
  });

  it("drops a deleted thread's links and shows PR links as agent pills", async () => {
    const { harness } = await load();
    await harness.callRpc("linkPullRequest", { threadId: "thr-7", reference: "https://github.com/acme/widgets/pull/7" });
    expect(await harness.callRpc("listLinks")).toEqual({
      links: { "pr:acme/widgets#7": [expect.objectContaining({ kind: "pr", repo: "acme/widgets", number: 7, threadId: "thr-7" })] },
    });
    await harness.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr-7" }) });
    expect(await harness.callRpc("listPullRequests", { threadId: "thr-7" })).toEqual({ links: [], environmentId: "env-1" });
    expect(await harness.callRpc("listLinks")).toEqual({ links: {} });
  });

  it("exposes link, unlink, and links on the CLI", async () => {
    const { harness } = await load();
    expect(await harness.runCli(["links"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("--thread") });
    expect(await harness.runCli(["link", "https://github.com/acme/widgets/pull/7"], { threadId: "thr-8" })).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Linked acme/widgets#7\t[draft]\tWidget polish\t(agent)"),
    });
    expect(await harness.runCli(["links", "--thread", "thr-8"])).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("acme/widgets#7") });
    expect(await harness.runCli(["unlink", "acme/widgets#7", "--thread=thr-8"])).toMatchObject({ exitCode: 0, stdout: "Unlinked acme/widgets#7" });
    expect(await harness.runCli(["links"], { threadId: "thr-8" })).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("No pull requests") });
  });

  it("registers the three agent tools with instructions on the link tool", async () => {
    const { harness } = await load();
    const names = harness.registrations.agentTools.map((tool) => tool.name).sort();
    expect(names).toEqual(["github_link_pr", "github_list_prs", "github_unlink_pr"]);
    const link = harness.registrations.agentTools.find((tool) => tool.name === "github_link_pr");
    expect(link?.instructions).toContain("github_link_pr");
    expect((link?.instructions ?? "").length).toBeLessThan(4096);
  });
});
