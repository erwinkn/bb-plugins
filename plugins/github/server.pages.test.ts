import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const transport = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; maxBuffer: number }>, respond: null as null | ((args: string[]) => string | Promise<string>) }));
vi.mock("node:child_process", () => ({ execFile: vi.fn((_file, args, options, callback) => {
  transport.calls.push({ args, maxBuffer: options.maxBuffer });
  let settled = false;
  const finish = (error: Error | null, stdout = "") => { if (!settled) { settled = true; callback(error, stdout, ""); } };
  if (options.signal?.aborted) finish(new Error("aborted"));
  options.signal?.addEventListener("abort", () => finish(new Error("aborted")), { once: true });
  Promise.resolve().then(() => transport.respond!(args)).then((out) => {
    if (Buffer.byteLength(out) > options.maxBuffer) finish(new Error("stdout maxBuffer length exceeded"));
    else finish(null, out);
  }, (error) => finish(error));
  return {};
}) }));
import plugin from "./server";
import { githubRpcContract } from "./contract";

const core = { number: 42, title: "Core opens", state: "OPEN", author: { login: "alice" }, changedFiles: 3020, reviewRequests: [], statusCheckRollup: [] };
const comment = (id: number, body = `Comment ${id}`) => ({ id: String(id), author: "alice", body, bodyHtml: null, createdAt: `2026-10-01T00:${String(id % 60).padStart(2, "0")}:00Z` });
function page(items: unknown[], next: number | null = null) {
  return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${next ? `Link: <https://api.github.com/repos/acme/app/issues/42/comments?per_page=20&page=${next}>; rel="next"\r\n` : ""}\r\n${JSON.stringify(items)}`;
}
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
async function host() { const h = createFakePluginHost({ pluginId: "github-prs" }); hosts.push(h); await plugin(h.bb); return h.harness; }
beforeEach(() => {
  transport.calls = [];
  transport.respond = (args) => {
    if (args[0] === "--version") return "fake gh";
    if (args[0] === "auth") return "fake authenticated";
    if (args[0] === "pr") return JSON.stringify(core);
    if (args[1] === "repos/acme/app/pulls/42") return JSON.stringify({ body_html: "<p>Description</p>", base: { sha: "base" }, head: { sha: "head" } });
    if (args[1] === "repos/acme/app") return '{"allow_squash_merge":true}';
    throw new Error(`Unexpected fake command ${args.join(" ")}`);
  };
});
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); });

describe("bounded pull details through the SDK RPC harness", () => {
  it("opens core with two detail commands and one cached merge lookup, independent of histories", async () => {
    const h = await host();
    transport.calls = []; // Exclude the existing mocked startup auth/version probe.
    const first = githubRpcContract.getPull.output.parse(await h.behavior.callRpc("getPull", { repo: "acme/app", number: 42 }));
    expect(first.pull).toMatchObject({ title: "Core opens", bodyHtml: "<p>Description</p>", changedFiles: 3020, headRefOid: "head" });
    expect(first.pull).not.toHaveProperty("comments");
    expect(transport.calls.filter(({ args }) => args[0] !== "--version").map(({ args }) => args.slice(0, 2))).toEqual([["pr", "view"], ["api", "repos/acme/app/pulls/42"], ["api", "repos/acme/app"]]);
    transport.calls = [];
    expect(githubRpcContract.getPull.output.parse(await h.behavior.callRpc("getPull", { repo: "acme/app", number: 42 })).pull.title).toBe("Core opens");
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.find(({ args }) => args[0] === "pr")!.args.at(-1)).not.toContain("commits");
  });

  it("reads a >16 MiB fake history as bounded pages without aggregate output", async () => {
    const h = await host();
    const body = "x".repeat(70_000);
    const history = Array.from({ length: 260 }, (_, id) => comment(id + 1, body));
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(16 * 1024 * 1024);
    transport.respond = (args) => {
      if (args[0] === "--version") return "fake gh";
      const url = new URL(`https://api.github.com/${args[1]}`);
      expect(url.searchParams.get("per_page")).toBe("20");
      expect(args).not.toContain("--paginate"); expect(args).not.toContain("--slurp");
      const n = Number(url.searchParams.get("page"));
      return page(history.slice((n - 1) * 20, n * 20), n * 20 < history.length ? n + 1 : null);
    };
    let next: number | null = 1; const ids: string[] = [];
    while (next !== null) {
      const result = githubRpcContract.getPullPage.output.parse(await h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "comments", page: next }));
      expect(result.section).toBe("comments"); if (result.section !== "comments") throw new Error("wrong section");
      expect(result.items).toHaveLength(20); expect(result.items[0]!.body).toBe(body);
      ids.push(...result.items.map((item) => item.id)); next = result.nextPage;
    }
    expect(ids).toEqual(Array.from({ length: 260 }, (_, id) => String(id + 1)));
    expect(transport.calls.filter(({ args }) => args[0] === "api")).toHaveLength(13);
    expect(transport.calls.every(({ maxBuffer }) => maxBuffer === 16 * 1024 * 1024)).toBe(true);
  });

  it("preserves review reply IDs/order and file rename/binary identity without initial patches", async () => {
    const h = await host();
    transport.respond = (args) => {
      if (args[0] === "--version") return "fake gh";
      if (args[1]!.includes("/comments?")) {
        expect(args[1]).toContain("sort=created&direction=asc");
        return page([{ ...comment(101, "Reply on a later page"), inReplyToId: "100", path: "src/new.ts", line: 4, diffHunk: "@@ -1 +1 @@" }]);
      }
      expect(args[args.indexOf("--jq") + 1]).toContain("patch:null");
      return page([{ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: null }, { path: "image.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: null }]);
    };
    expect(await h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "reviewComments", page: 2 })).toMatchObject({ items: [{ id: "101", inReplyToId: "100", body: "Reply on a later page" }] });
    expect(await h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "files", page: 2 })).toEqual({ section: "files", nextPage: null, limitation: null, items: [{ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: null, page: 2 }, { path: "image.png", previousPath: null, status: "added", additions: 0, deletions: 0, patch: null, page: 2 }] });
  });

  it("fetches only the selected patch and correct renamed contents on demand", async () => {
    const h = await host();
    transport.respond = (args) => {
      if (args[0] === "--version") return "fake gh";
      if (args[1] === "repos/acme/app/pulls/42") return '{"base":"base","head":"head"}';
      if (args[1]!.includes("/compare/")) return '{"mergeBase":"base"}';
      if (args[1]!.includes("/contents/src/old.ts?ref=base")) return "old\n";
      if (args[1]!.includes("/contents/src/new.ts?ref=head")) return "new\n";
      expect(args[1]).toBe("repos/acme/app/pulls/42/files?per_page=20&page=2");
      expect(args[args.indexOf("--jq") + 1]).toContain("{files:");
      return JSON.stringify({ files: [{ path: "src/new.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] });
    };
    expect(await h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 2, oldPath: "src/old.ts", oldRef: "base", newPath: "src/new.ts", newRef: "head" })).toEqual({ old: { path: "src/old.ts", content: "old\n" }, new: { path: "src/new.ts", content: "new\n" }, patch: "@@ -1 +1 @@\n-old\n+new" });
  });

  it("rejects a selected patch when the PR moved past the summary refs", async () => {
    const h = await host();
    transport.respond = (args) => args[1] === "repos/acme/app/pulls/42" ? '{"base":"base","head":"pushed-head"}'
      : args[1]!.includes("/compare/") ? '{"mergeBase":"base"}' : JSON.stringify({ files: [{ path: "new.ts", patch: "@@ -1 +1 @@\n-old\n+new-head" }] });
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: "old.ts", oldRef: "base", newPath: "new.ts", newRef: "head" })).rejects.toThrow("Pull request changed since it was opened");
  });

  it("accepts harmless base-tip motion and reads old content at the immutable merge base", async () => {
    const h = await host();
    transport.respond = (args) => {
      if (args[1] === "repos/acme/app/pulls/42") return '{"base":"advanced-tip","head":"head"}';
      if (args[1]!.includes("/compare/")) {
        expect(args[1]).toMatch(/compare\/(base|advanced-tip)\.\.\.head\?per_page=1&page=1$/);
        return '{"mergeBase":"common-ancestor"}';
      }
      if (args[1]!.includes("/files?")) return '{"files":[{"path":"new.ts","patch":"@@"}]}';
      if (args[1]!.includes("/contents/old.ts?ref=common-ancestor")) return "ancestor content";
      if (args[1]!.includes("/contents/new.ts?ref=head")) return "head content";
      throw new Error(`Unexpected snapshot read ${args}`);
    };
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: "old.ts", oldRef: "base", newPath: "new.ts", newRef: "head" })).resolves.toEqual({ old: { path: "old.ts", content: "ancestor content" }, new: { path: "new.ts", content: "head content" }, patch: "@@" });
    expect(transport.calls.filter(({ args }) => args[1]?.includes("/compare/"))).toHaveLength(2);
  });

  it("refuses a changed merge base with a fixed head, and exposes comparison auth/errors", async () => {
    const h = await host();
    transport.respond = (args) => args[1] === "repos/acme/app/pulls/42" ? '{"base":"advanced-tip","head":"head"}'
      : args[1]!.includes("/compare/base...") ? '{"mergeBase":"old-ancestor"}'
      : args[1]!.includes("/compare/") ? '{"mergeBase":"new-ancestor"}'
      : '{"files":[{"path":"new.ts","patch":"@@"}]}';
    const input = { repo: "acme/app", number: 42, page: 1, oldPath: "old.ts", oldRef: "base", newPath: "new.ts", newRef: "head" };
    await expect(h.behavior.callRpc("getPullFile", input)).rejects.toThrow("Refresh");
    expect(transport.calls.some(({ args }) => args[1]?.includes("/contents/"))).toBe(false);
    transport.respond = (args) => {
      if (args[1]!.includes("/compare/")) throw new Error("HTTP 403: contents permission required");
      return '{"files":[{"path":"new.ts","patch":"@@"}]}';
    };
    await expect(h.behavior.callRpc("getPullFile", input)).rejects.toThrow("HTTP 403");
  });

  it("shares one bounded snapshot for 20 concurrent expansions, then revalidates a later push", async () => {
    const h = await host(); transport.calls = [];
    const files = Array.from({ length: 20 }, (_, id) => ({ path: `file${id}.ts`, patch: `@@ ${id}` }));
    let release!: (raw: string) => void;
    const pendingPage = new Promise<string>((resolve) => { release = resolve; });
    let pushed = false;
    transport.respond = (args) => {
      if (args[1]!.includes("/compare/")) return '{"mergeBase":"ancestor"}';
      if (args[1]!.includes("/files?")) return pendingPage;
      if (args[1] === "repos/acme/app/pulls/42") return JSON.stringify({ base: "base", head: pushed ? "pushed" : "head" });
      if (args[1]!.includes("/contents/")) return "content";
      throw new Error(`Unexpected fake command ${args}`);
    };
    const input = { repo: "acme/app", number: 42, page: 1, oldRef: "base", newRef: "head" };
    const pending = files.map((file) => h.behavior.callRpc("getPullFile", { ...input, oldPath: file.path, newPath: file.path }));
    await vi.waitFor(() => expect(transport.calls.filter(({ args }) => args[1]?.includes("/files?"))).toHaveLength(1));
    release(JSON.stringify({ files }));
    expect((await Promise.all(pending)).map((file) => githubRpcContract.getPullFile.output.parse(file).patch)).toEqual(files.map((file) => file.patch));
    expect(transport.calls.filter(({ args }) => args[0] === "api")).toHaveLength(43); // 40 contents + 1 page + 1 merge base + 1 refs
    expect(transport.calls.every(({ maxBuffer }) => maxBuffer === 16 * 1024 * 1024)).toBe(true);
    pushed = true;
    await expect(h.behavior.callRpc("getPullFile", { ...input, oldPath: files[0]!.path, newPath: files[0]!.path })).rejects.toThrow("Refresh");
    expect(transport.calls.filter(({ args }) => args[1]?.includes("/files?"))).toHaveLength(2);
    expect(transport.calls.filter(({ args }) => args[1] === "repos/acme/app/pulls/42")).toHaveLength(2);
  });

  it("does not reuse another opened head's snapshot during concurrent expansion", async () => {
    const h = await host(); transport.calls = [];
    transport.respond = (args) => args[1]!.includes("/compare/") ? '{"mergeBase":"ancestor"}'
      : args[1]!.includes("/files?") ? '{"files":[{"path":"a.ts","patch":"@@ pushed"}]}'
      : args[1] === "repos/acme/app/pulls/42" ? '{"base":"base","head":"new-head"}' : "content";
    const input = { repo: "acme/app", number: 42, page: 1, oldRef: "base", oldPath: "a.ts", newPath: "a.ts" };
    const results = await Promise.allSettled([h.behavior.callRpc("getPullFile", { ...input, newRef: "old-head" }), h.behavior.callRpc("getPullFile", { ...input, newRef: "new-head" })]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { message: expect.stringContaining("Refresh") } });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { patch: "@@ pushed" } });
    expect(transport.calls.filter(({ args }) => args[1]?.includes("/files?"))).toHaveLength(2);
    expect(transport.calls.filter(({ args }) => args[1]?.includes("/contents/a.ts?ref=new-head"))).toHaveLength(1);
    expect(transport.calls.some(({ args }) => args[1]?.includes("ref=old-head"))).toBe(false);
  });

  it("isolates pages and evicts a failed shared read so explicit retry succeeds", async () => {
    const h = await host(); let fail = true;
    transport.respond = (args) => {
      if (args[1]!.includes("/compare/")) return '{"mergeBase":"ancestor"}';
      if (args[1]!.includes("/files?")) {
        if (fail && args[1]!.endsWith("page=1")) throw new Error("HTTP 401: page unavailable");
        return '{"files":[{"path":"removed.ts","patch":"@@ removed"}]}';
      }
      if (args[1] === "repos/acme/app/pulls/42") return '{"base":"base","head":"head"}';
      return "old contents";
    };
    const input = { repo: "acme/app", number: 42, page: 1, oldRef: "base", newRef: "head", oldPath: "removed.ts", newPath: null };
    const results = await Promise.allSettled([h.behavior.callRpc("getPullFile", input), h.behavior.callRpc("getPullFile", input), h.behavior.callRpc("getPullFile", { ...input, page: 2 })]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(results[2]).toMatchObject({ value: { old: { path: "removed.ts", content: "old contents" }, new: null, patch: "@@ removed" } });
    fail = false;
    await expect(h.behavior.callRpc("getPullFile", input)).resolves.toMatchObject({ patch: "@@ removed" });
  });

  it.each([
    "\n", "@@ raw patch\n", '{"files":[{"path":"new.ts"}]}', '{"files":[{"patch":null}]}',
    '{"files":[{"path":"new.ts","patch":42}]}', '{"files":[{"path":"new.ts","patch":false}]}',
    JSON.stringify({ files: [{ path: "new.ts", patch: null }, { path: "new.ts", patch: null }] }),
    JSON.stringify({ files: Array.from({ length: 21 }, (_, i) => ({ path: `file${i}.ts`, patch: null })) }),
  ])("rejects malformed/unbounded gh patch objects without silently treating them as binary: %s", async (raw) => {
    const h = await host();
    transport.respond = (args) => args[1]!.includes("/compare/") ? '{"mergeBase":"base"}' : raw;
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: null, oldRef: "base", newPath: "new.ts", newRef: "head" })).rejects.toThrow();
  });

  it("requires the selected filename to be present rather than returning a null patch", async () => {
    const h = await host();
    transport.respond = (args) => args[1]!.includes("/compare/") ? '{"mergeBase":"base"}'
      : args[1] === "repos/acme/app/pulls/42" ? '{"base":"base","head":"head"}' : '{"files":[]}';
    await expect(h.behavior.callRpc("getPullFile", { repo: "acme/app", number: 42, page: 1, oldPath: null, oldRef: "base", newPath: "missing.png", newRef: "head" })).rejects.toThrow("File is no longer in this pull request page");
  });

  it("surfaces endpoint caps rather than silently claiming full history", async () => {
    const h = await host();
    transport.respond = (args) => args[0] === "--version" ? "fake gh" : page(Array.from({ length: 10 }, (_, i) => ({ sha: `sha${i}`, message: "m", author: "a", committedAt: "", url: "" })));
    expect(await h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "commits", page: 13 })).toMatchObject({ nextPage: null, limitation: "GitHub exposes at most 250 commits for a pull request. View the rest on GitHub." });
    await expect(h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "files", page: 151 })).rejects.toThrow("3000 files");
    await expect(h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "comments", page: 0 })).rejects.toThrow();
  });

  it("keeps summary available after auth/buffer failures and stops pending subprocesses on dispose", async () => {
    const h = await host();
    expect(githubRpcContract.getPull.output.parse(await h.behavior.callRpc("getPull", { repo: "acme/app", number: 42 })).pull.title).toBe("Core opens");
    transport.respond = () => { throw new Error("HTTP 401: authentication required"); };
    await expect(h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "reviews", page: 1 })).rejects.toThrow("HTTP 401");
    transport.respond = () => "x".repeat(16 * 1024 * 1024 + 1);
    await expect(h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "comments", page: 1 })).rejects.toThrow("maxBuffer");
    transport.respond = () => new Promise(() => {});
    const pending = h.behavior.callRpc("getPullPage", { repo: "acme/app", number: 42, section: "files", page: 1 });
    const rejected = expect(pending).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(transport.calls.at(-1)!.args[1]).toContain("/files?"));
    await h.lifecycle.dispose(); await rejected;
  });
});
