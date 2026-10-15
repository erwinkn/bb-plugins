import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];

/** Statements the tree prepares on a rebuild after a write. */
function treeQueries(f: Fixture) {
  f.store.db.exec("CREATE TABLE IF NOT EXISTS w483_bump (x)");
  f.store.db.prepare("INSERT INTO w483_bump VALUES (1)").run();
  const prepare = vi.spyOn(f.store.db, "prepare");
  try {
    f.tree();
    return prepare.mock.calls.length;
  } finally {
    prepare.mockRestore();
  }
}

describe("W483 tree cost", () => {
  it("rebuilds with the same number of queries however many threads and retired workers an Adventure has", async () => {
    const { f, project } = await projectFixture();
    const grow = (from: number, to: number) =>
      f.store.tx(() => {
        for (let n = from; n < to; n++) {
          f.store.associateNestedThread({ projectId: project.id, threadId: `nested-${n}`, label: `Nested ${n}`, bbProjectId: "proj_a" });
          const w = f.store.createWorker({ projectId: project.id, role: "work", label: `Worker ${n}`, area: "fixture", bbProjectId: "proj_a" });
          f.store.updateWorker(project.id, w.num, { threadId: `retired-${n}`, state: "retired" });
        }
      });
    grow(0, 5);
    const small = treeQueries(f);
    grow(5, 200);
    expect(treeQueries(f)).toBe(small);
    expect(f.tree().projects[0]!.nodes.filter((n) => n.role === "adhoc")).toHaveLength(200);
    expect(f.tree().projects[0]!.retired).toBe(200);
  });

  it("lists a nested thread once, under its worker role, after it is adopted", async () => {
    const { f, project } = await projectFixture();
    f.threads.set("helper", { ...f.threads.get("coordinator")!, id: "helper", title: "Helper" });
    f.store.associateNestedThread({ projectId: project.id, threadId: "helper", label: "Helper", bbProjectId: "proj_a" });
    expect(f.tree().projects[0]!.nodes.filter((n) => n.threadId === "helper").map((n) => n.role)).toEqual(["adhoc"]);
    await f.service.adoptWorker(project.id, { threadId: "helper", role: "work", label: "Adopted helper" });
    expect(f.tree().projects[0]!.nodes.filter((n) => n.threadId === "helper").map((n) => n.role)).toEqual(["work"]);
  });
});
