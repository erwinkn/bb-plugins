// T105: one feed across every watch, the unseen badge count, mark-seen and
// Discuss. The fake reviewer and a fake BB world; no model request.

import { describe, expect, it } from "vitest";
import { oneLineDiff, rig, type Rig } from "./helpers/world.js";
import { projectsInitiatives } from "../src/runtime/projects.js";

const EXACT = "it('computes totals', () => expect(total(l)).toBe(42));";
const LOOSE = "it('computes totals', () => expect(total(l)).toBeGreaterThan(0));";

async function weaken(r: Rig, threadId: string) {
  r.world.turnStart(threadId);
  r.world.fileChange(threadId, `/repo/tests/${threadId}.test.ts`, oneLineDiff(1, EXACT, LOOSE));
  r.world.turnEnd(threadId);
  r.clock.advance(5 * 60_000);
  await r.tick();
}

/** Two watched threads with one real (fake-route) finding each; thr_b's is newer. thr_b is in Initiative prj_1. */
async function twoFindings() {
  const r = await rig({ reviewEnabled: true, severityThreshold: "note" });
  for (const t of ["thr_a", "thr_b"]) {
    r.world.addThread(t, { title: `Thread ${t}`, projectId: "proj_repo" });
    await r.advisor.watch(t, "test");
  }
  await r.tick();
  await weaken(r, "thr_a");
  await weaken(r, "thr_b");
  r.store.saveInitiativeWatch({ id: "prj_1", name: "bb-plugins", enabled: true, since: 0, archived: false, syncedAt: null, error: null }, r.clock.now());
  r.store.saveMember({ initiativeId: "prj_1", threadId: "thr_b", kind: "worker", role: "work", worker: "W7", generation: 1, state: "active" }, r.clock.now());
  const call = (method: string, input: unknown = null) => r.harness.behavior.callRpc(method, input) as Promise<any>;
  return { r, call, a: r.store.getWatchByThread("thr_a")!, b: r.store.getWatchByThread("thr_b")! };
}

describe("T105 feed", () => {
  it("lists findings across watches newest first, filtered by thread or Initiative, with their thread and role", async () => {
    const { call, a, b } = await twoFindings();
    const all = await call("feed", {});
    expect(all.items.map((f: any) => f.watchId)).toEqual([b.id, a.id]);
    expect(all.items[0]).toMatchObject({ threadId: "thr_b", threadTitle: "Thread thr_b", initiative: { name: "bb-plugins", label: "W7 work" }, discussionThreadId: null });
    expect(all.initiatives).toEqual([{ id: "prj_1", name: "bb-plugins", unseen: 1 }]);
    expect(all.threads.map((t: any) => [t.watchId, t.unseen])).toEqual([[a.id, 1], [b.id, 1]]);
    expect((await call("feed", { watchId: a.id })).items.map((f: any) => f.watchId)).toEqual([a.id]);
    expect((await call("feed", { initiativeId: "prj_1" })).items.map((f: any) => f.watchId)).toEqual([b.id]);
    // Paging: one at a time, then the older one, then nothing.
    const first = await call("feed", { limit: 1 });
    const second = await call("feed", { limit: 1, before: first.next });
    expect([first.items[0].watchId, second.items[0].watchId]).toEqual([b.id, a.id]);
  });

  it("counts unseen real findings for the badge; mark seen clears it, per finding, per filter or all", async () => {
    const { r, call, a } = await twoFindings();
    expect(await call("unseen")).toEqual({ unseen: 2 });
    const [fa] = r.store.listOccurrences(a.id);
    await call("findingAcknowledge", { occurrenceId: fa!.id });
    expect(await call("unseen")).toEqual({ unseen: 1 });
    expect(await call("feedMarkSeen", { initiativeId: "prj_1" })).toEqual({ marked: 1 });
    expect(await call("unseen")).toEqual({ unseen: 0 });
    // The count survives a reload: it is stored, not in memory.
    await r.reload();
    expect(await r.harness.behavior.callRpc("unseen", null)).toEqual({ unseen: 0 });
  });

  it("preview findings are labelled and never counted as new", async () => {
    const r = await rig({ severityThreshold: "note" });
    r.world.addThread("thr_p", { title: "Preview me" });
    await r.advisor.watch("thr_p", "test");
    await r.tick();
    r.world.turnStart("thr_p");
    r.world.fileChange("thr_p", "/repo/tests/p.test.ts", oneLineDiff(1, EXACT, LOOSE));
    r.world.turnEnd("thr_p");
    await r.tick();
    const w = r.store.getWatchByThread("thr_p")!;
    await r.harness.behavior.callRpc("previewReview", { watchId: w.id });
    const feed = (await r.harness.behavior.callRpc("feed", {})) as any;
    expect(feed.items[0]).toMatchObject({ preview: true });
    expect(feed.items[0].badges).toContain("preview (fake reviewer): not a judgment");
    expect(await r.harness.behavior.callRpc("unseen", null)).toEqual({ unseen: 0 });
  });
});

describe("T105 Discuss", () => {
  it("drafts the finding without creating anything; submitting opens one separate thread, reused afterwards", async () => {
    const { r, call, b } = await twoFindings();
    const [fb] = r.store.listOccurrences(b.id);
    const watchedEvents = r.world.events.get("thr_b")!.length;
    const draft = await call("discussDraft", { occurrenceId: fb!.id });
    expect(draft).toMatchObject({ projectId: "proj_repo", threadId: null });
    expect(draft.prompt).toContain(fb!.summary);
    expect(draft.prompt).toContain("Watched thread: \"Thread thr_b\" (thr_b) · Initiative bb-plugins, W7 work");
    expect(draft.prompt).toContain("Do not message, steer or change the watched thread");
    expect(r.world.spawns).toEqual([]);
    const request = { projectId: "proj_repo", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "auto", executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text: draft.prompt, mentions: [] }] };
    const made = await call("discussCreate", { occurrenceId: fb!.id, request });
    expect(made).toMatchObject({ reused: false });
    expect(r.world.spawns).toHaveLength(1);
    expect(r.world.spawns[0]).toMatchObject({ projectId: "proj_repo", title: `Advisor · ${fb!.summary}`.slice(0, 120), input: request.input });
    expect(r.world.spawns[0].parentThreadId).toBeUndefined();
    expect(await call("discussCreate", { occurrenceId: fb!.id, request })).toEqual({ threadId: made.threadId, reused: true });
    expect(r.world.spawns).toHaveLength(1);
    expect((await call("discussDraft", { occurrenceId: fb!.id })).threadId).toBe(made.threadId);
    expect((await call("feed", {})).items[0].discussionThreadId).toBe(made.threadId);
    // The watched thread got nothing.
    expect(r.world.events.get("thr_b")!.length).toBe(watchedEvents);
    // An archived discussion is not reused.
    r.world.threads.set(made.threadId, { ...r.world.threads.get(made.threadId), archivedAt: 1 });
    expect((await call("discussDraft", { occurrenceId: fb!.id })).threadId).toBeNull();
  });
});

describe("A252 follow-ups", () => {
  it("#2: an explicitly watched thread carries its own Initiative membership for labels, filters and scoped mark-seen, and no other member is watched", async () => {
    const context = {
      version: 1,
      threadId: "thr_a",
      membership: {
        initiativeId: "prj_a", initiativeName: "Alpha", archived: false, paused: false, coordinator: { threadId: "thr_a", generation: 1 },
        kind: "coordinator", role: "coordinator", worker: null, generation: 1, state: "active", former: false, retired: false, stopped: false, assignment: null, next: null,
      },
    };
    const initiatives = projectsInitiatives({
      fetch: async (u) => new Response(JSON.stringify(new URL(u).pathname.endsWith("/thread") ? context : { error: "Not found" }), { status: new URL(u).pathname.endsWith("/thread") ? 200 : 404 }),
      loopbackBaseUrl: () => "http://127.0.0.1:1",
      token: async () => "tok",
    });
    const r = await rig({ reviewEnabled: true, severityThreshold: "note" }, { initiatives });
    r.world.addThread("thr_a", { title: "Alpha coordinator" });
    await r.advisor.watch("thr_a", "test");
    await r.tick();
    await weaken(r, "thr_a");
    const call = (method: string, input: unknown = null) => r.harness.behavior.callRpc(method, input) as Promise<any>;
    const feed = await call("feed", {});
    expect(feed.items[0].initiative).toMatchObject({ id: "prj_a", name: "Alpha", label: "coordinator" });
    expect(feed.initiatives).toEqual([{ id: "prj_a", name: "Alpha", unseen: 1 }]);
    expect((await call("feed", { initiativeId: "prj_a" })).items).toHaveLength(1);
    expect(await call("feedMarkSeen", { initiativeId: "prj_a" })).toEqual({ marked: 1 });
    expect(r.store.listWatches().map((w) => w.threadId)).toEqual(["thr_a"]);
  });

  it("#4: concurrent Discuss submits for one finding make one thread; a failed spawn can be retried", async () => {
    const { r, call, b } = await twoFindings();
    const [fb] = r.store.listOccurrences(b.id);
    const request = { projectId: "proj_repo", providerId: "claude-code", model: "m", reasoningLevel: "high", permissionMode: "auto", executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text: "x" }] };
    const create = () => call("discussCreate", { occurrenceId: fb!.id, request });
    r.world.failSpawns = 1;
    const failed = await Promise.allSettled([create(), create()]);
    expect(failed.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    expect(r.store.discussionOf(fb!.id)).toBeNull();
    const both = await Promise.all([create(), create()]);
    expect(both[0].threadId).toBe(both[1].threadId);
    expect(both.map((x: any) => x.reused)).toEqual([false, true]);
    expect(r.world.spawns).toHaveLength(1);
    expect(r.store.discussionOf(fb!.id)).toBe(both[0].threadId);
  });
});
