import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { brief } from "./helpers";
import { reportVersion } from "../lib/write-holds";

// A225: the A223 review follow-ups on T96 that still apply after T136 (record tokens, embedded reports in a work message).
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = (f: Fx, name: string, input: unknown, threadId = "coordinator") => f.harness.callAgentTool(name, input, { threadId });
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const page = async (f: Fx, path: string) => (await (await f.harness.fetchHttp("GET", path)).json()) as any;
const ledger = (f: Fx, projectId: string) =>
  JSON.stringify([f.store.assignments(projectId), f.store.tasks(projectId), f.store.workers(projectId)]);

/** W1/A1 reports T1 (not accepted), optionally after recording a decision. */
async function reported(decision?: string) {
  const { f, project } = await projectFixture();
  const t1 = f.task(project.id, "Search");
  const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Search", area: "search" });
  if (decision) await tool(f, "initiative_decision", { action: "decision", madeBy: "agent", description: decision }, d.threadId!);
  await f.service.report(d.threadId!, report() as never);
  f.idle(d.threadId!);
  return { f, project, t1, threadId: d.threadId! };
}

describe("F1: every record page carries a token of the full rendered text", () => {
  it("P1: the handoff token covers the full text and stays stable across pages and reads", async () => {
    const { f, project } = await reported();
    const url = (offset: number) => `/context/v1/record?initiativeId=${project.id}&ref=A1&part=handoff&offset=${offset}&limit=100`;
    const first = await page(f, url(0));
    const second = await page(f, url(100));
    expect(first.textVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(second.textVersion).toBe(first.textVersion);
    expect((await page(f, url(0))).textVersion).toBe(first.textVersion);
  });

  it("task status and worker label changes also change the handoff token; every part carries one", async () => {
    const { f, project, t1 } = await reported();
    const url = `/context/v1/record?initiativeId=${project.id}&ref=A1&part=handoff`;
    const before = await page(f, url);
    const a1 = f.store.assignment(project.id, 1)!;
    f.store.updateTask(project.id, t1.num, { status: "blocked" });
    const status = await page(f, url);
    f.store.updateWorker(project.id, 1, { label: "Search renamed" });
    const label = await page(f, url);
    expect(f.store.assignment(project.id, 1)!.updatedAt).toBe(a1.updatedAt);
    expect(new Set([before.textVersion, status.textVersion, label.textVersion]).size).toBe(3);
    expect([status.reportVersion, label.reportVersion]).toEqual([reportVersion(a1), reportVersion(a1)]);
    for (const part of [`ref=A1&part=brief`, `ref=T1&part=brief`]) {
      const r = await page(f, `/context/v1/record?initiativeId=${project.id}&${part}`);
      expect(r.textVersion, part).toMatch(/^[0-9a-f]{16}$/);
      expect((await page(f, `/context/v1/record?initiativeId=${project.id}&${part}&offset=10&limit=5`)).textVersion, part).toBe(r.textVersion);
    }
  });
});

describe("A223 probe P4 as a regression", () => {
  it("P4: a continue may embed a related handoff into the retained context", async () => {
    const { f, project, t1 } = await reported();
    await f.service.closeTask(project.id, t1.ref, "done");
    const t2 = f.service.createTask(project.id, { title: "Fix", summary: "Fix.", brief: brief("proj_a", ["search"]), dependsOn: [t1.ref] }, "coordinator");
    const [r] = await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [t2.ref], handoffs: ["A1"] });
    expect(r).toMatchObject({ assignment: "A2", worker: "W1" });
    expect(f.store.assignment(project.id, 2)!.handoffSources![0]).toMatchObject({ assignment: "A1", state: "reported" });
    expect(f.send.mock.calls.at(-1)![0].input[0].text).toContain('Prior report from W1 "Search" (A1 · T1, done');
  });
});
