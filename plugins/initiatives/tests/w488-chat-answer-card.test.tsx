// @vitest-environment jsdom
// W488: a blocker answer the coordinator recorded from chat reads as the user's answer, given in
// chat, on its Inbox card and in Archive; an Inbox answer reads as before.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };

async function answered(inChat: boolean) {
  const { f, project } = await projectFixture();
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id, "Deploy Tekk Paris").ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  if (inChat) await f.service.recordChatBlockerAnswer(project.id, "A1", question, "Use the staging keys.", { author: "coordinator", threadId: "coordinator", assignment: null });
  else await f.service.answerBlocker(project.id, "A1", { question, context }, "Use the staging keys.", "coordinator");
  const o = await f.overview(project.id);
  const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, { rpc: { overview: async () => o } } as never);
  slots.push(slot);
  return { slot, card: await slot.findByRole("region", { name: "Blocked workers" }) };
}

async function archiveOwner(slot: ReturnType<typeof renderSlot>) {
  fireEvent.click(await slot.findByRole("button", { name: "More views" }));
  fireEvent.click(slot.getByRole("button", { name: "Archive" }));
  const row = await slot.findByRole("article", { name: "D1" });
  return row.querySelector(".cr-owner")!.textContent;
}

describe("W488 a chat answer on the blocker card", () => {
  it("says the user gave it in chat and that the card stays until the coordinator acts", async () => {
    const { slot, card } = await answered(true);
    expect(within(card).getByText(/^Your answer in chat, recorded by the coordinator · D1/)).toBeTruthy();
    expect(within(card).getByRole("status").textContent).toBe("This stays here until the coordinator continues W1 or settles A1.");
    expect(within(card).getByRole("button", { name: "Change answer" })).toBeTruthy();
    expect(await archiveOwner(slot)).toBe("Yours, in chat");
  });

  it("an Inbox answer reads as before", async () => {
    const { slot, card } = await answered(false);
    expect(within(card).getByText(/^Your answer · D1/)).toBeTruthy();
    expect(within(card).queryByText(/in chat/)).toBeNull();
    expect(await archiveOwner(slot)).toBe("Yours");
  });
});
