import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { projectFixture } from "./fake-native";
import type { Cached, ChildPage } from "../lib/contract";

const CHILDREN = "initiatives-children";

// W473: the Workers tab knows each current worker's children before anyone opens them, and an
// opened tree answers from that cache at once.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown) =>
  JSON.parse((await f.harness.callAgentTool(name, input, { threadId: "coordinator" })) as string);
const thread = (id: string, parentThreadId: string, createdAt = Date.now(), over: Record<string, unknown> = {}) =>
  makeThreadResponse({ id, projectId: "proj_a", parentThreadId, status: "idle" as never, title: `Thread ${id}`, createdAt, ...over }) as never;
const childOf = (f: Fx, id: string, parentThreadId: string, createdAt?: number) => f.threads.set(id, thread(id, parentThreadId, createdAt));
type Waiting = Record<string, { children: number | null }>;
const counts = async (f: Fx, projectId: string) =>
  Object.fromEntries(Object.entries(((await f.harness.callRpc("overview", { projectId })) as { workerWaiting: Waiting }).workerWaiting)
    .map(([ref, w]) => [ref, w.children]));
const page = (f: Fx, projectId: string, threadId: string) => f.harness.callRpc("childPage", { projectId, threadId }) as Promise<Cached<ChildPage>>;
const signals = (f: Fx, channel: string) => f.harness.realtimeSignals.filter((s) => s.channel === channel);

describe("W473 the overview lists current workers' children in the background", () => {
  it("counts are known without an expand, the first page then answers at once, and BB is not asked again", async () => {
    const { f, project } = await projectFixture();
    const [one] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    await tool(f, "initiative_spawn", { label: "Two", purpose: "two", text: "Do it." });
    childOf(f, "r2", one.threadId, 2);
    childOf(f, "r1", one.threadId, 1);
    expect(await counts(f, project.id)).toEqual({ W1: null, W2: null });
    await vi.waitFor(async () => expect(await counts(f, project.id)).toEqual({ W1: 2, W2: 0 }));
    // Nothing reads BB now: a listing would hang.
    const listed: string[] = [];
    f.intercept((path, args, call) => {
      if (path !== "threads.list") return call();
      listed.push(args?.parentThreadId);
      return new Promise(() => undefined);
    });
    const first = await page(f, project.id, one.threadId);
    expect(first).toMatchObject({ status: "ready", value: { next: null, rows: [{ threadId: "r2", title: "Thread r2", status: "idle", archived: false, children: null }, { threadId: "r1" }] } });
    await counts(f, project.id);
    // Nothing waits on BB: the page's own refresh, and its children's trees so their toggles show.
    expect(listed.sort()).toEqual([one.threadId, "r1", "r2"].sort());
  });

  it("lists at most three trees at once, each once however many reads arrive, and never a retired worker's", async () => {
    const { f, project } = await projectFixture();
    for (let n = 1; n <= 8; n++) await tool(f, "initiative_spawn", { label: `W${n}`, purpose: "p", text: "Do it." });
    const retired = f.store.workers(project.id).find((w) => w.num === 8)!;
    f.store.updateWorker(project.id, 8, { state: "retired" });
    let open = 0;
    let peak = 0;
    const listed: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const [w1] = f.store.workers(project.id);
    f.intercept(async (path, args, call) => {
      // The opened tree's own refresh is no prefetch.
      if (path !== "threads.list" || !args?.parentThreadId || args.parentThreadId === w1!.threadId) return call();
      listed.push(args.parentThreadId);
      peak = Math.max(peak, ++open);
      await held;
      open--;
      return call();
    });
    await counts(f, project.id);
    await counts(f, project.id);
    // Another batch (an opened tree's children) shares the same three listings.
    childOf(f, "r1", w1!.threadId!);
    childOf(f, "r2", w1!.threadId!);
    f.service.runningChildren.listed(w1!.threadId!, [f.threads.get("r1")!, f.threads.get("r2")!] as never, f.service.runningChildren.begin());
    await page(f, project.id, w1!.threadId!);
    expect(peak).toBe(3);
    release();
    // W2..W7 and the tree's two children (W1's listings pass unheld and uncounted).
    await vi.waitFor(() => expect(listed).toHaveLength(8));
    expect(new Set(listed).size).toBe(8);
    expect(listed).not.toContain(retired.threadId);
    expect(peak).toBe(3);
  });

  it("a failed listing is free to retry as soon as it fails, whatever else its batch still waits on", async () => {
    const { f, project } = await projectFixture();
    const [one] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    const [two] = await tool(f, "initiative_spawn", { label: "Two", purpose: "two", text: "Do it." });
    childOf(f, "r1", one.threadId);
    let fail = true;
    let attempts = 0;
    f.intercept((path, args, call) => {
      if (path !== "threads.list") return call();
      if (args?.parentThreadId === two.threadId) return new Promise(() => undefined);
      if (args?.parentThreadId !== one.threadId) return call();
      attempts++;
      return fail ? Promise.reject(new Error("BB unavailable")) : call();
    });
    await counts(f, project.id);
    await vi.waitFor(() => expect(attempts).toBe(1));
    fail = false;
    await vi.waitFor(async () => expect((await counts(f, project.id)).W1).toBe(1));
    expect(attempts).toBe(2);
  });

  it("announces the Adventure once when a count a row shows changed, and not for trees that turn out empty", async () => {
    const { f, project } = await projectFixture();
    const [one] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    await tool(f, "initiative_spawn", { label: "Two", purpose: "two", text: "Do it." });
    let before = signals(f, "initiatives-changed").length;
    await counts(f, project.id);
    await vi.waitFor(async () => expect(await counts(f, project.id)).toEqual({ W1: 0, W2: 0 }));
    expect(signals(f, "initiatives-changed").length).toBe(before);

    const { f: g, project: p } = await projectFixture();
    const [w] = await tool(g, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    await tool(g, "initiative_spawn", { label: "Two", purpose: "two", text: "Do it." });
    childOf(g, "r1", w.threadId);
    before = signals(g, "initiatives-changed").length;
    await counts(g, p.id);
    await vi.waitFor(() => expect(signals(g, "initiatives-changed").slice(before)).toEqual([{ channel: "initiatives-changed", payload: { projectId: p.id } }]));
    expect(await counts(g, p.id)).toEqual({ W1: 1, W2: 0 });
  });

  it("a failed listing is logged once and tried again by a later read", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    childOf(f, "r1", w.threadId);
    let fail = true;
    let attempts = 0;
    f.intercept((path, args, call) => {
      if (path !== "threads.list" || args?.parentThreadId !== w.threadId) return call();
      attempts++;
      return fail ? Promise.reject(new Error("BB unavailable")) : call();
    });
    const warned = () => f.harness.inspection.logEntries.filter((e) => e.level === "warn" && e.message.includes("child threads failed"));
    await counts(f, project.id);
    await vi.waitFor(() => expect(attempts).toBe(1));
    await vi.waitFor(() => expect(warned()).toEqual([
      { level: "warn", message: `Listing ${w.threadId}'s child threads failed; a later read tries again: BB unavailable` },
    ]));
    // The same outage logs nothing more.
    await counts(f, project.id);
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(warned()).toHaveLength(1);
    fail = false;
    await vi.waitFor(async () => expect(await counts(f, project.id)).toEqual({ W1: 1 }));
    expect(attempts).toBe(3);
    expect(warned()).toHaveLength(1);
  });
});

describe("W473 an opened tree answers from the cache events keep current", () => {
  it("a created child shows at once, newest first; a deleted one leaves; no read waits on BB", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    childOf(f, "r1", w.threadId, 1);
    await f.service.associateNativeChildren(project.id);
    f.intercept((path, _args, call) => path === "threads.list" ? new Promise(() => undefined) : call());
    await f.harness.emitThreadEvent("thread.created", { thread: thread("r2", w.threadId, 2, { providerId: "codex" }) });
    expect(await page(f, project.id, w.threadId)).toMatchObject({ status: "ready", value: { rows: [{ threadId: "r2", providerId: "codex" }, { threadId: "r1" }] } });
    await f.harness.emitThreadEvent("thread.deleted", { thread: thread("r1", w.threadId, 1, { deletedAt: 3 }) });
    const after = await page(f, project.id, w.threadId);
    expect(after.status === "ready" && after.value.rows.map((r) => r.threadId)).toEqual(["r2"]);
    expect(await counts(f, project.id)).toEqual({ W1: 1 });
  });

  it("a refresh that changes the page announces only that tree; one that changes its count announces the Adventure too", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    childOf(f, "r1", w.threadId);
    let before = f.harness.realtimeSignals.length;
    // Unlisted: the first read loads, then announces the tree and, as its count went from none to one, the Adventure.
    expect(await page(f, project.id, w.threadId)).toEqual({ status: "loading" });
    await vi.waitFor(() => expect(signals(f, CHILDREN)).toContainEqual({ channel: CHILDREN, payload: { threadId: w.threadId } }));
    expect(f.harness.realtimeSignals.slice(before)).toContainEqual({ channel: "initiatives-changed", payload: { projectId: project.id } });
    // A later refresh that only moves a status announces the tree alone.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      f.threads.set("r1", thread("r1", w.threadId, undefined, { status: "active" }));
      vi.setSystemTime(Date.now() + 11_000);
      before = f.harness.realtimeSignals.length;
      await page(f, project.id, w.threadId);
      await vi.waitFor(() => expect(f.harness.realtimeSignals.slice(before)).toEqual([{ channel: CHILDREN, payload: { threadId: w.threadId } }]));
    } finally {
      vi.useRealTimers();
    }
    expect(await page(f, project.id, w.threadId)).toMatchObject({ status: "ready", value: { rows: [{ threadId: "r1", running: "active" }] } });
  });

  it("keeps BB's order for the children it listed, the ones only an event has shown first", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    childOf(f, "pinned", w.threadId, 1);
    childOf(f, "b", w.threadId, 3);
    childOf(f, "a", w.threadId, 3);
    await f.service.associateNativeChildren(project.id);
    await f.harness.emitThreadEvent("thread.created", { thread: thread("e1", w.threadId, 4) });
    await f.harness.emitThreadEvent("thread.created", { thread: thread("e2", w.threadId, 5) });
    // An event about a listed child keeps its place.
    await f.harness.emitThreadEvent("thread.active", { thread: thread("b", w.threadId, 3, { status: "active" }) });
    const answer = await page(f, project.id, w.threadId);
    expect(answer.status === "ready" && answer.value.rows.map((r) => r.threadId)).toEqual(["e2", "e1", "pinned", "b", "a"]);
  });

  it("a listing that began before the one that filled the cache never replaces it", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    childOf(f, "r1", w.threadId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let hold = true;
    f.intercept((path, args, call) => {
      if (path !== "threads.list" || args?.parentThreadId !== w.threadId || !hold) return call();
      hold = false;
      return held.then(call);
    });
    // The overview's prefetch is held; the opened page's own read, started later, finds r1 moved
    // away (natively: no event) and r2 new.
    await counts(f, project.id);
    const original = f.threads.get("r1")!;
    f.threads.set("r1", thread("r1", "elsewhere"));
    childOf(f, "r2", w.threadId);
    const ids = async () => {
      const answer = await page(f, project.id, w.threadId);
      return answer.status === "ready" ? answer.value.rows.map((r) => r.threadId) : answer.status;
    };
    await vi.waitFor(async () => expect(await ids()).toEqual(["r2"]));
    // The held prefetch then answers with what BB said before: r1 alone.
    f.threads.set("r1", original);
    f.threads.delete("r2");
    release();
    await vi.waitFor(() => expect(hold).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await ids()).toEqual(["r2"]);
  });

  it("a cached tree that a refresh finds has grown past one page pages from BB", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    for (let n = 1; n <= 99; n++) childOf(f, `c${n}`, w.threadId, n);
    await f.service.associateNativeChildren(project.id);
    expect(await page(f, project.id, w.threadId)).toMatchObject({ status: "ready", value: { next: null } });
    // Moved in natively: no lifecycle event says so.
    childOf(f, "moved", w.threadId, 100);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      await page(f, project.id, w.threadId);
      await vi.waitFor(async () => {
        const answer = await page(f, project.id, w.threadId);
        expect(answer.status === "ready" && [answer.value.rows.length, answer.value.next]).toEqual([100, 100]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an older full page never overrides a newer listing the cache holds", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    for (let n = 1; n <= 100; n++) childOf(f, `c${n}`, w.threadId, n);
    const all = [...f.threads.entries()].filter(([id]) => /^c\d+$/.test(id));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let hold = true;
    f.intercept((path, args, call) => {
      if (path !== "threads.list" || args?.parentThreadId !== w.threadId || !hold) return call();
      hold = false;
      return held.then(call);
    });
    // The opened page's read is held; 99 children then leave and the overview's prefetch lists one.
    expect(await page(f, project.id, w.threadId)).toEqual({ status: "loading" });
    for (const [id] of all.slice(1)) f.threads.delete(id);
    await vi.waitFor(async () => expect((await counts(f, project.id)).W1).toBe(1));
    // The held read answers with the 100 BB listed when it began.
    for (const [id, t] of all) f.threads.set(id, t);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const [id] of all.slice(1)) f.threads.delete(id);
    const answer = await page(f, project.id, w.threadId);
    expect(answer.status === "ready" && [answer.value.rows.map((r) => r.threadId), answer.value.next]).toEqual([["c1"], null]);
  });

  it("a refresh that changes what the cache serves announces the tree, though BB's page reads as before", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    f.threads.set("h", thread("h", w.threadId));
    const running = async () => {
      const answer = await page(f, project.id, w.threadId);
      return answer.status === "ready" ? answer.value.rows[0]!.running : answer.status;
    };
    await vi.waitFor(async () => expect(await running()).toBeNull());
    // The sweep's listing sees a background agent the cached BB page never had.
    f.threads.set("h", thread("h", w.threadId, undefined, { activeBackgroundAgentCount: 1 }));
    await f.service.associateNativeChildren(project.id);
    expect(await running()).toBe("background work");
    // It ends; the page's refresh lists what the cached page already said.
    f.threads.set("h", thread("h", w.threadId));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      const before = f.harness.realtimeSignals.length;
      await page(f, project.id, w.threadId);
      await vi.waitFor(() => expect(f.harness.realtimeSignals.slice(before)).toEqual([{ channel: CHILDREN, payload: { threadId: w.threadId } }]));
    } finally {
      vi.useRealTimers();
    }
    expect(await running()).toBeNull();
  });

  it("a tree that answered loading hears when a prefetch fills the cache, though its count stays the same", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    childOf(f, "r1", w.threadId);
    // The event makes the count known (one) before any listing.
    await f.harness.emitThreadEvent("thread.created", { thread: f.threads.get("r1")! });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    f.intercept((path, args, call) => {
      if (path !== "threads.list" || args?.parentThreadId !== w.threadId) return call();
      // The overview's prefetch waits for release; the page's own read never answers.
      return ++calls === 1 ? held.then(call) : new Promise(() => undefined);
    });
    expect(await counts(f, project.id)).toEqual({ W1: 1 });
    expect(await page(f, project.id, w.threadId)).toEqual({ status: "loading" });
    const before = f.harness.realtimeSignals.length;
    release();
    await vi.waitFor(() => expect(f.harness.realtimeSignals.slice(before)).toEqual([{ channel: CHILDREN, payload: { threadId: w.threadId } }]));
    expect(await page(f, project.id, w.threadId)).toMatchObject({ status: "ready", value: { rows: [{ threadId: "r1" }] } });
  });

  it("a refresh that changes nothing announces nothing", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    f.threads.set("h", thread("h", w.threadId));
    await vi.waitFor(async () => expect((await page(f, project.id, w.threadId)).status).toBe("ready"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    let lists = 0;
    f.intercept((path, _args, call) => { if (path === "threads.list") lists++; return call(); });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      const before = f.harness.realtimeSignals.length;
      await page(f, project.id, w.threadId);
      await vi.waitFor(() => expect(lists).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(f.harness.realtimeSignals.slice(before)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tree of 100 or more children pages from BB as before", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "One", purpose: "one", text: "Do it." });
    for (let n = 1; n <= 120; n++) childOf(f, `c${n}`, w.threadId, n);
    await f.service.associateNativeChildren(project.id);
    let answer = await page(f, project.id, w.threadId);
    expect(answer.status).toBe("loading");
    await vi.waitFor(async () => expect((answer = await page(f, project.id, w.threadId)).status).toBe("ready"));
    expect(answer.status === "ready" && [answer.value.rows.length, answer.value.next]).toEqual([100, 100]);
  });
});
