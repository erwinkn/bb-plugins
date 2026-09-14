// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

await loadPluginApp(() => import("../app"));
const { ThreadPullView } = await import("./pull-thread-view");

const VERCEL_HTML =
  '<p dir="auto">The latest updates on your projects. Learn more about <a href="https://vercel.link/github-learn-more" rel="nofollow">Vercel for GitHub</a>.</p>' +
  '<markdown-accessiblity-table><table role="table"><thead><tr><th align="left">Project</th><th align="left">Updated</th></tr></thead>' +
  '<tbody><tr><td align="left"><a href="https://vercel.com/x"><sup><img src="https://camo.githubusercontent.com/abc" width="16" alt=""></sup></a> pulse-ui</td>' +
  '<td align="left"><relative-time datetime="2026-09-09T21:56:35.345Z">Sep 9, 2026</relative-time></td></tr></tbody></table></markdown-accessiblity-table>';

const SOCKET_HTML =
  '<p dir="auto"><strong>Socket Security</strong> report</p><details><summary>Scan details</summary><p>0 alerts</p></details>';

const pull = {
  repo: "acme/app",
  number: 42,
  title: "Add the flux capacitor",
  state: "OPEN",
  author: "octocat",
  body: "**Why**\n\n- ships it",
  bodyHtml: "<p><strong>Why</strong></p><ul><li>ships it</li></ul>",
  url: "https://github.com/acme/app/pull/42",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  baseRefName: "main",
  headRefName: "flux",
  baseRefOid: "b".repeat(40),
  headRefOid: "a".repeat(40),
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  labels: [],
  assignees: [],
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
  mergeMethods: ["squash", "merge"],
  reviewRequests: [],
  checks: [
    { name: "lint", status: "success", url: "https://ci.example/1", durationSeconds: 75 },
    { name: "e2e", status: "failure", url: "https://ci.example/2", durationSeconds: null },
    { name: "build", status: "pending", url: "", durationSeconds: null },
  ],
  commits: [
    { sha: "0123456789abcdef0123456789abcdef01234567", message: "Wire it up", author: "octocat", committedAt: "2026-09-09T00:00:00.000Z", url: "https://github.com/acme/app/commit/0123456" },
  ],
  comments: [
    { author: "vercel[bot]", body: "raw", bodyHtml: VERCEL_HTML, createdAt: "2026-09-09T21:54:48.000Z" },
    { author: "socket-security[bot]", body: "raw", bodyHtml: SOCKET_HTML, createdAt: "2026-09-09T21:55:00.000Z" },
  ],
  reviews: [
    { author: "reviewer", state: "APPROVED", body: "lgtm", bodyHtml: "<p>lgtm</p>", createdAt: "2026-09-09T22:00:00.000Z" },
  ],
  reviewThreads: [
    {
      path: "src/flux.ts",
      line: 10,
      diffHunk: "@@ -8,3 +8,4 @@",
      comments: [{ author: "reviewer", body: "nit", bodyHtml: "<p>nit</p>", createdAt: "2026-09-09T22:05:00.000Z" }],
    },
  ],
  files: [
    { path: "src/flux.ts", previousPath: null, status: "modified", additions: 10, deletions: 2, patch: "@@ -1,2 +1,3 @@\n context\n-old\n+new1\n+new2" },
    { path: "src/deleted.ts", previousPath: null, status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-gone" },
  ],
};

function renderView(rpc: Record<string, unknown> = {}) {
  return renderSlot(
    { component: () => <ThreadPullView repo="acme/app" number={42} threadId="thr-1" environmentId={null} onOpenList={() => {}} /> },
    {},
    {
      rpc: {
        getPull: () => ({ pull }),
        getPullFile: () => ({ old: null, new: null }),
        ...rpc,
      },
    },
  );
}

describe("ThreadPullView", () => {
  it("renders the Cursor-style header, tabs, and switches between every tab", async () => {
    const slot = renderView();
    await slot.findByText("Add the flux capacitor");

    // Header: state pill, branches, merge button labelled by the first method.
    expect(slot.getByText("Open")).toBeTruthy();
    expect(slot.container.textContent).toContain("flux → main");
    expect(slot.getByRole("button", { name: /squash & merge/i })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Choose merge method" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Pull request actions" })).toBeTruthy();
    expect(slot.getByRole("link", { name: "Open on GitHub" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Copy pull request link" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Edit pull request title" })).toBeTruthy();

    // Tab strip.
    expect(slot.getByRole("tab", { name: /Changes 2/ })).toBeTruthy();
    expect(slot.getByRole("tab", { name: "Description" })).toBeTruthy();
    expect(slot.getByRole("tab", { name: /Commits 1/ })).toBeTruthy();
    expect(slot.getByRole("tab", { name: /1\/3 checks failing/ })).toBeTruthy();
    expect(slot.getByRole("tab", { name: "Reviews" })).toBeTruthy();

    // Changes tab is the default: summary + per-file sections.
    expect(slot.container.textContent).toContain("2 Files Changed");
    expect(slot.getByText("src/flux.ts")).toBeTruthy();
    expect(slot.getByRole("checkbox", { name: "Mark src/flux.ts as viewed" })).toBeTruthy();

    fireEvent.click(slot.getByRole("tab", { name: "Description" }));
    expect(slot.getByText("Why")).toBeTruthy();
    await slot.findByText("pulse-ui"); // vercel comment in the timeline

    fireEvent.click(slot.getByRole("tab", { name: /Commits 1/ }));
    expect(slot.getByText("0123456")).toBeTruthy();
    expect(slot.getByText("Wire it up")).toBeTruthy();

    fireEvent.click(slot.getByRole("tab", { name: /checks failing/ }));
    expect(slot.getByText("lint")).toBeTruthy();
    expect(slot.getByText("1m 15s")).toBeTruthy();

    fireEvent.click(slot.getByRole("tab", { name: "Reviews" }));
    await slot.findByText("nit");
    expect(slot.getByText("lgtm")).toBeTruthy();
    slot.unmount();
  });

  it("renders bot comments as sanitized HTML, not raw markup", async () => {
    const slot = renderView();
    await slot.findByText("Add the flux capacitor");
    fireEvent.click(slot.getByRole("tab", { name: "Description" }));
    await slot.findByText("pulse-ui");

    expect(slot.getByRole("table")).toBeTruthy();
    expect(slot.getByRole("link", { name: "Vercel for GitHub" }).getAttribute("href")).toBe("https://vercel.link/github-learn-more");
    expect(slot.container.querySelector("time")).toBeTruthy();
    expect(slot.getByText("Scan details")).toBeTruthy(); // details/summary
    const text = slot.container.textContent ?? "";
    expect(text).not.toContain("<table>");
    expect(text).not.toContain("<relative-time");
    expect(text).not.toContain("[vc]:");
    slot.unmount();
  });

  it("marks files viewed (persisted) and collapses them", async () => {
    const slot = renderView();
    await slot.findByText("Add the flux capacitor");
    const box = slot.getByRole("checkbox", { name: "Mark src/flux.ts as viewed" });
    fireEvent.click(box);
    expect(window.localStorage.getItem("github-prs:viewed:acme/app#42")).toContain("src/flux.ts");
    slot.unmount();
    window.localStorage.clear();

    // A fresh render starts with the viewed file collapsed… once persisted.
    window.localStorage.setItem("github-prs:viewed:acme/app#42", JSON.stringify(["src/flux.ts"]));
    const slot2 = renderView();
    await slot2.findByText("Add the flux capacitor");
    expect(slot2.getByRole("checkbox", { name: "Mark src/flux.ts as viewed" })).toHaveProperty("checked", true);
    slot2.unmount();
    window.localStorage.clear();
  });

  it("disables merge when GitHub reports the PR as not mergeable", async () => {
    const stuck = { ...pull, mergeable: "CONFLICTING" };
    const slot = renderSlot(
      { component: () => <ThreadPullView repo="acme/app" number={42} threadId="thr-1" environmentId={null} onOpenList={() => {}} /> },
      {},
      { rpc: { getPull: () => ({ pull: stuck }), getPullFile: () => ({ old: null, new: null }) } },
    );
    await slot.findByText("Add the flux capacitor");
    const merge = slot.getByRole("button", { name: /squash & merge/i }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    slot.unmount();
  });

  it("calls mergePull with the chosen method", async () => {
    const mergePull = vi.fn(() => ({ ok: true }));
    const slot = renderView({ mergePull });
    await slot.findByText("Add the flux capacitor");
    fireEvent.click(slot.getByRole("button", { name: /squash & merge/i }));
    await waitFor(() => expect(mergePull).toHaveBeenCalledWith({ repo: "acme/app", number: 42, method: "squash" }));
    slot.unmount();
  });
});
