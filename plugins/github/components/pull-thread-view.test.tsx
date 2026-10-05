// @vitest-environment jsdom

import { act, fireEvent, waitFor } from "@testing-library/react";
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

function historyPage({ section }: { section: string }) {
  const items = section === "comments" ? pull.comments.map((item, i) => ({ ...item, id: String(i + 1) }))
    : section === "reviews" ? pull.reviews.map((item, i) => ({ ...item, id: String(i + 1) }))
    : section === "files" ? pull.files.map((item) => ({ ...item, patch: null, page: 1 }))
    : section === "commits" ? pull.commits
    : pull.reviewThreads.flatMap((thread, i) => thread.comments.map((item, j) => ({ ...item, id: `${i}:${j}`, inReplyToId: j === 0 ? null : `${i}:0`, path: thread.path, line: thread.line, diffHunk: thread.diffHunk })));
  return { section, items, nextPage: null, limitation: null };
}

function renderView(rpc: Record<string, unknown> = {}) {
  return renderSlot(
    { component: () => <ThreadPullView repo="acme/app" number={42} threadId="thr-1" environmentId={null} onOpenList={() => {}} /> },
    {},
    {
      rpc: {
        getPull: () => ({ pull }),
        getPullPage: (input: unknown) => historyPage(input as { section: string }),
        getPullFile: (input: unknown) => { const { newPath, oldPath } = input as { newPath: string | null; oldPath: string | null }; return { old: null, new: null, patch: pull.files.find((file) => file.path === (newPath ?? oldPath))?.patch ?? null }; },
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
    expect(slot.getByRole("tab", { name: /Commits/ })).toBeTruthy();
    expect(slot.getByRole("tab", { name: /1\/3 checks failing/ })).toBeTruthy();
    expect(slot.getByRole("tab", { name: "Reviews" })).toBeTruthy();

    // The initial opening is summary-only. Files are fetched on tab selection.
    expect(slot.getByText("Why")).toBeTruthy();
    expect(slot.queryByText("src/flux.ts")).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: /Changes 2/ }));
    await slot.findByText("src/flux.ts");
    expect(slot.container.textContent).toContain("2 Files Changed");
    expect(slot.getByRole("checkbox", { name: "Mark src/flux.ts as viewed" })).toBeTruthy();

    fireEvent.click(slot.getByRole("tab", { name: "Description" }));
    expect(slot.getByText("Why")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Load comments" }));
    await slot.findByText("pulse-ui"); // vercel comment in the timeline

    fireEvent.click(slot.getByRole("tab", { name: /Commits/ }));
    await slot.findByText("0123456");
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
    fireEvent.click(slot.getByRole("button", { name: "Load comments" }));
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
    fireEvent.click(slot.getByRole("tab", { name: /Changes 2/ }));
    await slot.findByText("src/flux.ts");
    const box = slot.getByRole("checkbox", { name: "Mark src/flux.ts as viewed" });
    fireEvent.click(box);
    expect(window.localStorage.getItem("github-prs:viewed:acme/app#42")).toContain("src/flux.ts");
    slot.unmount();
    window.localStorage.clear();

    // A fresh render starts with the viewed file collapsed… once persisted.
    window.localStorage.setItem("github-prs:viewed:acme/app#42", JSON.stringify(["src/flux.ts"]));
    const slot2 = renderView();
    await slot2.findByText("Add the flux capacitor");
    fireEvent.click(slot2.getByRole("tab", { name: /Changes 2/ }));
    await slot2.findByText("src/flux.ts");
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("lazy bounded PR sections", () => {
  it("opens the summary without histories, then continues comments in order without duplicates", async () => {
    const getPullPage = vi.fn(({ section, page }: { section: string; page: number }) => ({ section,
      items: page === 1 ? [{ id: "1", author: "alice", body: "First comment", bodyHtml: null, createdAt: "2026-10-01" }]
        : [{ id: "1", author: "alice", body: "First comment updated", bodyHtml: null, createdAt: "2026-10-01" }, { id: "2", author: "bob", body: "Second comment", bodyHtml: null, createdAt: "2026-10-02" }],
      nextPage: page === 1 ? 2 : null, limitation: null }));
    const slot = renderView({ getPullPage });
    await slot.findByText("Add the flux capacitor");
    expect(slot.getByText("Why").textContent).toBe("Why");
    expect(getPullPage).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Load comments" }));
    await slot.findByText("First comment");
    expect(slot.getByText("1 comment loaded, more available.").textContent).toContain("more available");
    fireEvent.click(slot.getByRole("button", { name: "Load more comments" }));
    await slot.findByText("Second comment");
    expect(slot.queryByText("First comment")).toBeNull();
    expect(slot.getAllByText("First comment updated")).toHaveLength(1);
    expect(slot.container.textContent!.indexOf("First comment updated")).toBeLessThan(slot.container.textContent!.indexOf("Second comment"));
    expect(slot.getByText("2 comments loaded, no more pages reported.")).toBeTruthy();
    expect(getPullPage.mock.calls.map(([input]) => input.page)).toEqual([1, 2]);
    slot.unmount();
  });

  it("groups cross-page review replies and keeps a failed section independent", async () => {
    const root = { id: "100", author: "reviewer", body: "Root on first page", bodyHtml: null, createdAt: "2026-10-01", inReplyToId: null, path: "src/new.ts", line: 4, diffHunk: "" };
    const getPullPage = vi.fn(({ section, page }: { section: string; page: number }) => {
      if (section === "reviews") throw new Error("HTTP 401: authentication required");
      return { section, items: page === 1 ? [root] : [{ ...root, id: "101", author: "alice", body: "Reply on next page", createdAt: "2026-10-02", inReplyToId: "100" }], nextPage: page === 1 ? 2 : null, limitation: null };
    });
    const slot = renderView({ getPullPage });
    await slot.findByText("Add the flux capacitor");
    fireEvent.click(slot.getByRole("tab", { name: "Reviews" }));
    await slot.findByText("Root on first page");
    expect(slot.getByRole("alert").textContent).toContain("HTTP 401");
    expect(slot.queryByText("No reviews yet.")).toBeNull();
    expect(slot.getByText("Add the flux capacitor")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Load more review comments" }));
    await slot.findByText("Reply on next page");
    expect(slot.getAllByText("src/new.ts")).toHaveLength(1);
    expect(slot.getByRole("button", { name: "Retry reviews" })).toBeTruthy();
    slot.unmount();
  });

  it("preserves loaded comments on a continuation failure and retries the same page", async () => {
    let failed = false;
    const getPullPage = vi.fn(({ section, page }: { section: string; page: number }) => {
      if (page === 2 && !failed) { failed = true; throw new Error("rate limit"); }
      return { section, items: [{ id: String(page), author: "alice", body: `Saved comment ${page}`, bodyHtml: null, createdAt: `2026-10-0${page}` }], nextPage: page === 1 ? 2 : null, limitation: null };
    });
    const slot = renderView({ getPullPage }); await slot.findByText("Add the flux capacitor");
    fireEvent.click(slot.getByRole("button", { name: "Load comments" })); await slot.findByText("Saved comment 1");
    fireEvent.click(slot.getByRole("button", { name: "Load more comments" })); await slot.findByRole("alert");
    expect(slot.getByText("Saved comment 1")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry comments" })); await slot.findByText("Saved comment 2");
    expect(getPullPage.mock.calls.map(([input]) => input.page)).toEqual([1, 2, 2]);
    expect(slot.queryByRole("alert")).toBeNull(); slot.unmount();
  });

  it("ignores old summary and page responses across PR/thread changes and unmount", async () => {
    const oldSummary = deferred<{ pull: typeof pull }>();
    const oldPage = deferred<ReturnType<typeof historyPage>>();
    const slot = renderView({ getPull: ({ number }: { number: number }) => number === 42 ? oldSummary.promise : { pull: { ...pull, repo: "acme/other", number: 43, title: "Current pull" } } });
    slot.rerender(<ThreadPullView repo="acme/other" number={43} threadId="thr-2" environmentId={null} onOpenList={() => {}} />);
    await slot.findByText("Current pull");
    await act(async () => { oldSummary.resolve({ pull }); });
    await slot.findByText("Current pull"); expect(slot.queryByText("Add the flux capacitor")).toBeNull(); slot.unmount();

    const pages = renderView({ getPullPage: () => oldPage.promise }); await pages.findByText("Add the flux capacitor");
    fireEvent.click(pages.getByRole("button", { name: "Load comments" }));
    pages.rerender(<ThreadPullView repo="acme/app" number={42} threadId="thr-new" environmentId={null} onOpenList={() => {}} />);
    await pages.findByText("Add the flux capacitor");
    await act(async () => { oldPage.resolve(historyPage({ section: "comments" })); });
    expect(pages.queryByText("pulse-ui")).toBeNull();
    expect(pages.getByRole("button", { name: "Load comments" })).toBeTruthy(); pages.unmount();
  });

  it("regroups a missing parent when a later page supplies it", async () => {
    const base = { author: "reviewer", bodyHtml: null, path: "src/reply.ts", line: 4, diffHunk: "" };
    const slot = renderView({ getPullPage: ({ section, page }: { section: string; page: number }) => ({ section,
      items: section === "reviews" ? [] : page === 1 ? [{ ...base, id: "101", inReplyToId: "100", body: "Reply before parent", createdAt: "2026-10-02" }]
        : [{ ...base, id: "100", inReplyToId: null, body: "Parent arrives", createdAt: "2026-10-01" }],
      nextPage: section === "reviewComments" && page === 1 ? 2 : null, limitation: null }) });
    await slot.findByText("Add the flux capacitor"); fireEvent.click(slot.getByRole("tab", { name: "Reviews" }));
    await slot.findByText("Reply before parent"); expect(slot.getByText("Some reply parents are not in the loaded pages.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Load more review comments" })); await slot.findByText("Parent arrives");
    expect(slot.queryByText("Some reply parents are not in the loaded pages.")).toBeNull();
    expect(slot.getAllByText("src/reply.ts")).toHaveLength(1);
    expect(slot.container.textContent!.indexOf("Parent arrives")).toBeLessThan(slot.container.textContent!.indexOf("Reply before parent")); slot.unmount();
  });

  it("shows endpoint limits and unavailable binary diffs without implying completeness", async () => {
    const slot = renderView({ getPullPage: ({ section }: { section: string }) => ({ section, items: [{ path: "image.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: null, page: 150 }], nextPage: null,
      limitation: "GitHub exposes at most 3000 files for a pull request. View the rest on GitHub." }), getPullFile: () => ({ old: null, new: null, patch: null }) });
    await slot.findByText("Add the flux capacitor"); fireEvent.click(slot.getByRole("tab", { name: /Changes/ }));
    await slot.findByText("image.png"); expect(slot.getByText("1 file loaded, GitHub limit reached.")).toBeTruthy();
    expect(slot.queryByText(/no more pages reported/)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Expand image.png diff" }));
    await slot.findByText(/Inline diff unavailable, binary or too large/); slot.unmount();
  });

  it("loads selected renamed file details only on expansion and shows errors honestly", async () => {
    const getPullFile = vi.fn(() => { throw new Error("HTTP 403: forbidden"); });
    const slot = renderView({ getPullPage: ({ section }: { section: string }) => ({ section, items: [{ path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 1, deletions: 1, patch: null, page: 3 }], nextPage: null, limitation: null }), getPullFile });
    await slot.findByText("Add the flux capacitor"); fireEvent.click(slot.getByRole("tab", { name: /Changes/ }));
    await slot.findByText("new.ts"); expect(getPullFile).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Expand new.ts diff" })); await slot.findByRole("alert");
    expect(getPullFile).toHaveBeenCalledWith({ repo: "acme/app", number: 42, page: 3, oldPath: "old.ts", oldRef: "b".repeat(40), newPath: "new.ts", newRef: "a".repeat(40) });
    expect(slot.getByRole("alert").textContent).toContain("HTTP 403");
    expect(slot.getByRole("button", { name: "Retry file diff" })).toBeTruthy(); slot.unmount();
  });
});
