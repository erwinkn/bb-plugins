// The Projects context adapter against contract v1 (T96/A222), with a fake
// fetch serving exactly the documented shapes. No live Projects reads.

import { describe, expect, it } from "vitest";
import { projectsInitiatives } from "../src/runtime/projects.js";
import { readContext } from "../src/runtime/context.js";
import { classifyCompletion } from "../src/rules/snapshot.js";
import { Requests } from "../src/rules/requests.js";
import type { FetchLike } from "../src/transport/types.js";

const signal = () => new AbortController().signal;
const ASSIGNMENT = { ref: "A222", tasks: ["T96"], role: "work", access: "write", route: "fresh", phase: "active", state: "running", cancelRequested: false, outcome: null, reportVersion: null, reportedAt: null, updatedAt: 1, briefChars: 20, handoff: false };
const member = (over: Record<string, unknown> = {}, a: Record<string, unknown> = {}) => ({
  version: 1,
  threadId: "thr_w",
  observedAt: 1,
  membership: {
    initiativeId: "prj_1",
    initiativeName: "bb-plugins",
    archived: false,
    paused: false,
    coordinator: { threadId: "thr_coord", generation: 3 },
    kind: "worker",
    role: "work",
    worker: "W140",
    generation: 1,
    currentGeneration: 1,
    state: "active",
    former: false,
    retired: false,
    stopped: false,
    parent: { forkedFrom: null, nativeParent: true },
    assignment: { ...ASSIGNMENT, ...a },
    next: null,
    ...over,
  },
});

function server(routes: (url: URL) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const fetch: FetchLike = async (u, init) => {
    calls.push(u);
    expect((init.headers as Record<string, string>)["x-bb-plugin-token"]).toBe("tok-projects");
    const r = routes(new URL(u));
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const src = projectsInitiatives({ fetch, loopbackBaseUrl: () => "http://127.0.0.1:1", token: async () => "tok-projects" });
  return { src, calls };
}

const record = (url: URL, text: string, meta: Record<string, unknown>) => ({
  status: 200,
  body: { version: 1, observedAt: 1, initiativeId: "prj_1", ref: url.searchParams.get("ref"), part: "brief", updatedAt: 5, reportVersion: null, meta, totalChars: text.length, offset: 0, nextOffset: null, text },
});

const thread = { id: "thr_w", parentThreadId: "thr_coord", archivedAt: null, createdAt: 1, sourceThreadId: null, originPluginId: "projects" };
const host: any = { getThread: async () => thread };

describe("Projects context contract v1", () => {
  it("maps a member thread: coordinator, active row, exact brief text, task brief", async () => {
    const { src, calls } = server((url) => {
      if (url.pathname.endsWith("/thread")) return { status: 200, body: member() };
      if (url.searchParams.get("ref") === "A222") return record(url, "Brief A222 exact text.", { phase: "active", tasks: ["T96"], worker: "W140" });
      return record(url, "Task T96 brief.", { status: "in_progress" });
    });
    const ctx = await readContext(host, src, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
    expect(ctx.coordinator).toBe("thr_coord");
    expect(ctx.member).toBe(true);
    expect(ctx.snapshot.activeRow).toEqual({ refs: { A222: false }, truncated: false });
    expect(ctx.snapshot.assignments!.A222).toMatchObject({ read: "ok", state: "running", workerNum: 140, briefText: "Brief A222 exact text.", tasks: ["T96"] });
    expect(ctx.snapshot.tasks!.T96).toMatchObject({ read: "ok" });
    expect(ctx.gaps).toEqual([]);
    expect(calls[0]).toBe("http://127.0.0.1:1/api/v1/plugins/initiatives/http/context/v1/thread?threadId=thr_w");
    expect(src.available).toBe(true);
  });

  it("a reported assignment stays progress (a note), a cancelled one is stale", async () => {
    let phase = "active";
    let state = "running";
    const { src } = server((url) =>
      url.pathname.endsWith("/thread")
        ? { status: 200, body: member({}, { phase, state }) }
        : record(url, url.searchParams.get("ref") === "A222" ? "Brief." : "Task.", { phase, tasks: ["T96"], worker: "W140" }),
    );
    const d = await readContext(host, src, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
    phase = "reported";
    state = "reported";
    const c = await readContext(host, src, "thr_w", { epoch: 1, settingsRev: 1 }, Object.keys(d.snapshot.activeRow!.refs), signal());
    const done = classifyCompletion(d.snapshot, c.snapshot, [], true, new Requests({ parent: "thr_coord", coordinator: "thr_coord" }));
    expect([done.state, done.notes]).toEqual(["current-as-of-tip", ["A222-running->reported"]]);
    phase = "cancelled";
    state = "cancelled";
    const x = await readContext(host, src, "thr_w", { epoch: 1, settingsRev: 1 }, Object.keys(d.snapshot.activeRow!.refs), signal());
    const stale = classifyCompletion(d.snapshot, x.snapshot, [], true, new Requests({ parent: "thr_coord", coordinator: "thr_coord" }));
    expect(stale.state === "stale" && stale.reasons).toEqual(["A222-cancelled"]);
  });

  it("v1.1 textVersion: pages of one version are joined; a change mid-read restarts once, twice is a failed read", async () => {
    const brief = "x".repeat(20000);
    let reads = 0;
    let flips = 0;
    const pages = (url: URL) => {
      const offset = Number(url.searchParams.get("offset"));
      reads++;
      const version = reads <= flips ? "v-old" : "v-new";
      const text = url.searchParams.get("ref") === "A222" ? brief : "Task.";
      const chunk = text.slice(offset, offset + 16000);
      const next = offset + 16000 < text.length ? offset + 16000 : null;
      return { status: 200, body: { version: 1, observedAt: 1, initiativeId: "prj_1", ref: url.searchParams.get("ref"), part: "brief", updatedAt: 5, reportVersion: null, meta: { phase: "active", tasks: ["T96"] }, totalChars: text.length, offset, nextOffset: next, text: chunk, textVersion: version } };
    };
    // One flip: page 0 is v-old, page 1 is v-new -> restart from 0 and read a consistent v-new copy.
    flips = 1;
    const a = server((url) => (url.pathname.endsWith("/thread") ? { status: 200, body: member() } : pages(url)));
    const ctx = await readContext(host, a.src, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
    expect(ctx.snapshot.assignments!.A222).toMatchObject({ read: "ok", briefText: brief });
    // Changes on both attempts: never stitched, the read fails (unknown).
    reads = 0;
    let n = 0;
    const b = server((url) => {
      if (url.pathname.endsWith("/thread")) return { status: 200, body: member() };
      const r = pages(url);
      (r.body as any).textVersion = `v${n++}`;
      return r;
    });
    const ctx2 = await readContext(host, b.src, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
    expect(ctx2.snapshot.assignments!.A222).toEqual({ read: "failed" });
  });

  it("membership null is a standalone thread", async () => {
    const { src } = server(() => ({ status: 200, body: { version: 1, threadId: "thr_w", observedAt: 1, membership: null } }));
    const ctx = await readContext(host, src, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
    expect([ctx.member, ctx.snapshot.membership]).toEqual([false, { status: "ok", value: null }]);
  });

  it("no context route yet (BB's own 404): unavailable, standalone, partial coverage for Projects-made threads", async () => {
    const { src } = server(() => ({ status: 404, body: { ok: false, error: 'plugin "projects" has no GET route for "/context/v1/thread"' } }));
    const ctx = await readContext(host, src, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
    expect(src.available).toBe(false);
    expect(ctx.snapshot.membership).toEqual({ status: "ok", value: null });
    expect(ctx.gaps).toEqual(["initiative-context-unavailable"]);
  });

  it("a per-thread failure is a failed read (unknown), never standalone", async () => {
    for (const r of [
      { status: 500, body: { version: 1, observedAt: 1, error: { code: "store-unreadable", message: "x" } } },
      { status: 200, body: { version: 2, threadId: "thr_w", membership: null } },
    ]) {
      const { src } = server(() => r);
      const ctx = await readContext(host, src, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
      expect(ctx.snapshot.membership.status).toBe("missing");
      expect(src.available).toBe(true);
    }
  });
});

describe("T120 the Initiatives plugin under one ID", () => {
  it("reads only the initiatives routes; its 503 is a failed read, never standalone", async () => {
    const calls: string[] = [];
    const down = projectsInitiatives({
      fetch: async (u) => {
        calls.push(u);
        return new Response(JSON.stringify({ ok: false, error: 'plugin "initiatives" is not running (status: error)' }), { status: 503 });
      },
      loopbackBaseUrl: () => "http://127.0.0.1:1",
      token: async () => "tok",
    });
    const read = await down.membership("thr_w", signal());
    expect(calls[0]).toBe("http://127.0.0.1:1/api/v1/plugins/initiatives/http/context/v1/thread?threadId=thr_w");
    expect(read).toMatchObject({ ok: false });
    expect(down.available).toBe(true);
  });

  it("without an Initiatives token, threads it created under either origin show the context gap", async () => {
    const none = projectsInitiatives({ fetch: async () => { throw new Error("no fetch"); }, loopbackBaseUrl: () => "x", token: async () => { throw new Error("plugin not installed"); } });
    for (const originPluginId of ["initiatives", "projects"]) {
      const standalone = await readContext({ getThread: async () => ({ ...thread, originPluginId }) } as never, none, "thr_w", { epoch: 1, settingsRev: 1 }, [], signal());
      expect(none.available).toBe(false);
      expect(standalone.gaps).toEqual(["initiative-context-unavailable"]);
    }
  });
});
