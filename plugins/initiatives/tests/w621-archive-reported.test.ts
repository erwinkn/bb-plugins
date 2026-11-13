import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";

describe("W621 archiving an Initiative", () => {
  it("archives once no work is live, however many assignments sit reported, stopped, failed or cancelled", async () => {
    const { f, project } = await projectFixture();
    const states = ["reported", "stopped", "failed", "cancelled"] as const;
    for (const state of states) {
      await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
      const a = f.store.assignments(project.id).at(-1)!;
      f.store.updateAssignment(project.id, a.num, { state });
    }
    expect(f.store.assignments(project.id).map((a) => a.state)).toEqual([...states]);
    expect(f.service.archiveProject(project.id).archivedAt).toEqual(expect.any(Number));
  });

  it("refuses while an assignment is running, and says how to stop it", async () => {
    const { f, project } = await projectFixture();
    await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref] });
    const a = f.store.assignments(project.id)[0];
    f.store.updateAssignment(project.id, a.num, { state: "running" });
    expect(() => f.service.archiveProject(project.id)).toThrow(/Stop the running work \(Stop all work\) before archiving/);
    expect(f.store.project(project.id)!.archivedAt).toBeNull();
  });
});
