import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const get = async (f: Fx, path: string) => {
  const response = await f.harness.fetchHttp("GET", path);
  return { status: response.status, body: (await response.json()) as any };
};
const sends = (f: Fx) => [f.spawn, f.send, f.fork, f.stop, f.archive, f.update].map(m => m.mock.calls.length);

describe("T103 Initiative listing and member context routes", () => {
  it("lists open Initiatives with their coordinator", async () => {
    const { f, project } = await projectFixture();
    const r = await get(f, "/context/v1/initiatives");
    expect(r).toMatchObject({ status: 200, body: { version: 1, initiatives: [{ initiativeId: project.id, name: project.name, paused: false, coordinator: { threadId: "coordinator", generation: 1 } }] } });
  });

  it("lists coordinator, workers and user-owned threads in the thread route's terms, current and former, without side effects", async () => {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "Search");
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref], label: "Search", area: "search" });
    f.store.openProjectThread({ projectId: project.id, opId: "op_user", label: "Notes", bbProjectId: null });
    f.store.confirmProjectThread("op_user", "thr_user");
    const calls = sends(f);
    const r = await get(f, `/context/v1/members?initiativeId=${project.id}`);
    expect(sends(f)).toEqual(calls);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, initiativeId: project.id, name: project.name, archived: false, truncated: false, next: null });
    const byThread = Object.fromEntries(r.body.members.map((m: any) => [m.threadId, m]));
    expect(byThread.coordinator).toMatchObject({ kind: "coordinator", role: "coordinator", state: "active" });
    expect(byThread[d.threadId!]).toMatchObject({ kind: "worker", role: "work", worker: "W1", generation: 1, state: "active", former: false });
    expect(byThread.thr_user).toMatchObject({ kind: "adhoc", role: "adhoc", state: "active" });

    // Each member agrees with the thread route.
    for (const m of r.body.members) {
      const one = (await get(f, `/context/v1/thread?threadId=${m.threadId}`)).body.membership;
      expect({ kind: one.kind, role: one.role, worker: one.worker, state: one.state }).toEqual({ kind: m.kind, role: m.role, worker: m.worker, state: m.state });
    }

    f.store.updateWorker(project.id, 1, { state: "retired" });
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    const next = f.store.project(project.id)!.coordinatorThreadId!;
    const after = Object.fromEntries((await get(f, `/context/v1/members?initiativeId=${project.id}`)).body.members.map((m: any) => [m.threadId, m]));
    expect(after[d.threadId!]).toMatchObject({ state: "retired", retired: true });
    expect(after.coordinator).toMatchObject({ kind: "coordinator", state: "former", former: true });
    expect(after[next]).toMatchObject({ kind: "coordinator", state: "active" });
  });

  it("pages by thread id until next is null, each member exactly once", async () => {
    const { f, project } = await projectFixture();
    for (const id of ["thr_a", "thr_b", "thr_c"]) {
      f.store.openProjectThread({ projectId: project.id, opId: `op_${id}`, label: id, bbProjectId: null });
      f.store.confirmProjectThread(`op_${id}`, id);
    }
    const all = (await get(f, `/context/v1/members?initiativeId=${project.id}&limit=500`)).body;
    expect(all).toMatchObject({ next: null, truncated: false });
    expect(all.members).toHaveLength(4);
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const r: any = (await get(f, `/context/v1/members?initiativeId=${project.id}&limit=2${after ? `&after=${after}` : ""}`)).body;
      expect(r.members.length).toBeLessThanOrEqual(2);
      seen.push(...r.members.map((m: any) => m.threadId));
      expect(r.truncated).toBe(r.next !== null);
      after = r.next;
      pages++;
    } while (after !== null && pages < 10);
    expect(seen).toEqual([...all.members.map((m: any) => m.threadId)].sort());
    expect(new Set(seen).size).toBe(4);
    expect(await get(f, `/context/v1/members?initiativeId=${project.id}&limit=501`)).toMatchObject({ status: 400 });
    expect(await get(f, `/context/v1/members?initiativeId=${project.id}&after=a%20b`)).toMatchObject({ status: 400 });
  });

  it("answers bad and unknown Initiatives honestly", async () => {
    const { f } = await projectFixture();
    expect(await get(f, "/context/v1/members")).toMatchObject({ status: 400, body: { version: 1, error: { code: "bad-request" } } });
    expect(await get(f, "/context/v1/members?initiativeId=prj_missing")).toMatchObject({ status: 404, body: { version: 1, error: { code: "not-found" } } });
  });
});
