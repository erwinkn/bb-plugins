import { describe, expect, it, vi } from "vitest";
import { projectFixture, report } from "./fake-native";
import { buildOverview } from "../lib/overview";
import { Recent } from "../lib/live-threads";

describe("T119 one request per Initiative switch", () => {
  it("the panel read is the thread's membership plus its Initiative's summary", async () => {
    const { f, project } = await projectFixture();
    const panel = (await f.harness.callRpc("panel", { threadId: "coordinator" })) as any;
    expect(panel.membership).toEqual(await f.harness.callRpc("membership", { threadId: "coordinator" }));
    expect(panel.summary.project.id).toBe(project.id);
    expect(panel.summary.historyLoaded).toBe(false);
    expect(await f.harness.callRpc("panel", { threadId: "stranger" })).toEqual({ membership: null, summary: null });
  });

  it("the summary decodes only reports awaiting acceptance, yet keeps every report summary it shows and each worker's last handoff", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "First");
    const [a1] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(a1.threadId!, report());
    await f.service.closeTask(project.id, t1.ref, "done");
    f.idle(a1.threadId!);
    const t2 = f.task(project.id, "Second");
    const [a2] = await f.service.delegate(project.id, { route: "fresh", tasks: [t2.ref] });
    await f.service.report(a2.threadId!, report());
    const assignments = vi.spyOn(f.store, "assignments");
    const summary = buildOverview(f.store, project.id, new Map(), Date.now(), null, "summary");
    expect(assignments).not.toHaveBeenCalled();
    const full = buildOverview(f.store, project.id, new Map(), Date.now(), null, "full");
    expect(summary.awaitingAcceptance.map((a) => [a.assignment, a.summary])).toEqual(
      full.awaitingAcceptance.map((a) => [a.assignment, a.summary]),
    );
    expect(summary.awaitingAcceptance.at(-1)?.summary).toBe(report().summary);
    expect(summary.workers.current.map((w) => [w.ref, w.lastHandoff])).toEqual(full.workers.current.map((w) => [w.ref, w.lastHandoff]));
    expect(summary.workers.current.map((w) => w.lastHandoff).filter(Boolean).length).toBe(2);
  });

  it("a cached native fact past its ttl answers at once while one background reload replaces it", async () => {
    let now = 0;
    const recent = new Recent<string>(10_000, () => now);
    let resolve!: (v: string) => void;
    const load = vi.fn(async () => "first");
    expect(await recent.get("k", load)).toBe("first");
    now = 10_000;
    const slow = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    expect(await recent.get("k", slow)).toBe("first");
    expect(await recent.get("k", slow)).toBe("first");
    expect(slow).toHaveBeenCalledTimes(1);
    resolve("second");
    await new Promise((r) => setTimeout(r, 0));
    expect(await recent.get("k", slow)).toBe("second");
    // A failed reload keeps the last good value and is retried later.
    now = 30_000;
    const failing = vi.fn(async () => { throw new Error("down"); });
    expect(await recent.get("k", failing)).toBe("second");
    await new Promise((r) => setTimeout(r, 0));
    expect(await recent.get("k", failing)).toBe("second");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
