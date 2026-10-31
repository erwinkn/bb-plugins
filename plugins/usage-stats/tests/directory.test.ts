import { afterEach, describe, expect, it, vi } from "vitest";
import { bbDirectory } from "../src/directory";

afterEach(() => vi.unstubAllGlobals());

function fakeBb(token: () => Promise<{ token: string }>, flaky = { fail: false }) {
  const gets: string[] = [];
  const bb = {
    server: { loopbackBaseUrl: "http://bb.test" },
    sdk: {
      threads: {
        async get({ threadId }: { threadId: string }) {
          gets.push(threadId);
          if (threadId === "thr_gone") throw Object.assign(new Error("Thread not found"), { status: 404 });
          if (threadId === "thr_flaky" && flaky.fail) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
          return { title: threadId === "thr_untitled" ? null : `Title of ${threadId}`, titleFallback: "Fallback", projectId: "proj_1", deletedAt: null };
        },
      },
      projects: { list: async () => [{ id: "proj_1", name: "bb-plugins" }] },
      plugins: { token },
    },
  };
  return { bb: bb as unknown as Parameters<typeof bbDirectory>[0], gets };
}

describe("bbDirectory", () => {
  it("names threads once per ten minutes, a missing one as deleted", async () => {
    let now = 0;
    const { bb, gets } = fakeBb(async () => ({ token: "t" }));
    const directory = bbDirectory(bb, () => now);
    const first = await directory.threads(["thr_a", "thr_untitled", "thr_gone", "thr_a"]);
    expect([...first.entries()]).toEqual([
      ["thr_a", { title: "Title of thr_a", projectId: "proj_1", deleted: false }],
      ["thr_untitled", { title: "Fallback", projectId: "proj_1", deleted: false }],
      ["thr_gone", { title: "Deleted thread", projectId: null, deleted: true }],
    ]);
    await directory.threads(["thr_a"]);
    expect(gets).toEqual(["thr_a", "thr_untitled", "thr_gone"]);
    now = 11 * 60_000;
    await directory.threads(["thr_a"]);
    expect(gets.at(-1)).toBe("thr_a");
    expect(await directory.projects()).toEqual(new Map([["proj_1", "bb-plugins"]]));
  });

  it("does not take a failed lookup for a deletion, and asks again next time", async () => {
    const flaky = { fail: true };
    const { bb, gets } = fakeBb(async () => ({ token: "t" }), flaky);
    const directory = bbDirectory(bb, () => 0);
    expect((await directory.threads(["thr_flaky"])).get("thr_flaky")).toEqual({ title: "thr_flaky", projectId: null, deleted: false });
    flaky.fail = false;
    expect((await directory.threads(["thr_flaky"])).get("thr_flaky")).toEqual({ title: "Title of thr_flaky", projectId: "proj_1", deleted: false });
    expect(gets).toEqual(["thr_flaky", "thr_flaky"]);
  });

  it("answers stale names at once, reads them again in the background, once", async () => {
    let now = 0;
    let title = "Old title";
    const pending: Array<() => void> = [];
    const gets: string[] = [];
    const bb = {
      server: { loopbackBaseUrl: "http://bb.test" },
      sdk: {
        threads: {
          get({ threadId }: { threadId: string }) {
            gets.push(threadId);
            const answer = { title, titleFallback: null, projectId: "proj_1", deletedAt: null };
            // Past the first read, BB answers only when the test says so.
            return gets.length === 1 ? Promise.resolve(answer) : new Promise((resolve) => pending.push(() => resolve(answer)));
          },
        },
      },
    } as unknown as Parameters<typeof bbDirectory>[0];
    const directory = bbDirectory(bb, () => now);
    await directory.threads(["thr_a"]);
    title = "New title";
    now = 11 * 60_000;
    expect((await directory.threads(["thr_a"])).get("thr_a")?.title).toBe("Old title");
    expect((await directory.threads(["thr_a"])).get("thr_a")?.title).toBe("Old title");
    expect(gets).toEqual(["thr_a", "thr_a"]);
    pending.shift()!();
    await vi.waitFor(async () => expect((await directory.threads(["thr_a"])).get("thr_a")?.title).toBe("New title"));
  });

  it("does not make a page wait on another page's unrelated reads", async () => {
    const bb = {
      server: { loopbackBaseUrl: "http://bb.test" },
      sdk: {
        threads: {
          get({ threadId }: { threadId: string }) {
            const answer = { title: `Title of ${threadId}`, titleFallback: null, projectId: "proj_1", deletedAt: null };
            return threadId === "thr_slow" ? new Promise(() => {}) : Promise.resolve(answer);
          },
        },
      },
    } as unknown as Parameters<typeof bbDirectory>[0];
    const directory = bbDirectory(bb, () => 0);
    // The first page's read never ends; the second needs one of its names, not the slow one.
    void directory.threads(["thr_a", "thr_slow"]);
    expect((await directory.threads(["thr_a"])).get("thr_a")?.title).toBe("Title of thr_a");
  });

  it("keeps a requested name the cache evicts while the page waits", async () => {
    let now = 0;
    let refreshing = false;
    const bb = {
      server: { loopbackBaseUrl: "http://bb.test" },
      sdk: {
        threads: {
          get({ threadId }: { threadId: string }) {
            const answer = { title: `Title of ${threadId}`, titleFallback: null, projectId: "proj_1", deletedAt: null };
            // The stale thread's refresh hangs; a new thread answers.
            return refreshing && threadId === "thr_0" ? new Promise(() => {}) : Promise.resolve(answer);
          },
        },
      },
    } as unknown as Parameters<typeof bbDirectory>[0];
    const directory = bbDirectory(bb, () => now);
    // A full cache: 20,000 threads, thr_0 the oldest.
    await directory.threads(Array.from({ length: 20_000 }, (_, index) => `thr_${index}`));
    refreshing = true;
    now = 11 * 60_000;
    const names = await directory.threads(["thr_0", "thr_new"]);
    expect(names.get("thr_0")).toEqual({ title: "Title of thr_0", projectId: "proj_1", deleted: false });
    expect(names.get("thr_new")?.title).toBe("Title of thr_new");
  });

  it("answers stale Initiative membership at once, and keeps it when a read fails", async () => {
    let now = 0;
    let respond: (url: string) => Promise<Response> = async (url) => {
      const path = url.replace("http://bb.test/api/v1/plugins/initiatives/http/context/v1", "");
      const body = path === "/initiatives"
        ? { initiatives: [{ initiativeId: "prj_1", name: "bb-plugins" }] }
        : { next: null, members: [{ threadId: "thr_a", kind: "coordinator", worker: null }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    let fetches = 0;
    vi.stubGlobal("fetch", (url: string) => {
      fetches++;
      return respond(url);
    });
    const { bb } = fakeBb(async () => ({ token: "t" }));
    const directory = bbDirectory(bb, () => now);
    expect((await directory.memberships()).get("thr_a")?.member).toBe("Coordinator");
    expect(fetches).toBe(2);

    // Past the TTL the Initiatives plugin hangs: the page still gets its names now.
    const hung: Array<() => void> = [];
    respond = () => new Promise((_, reject) => hung.push(() => reject(new Error("timed out"))));
    now = 61_000;
    expect((await directory.memberships()).get("thr_a")?.member).toBe("Coordinator");
    expect((await directory.memberships()).get("thr_a")?.member).toBe("Coordinator");
    expect(fetches).toBe(3);
    // The read fails: what was known stays, and is read again on the next call.
    hung.shift()!();
    await vi.waitFor(async () => {
      expect((await directory.memberships()).get("thr_a")?.member).toBe("Coordinator");
      expect(fetches).toBe(4);
    });
  });

  it("reads every Initiative's members, page by page, with the Initiatives token", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>)["x-bb-plugin-token"]).toBe("secret");
      const path = url.replace("http://bb.test/api/v1/plugins/initiatives/http/context/v1", "");
      const body = path === "/initiatives"
        ? { version: 1, initiatives: [{ initiativeId: "prj_1", name: "bb-plugins", paused: false }] }
        : path.includes("after=thr_b")
          ? { version: 1, next: null, members: [{ threadId: "thr_w", kind: "worker", worker: "W219", role: "work" }] }
          : { version: 1, next: "thr_b", members: [{ threadId: "thr_a", kind: "coordinator", worker: null, role: "coordinator" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const { bb } = fakeBb(async () => ({ token: "secret" }));
    const memberships = await bbDirectory(bb).memberships();
    expect([...memberships.entries()]).toEqual([
      ["thr_a", { initiativeId: "prj_1", initiativeName: "bb-plugins", member: "Coordinator" }],
      ["thr_w", { initiativeId: "prj_1", initiativeName: "bb-plugins", member: "W219" }],
    ]);
    expect(urls).toHaveLength(3);
  });

  it("has no Initiatives without the plugin", async () => {
    const { bb } = fakeBb(async () => {
      throw new Error('Plugin "initiatives" is not installed.');
    });
    expect((await bbDirectory(bb).memberships()).size).toBe(0);
  });
});
