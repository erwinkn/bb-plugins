import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { treeSchema } from "../lib/tree-schema";

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const appearance = async (f: Fx, id: string) =>
  treeSchema.parse(await f.harness.callRpc("tree", null)).projects.find((p) => p.id === id)!.appearance;
const set = (f: Fx, projectId: string, command: Record<string, unknown>) =>
  f.harness.callRpc("command", { projectId, command: { action: "appearance", ...command } });

describe("T16 Initiative appearance", () => {
  it("defaults to no choice, and a user edit persists in the tree and list without moving the Initiative", async () => {
    const { f, project } = await projectFixture();
    expect(await appearance(f, project.id)).toEqual({ icon: null, color: null });
    const before = f.store.project(project.id)!;
    expect(await set(f, project.id, { icon: "Bug", color: "teal" })).toEqual({ appearance: { icon: "Bug", color: "teal" } });
    expect(await appearance(f, project.id)).toEqual({ icon: "Bug", color: "teal" });
    expect(((await f.harness.callRpc("list", null)) as unknown[])[0]).toMatchObject({ id: project.id, appearance: { icon: "Bug", color: "teal" } });
    const after = f.store.project(project.id)!;
    expect([after.updatedAt, after.name]).toEqual([before.updatedAt, before.name]);
    // Omitted keeps a field; null resets it; both null is the default look again.
    await set(f, project.id, { color: "violet" });
    expect(await appearance(f, project.id)).toEqual({ icon: "Bug", color: "violet" });
    await set(f, project.id, { icon: null, color: null });
    expect(await appearance(f, project.id)).toEqual({ icon: null, color: null });
    expect(f.store.db.prepare("SELECT appearance FROM projects WHERE id = ?").get(project.id)).toEqual({ appearance: null });
  });

  it("renaming keeps the appearance, and the appearance keeps the name", async () => {
    const { f, project } = await projectFixture();
    await set(f, project.id, { icon: "Brain" });
    await f.harness.callRpc("command", { projectId: project.id, command: { action: "edit", name: "Renamed" } });
    expect(f.store.project(project.id)).toMatchObject({ name: "Renamed", appearance: { icon: "Brain", color: null } });
  });

  it("accepts only the palette", async () => {
    const { f, project } = await projectFixture();
    for (const bad of [{ icon: "Skull" }, { color: "#ff0000" }, { color: "blue", css: "x" }])
      await expect(set(f, project.id, bad)).rejects.toThrow();
    expect(f.store.project(project.id)!.appearance).toEqual({ icon: null, color: null });
  });

  it("is the user's: agent tools and an agent's CLI cannot change it", async () => {
    const { f, project } = await projectFixture();
    const cli = await f.harness.runCli(["command", JSON.stringify({ action: "appearance", icon: "Bug" }), project.id], { threadId: "coordinator" });
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr ?? cli.stdout).toMatch(/Only the user changes an Initiative's icon or color/);
    await expect(f.harness.callAgentTool("initiative_manage", { action: "appearance", icon: "Bug" }, { threadId: "coordinator" })).rejects.toThrow();
    expect(f.store.project(project.id)!.appearance).toEqual({ icon: null, color: null });
    const user = await f.harness.runCli(["command", JSON.stringify({ action: "appearance", icon: "Bug" }), project.id]);
    expect(user.exitCode).toBe(0);
    expect(f.store.project(project.id)!.appearance.icon).toBe("Bug");
  });

  it("reads a legacy or unknown stored value as the default rather than failing the record", async () => {
    const { f, project } = await projectFixture();
    for (const raw of ["{broken", JSON.stringify({ icon: "Skull", color: "chartreuse" }), JSON.stringify({ icon: "Star" })]) {
      f.store.db.prepare("UPDATE projects SET appearance = ? WHERE id = ?").run(raw, project.id);
      expect(f.store.project(project.id)!.appearance).toEqual(raw.includes("Star") ? { icon: "Star", color: null } : { icon: null, color: null });
    }
  });
});
