// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });
const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const needsYou = async (f: Fx) => ((await f.harness.callRpc("tree", null)) as any).projects[0].needsYou as number;

describe("T114 what waits on the user leads the Initiative status", () => {
  it("counts open questions and blocked reports in the tree, and clears when they are answered, withdrawn or decided", async () => {
    const { f, project } = await projectFixture();
    expect(await needsYou(f)).toBe(0);
    const ask = () => f.service.recordQuestion(project.id, { title: "Kit", humanAttention: "needs-opinion", question: "Which kit?", context: "c" }, coordinator);
    const q1 = ask();
    expect(await needsYou(f)).toBe(1);
    await f.service.answerOpinion(project.id, q1.ref, { choice: null, note: "Base UI", notify: false });
    expect(await needsYou(f)).toBe(0);
    const q2 = ask();
    f.service.withdrawQuestion(project.id, q2.ref, "No longer needed", coordinator);
    expect(await needsYou(f)).toBe(0);
    const t1 = f.task(project.id);
    const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(a.threadId!, { ...report(), outcome: "blocked", blocker: { question: "Which env keys?", context: "Needs Railway access" } } as never);
    expect(await needsYou(f)).toBe(1);
    // The tree keeps opinions for older readers.
    expect(((await f.harness.callRpc("tree", null)) as any).projects[0].opinions).toBe(0);
  });

  it("the dashboard header says it needs you, and the badge opens the Inbox", async () => {
    const { f, project } = await projectFixture();
    f.service.recordQuestion(project.id, { title: "Kit", humanAttention: "needs-opinion", question: "Which kit?", context: "c" }, coordinator);
    const o = await f.overview(project.id, "summary");
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => o } }); slots.push(slot);
    fireEvent.click(await slot.findByRole("tab", { name: "Tasks" }));
    fireEvent.click(slot.getByRole("button", { name: "Needs you · 1" }));
    expect(slot.getByRole("tab", { name: /^Inbox/ }).getAttribute("aria-selected")).toBe("true");
  });
});
