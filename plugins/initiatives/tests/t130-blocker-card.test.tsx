// @vitest-environment jsdom
// T130: the Blocked workers card is two split buttons. Send to coordinator
// (default) or straight to the worker, with an FYI to the coordinator; Dismiss
// silently or tell the coordinator, the note field appearing only then. The
// worker label links its thread.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which Railway env keys does Tekk Paris need?";
const context = "The deploy needs two secrets only Erwin has.";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };
const seen = { question, context };
const sentTo = (f: Fx, threadId: string) => f.send.mock.calls.map(([args]) => args).filter((args) => args.threadId === threadId);

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  f.send.mockClear();
  return { f, project, threadId: a.threadId! };
}

describe("T130 answering a blocker straight to the worker", () => {
  it("delivers to the worker's thread, records the user's decision, and gives the coordinator one FYI", async () => {
    const { f, project, threadId } = await blockedWorker();
    const d = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(d).toMatchObject({ madeBy: "user", notification: { state: "sent", coordinatorThreadId: threadId }, body: { answer: { note: "Use the staging keys.", to: "worker" } } });
    expect((d.body as { description: string }).description).toBe("Answer to W1's blocker on T1 (A1), sent to W1: Use the staging keys.");
    const toWorker = sentTo(f, threadId);
    expect(toWorker).toHaveLength(1);
    expect(toWorker[0].input[0].text).toMatch(/The user answered your blocker directly \(A1, T1, D\d+\)/);
    expect(toWorker[0].input[0].text).toContain("Answer: Use the staging keys.\n\nContinue A1 with this answer and report again");
    const fyi = sentTo(f, "coordinator");
    expect(fyi).toHaveLength(1);
    expect(fyi[0]).toMatchObject({ mode: "queue-if-active" });
    expect(fyi[0].input[0].text).toMatch(/FYI: the user answered W1's blocker \(A1, T1, D\d+\) directly to W1/);
    // The Inbox shows where it went; the blocker stays until W1 reports again.
    const o = await f.overview(project.id, "summary");
    expect(o.blockers[0]!.answer).toMatchObject({ ref: d.ref, to: "worker" });
    // The worker continues the same assignment and reports again: the blocker clears.
    await f.service.report(threadId, report() as never);
    expect((await f.overview(project.id, "summary")).blockers).toEqual([]);
  });

  it("repeating retries only a failed delivery; a new target supersedes and sends again", async () => {
    const { f, project, threadId } = await blockedWorker();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    const failed = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(failed.notification).toMatchObject({ state: "failed", coordinatorThreadId: threadId });
    // No FYI for an answer the worker never got.
    expect(sentTo(f, "coordinator")).toHaveLength(0);
    const retried = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(retried).toMatchObject({ ref: failed.ref, notification: { state: "sent" } });
    expect(sentTo(f, "coordinator")).toHaveLength(1);
    // Delivered: the same answer to the same target sends nothing more.
    await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(f.send).toHaveBeenCalledTimes(3);
    // The same note to the coordinator is a new choice of target.
    const coordinator = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "coordinator");
    expect(coordinator).toMatchObject({ supersedes: failed.num, notification: { state: "sent", coordinatorThreadId: "coordinator" } });
    expect(coordinator.body.answer).not.toHaveProperty("to");
  });

  it("the command defaults to the coordinator and stays user-only", async () => {
    const { f, project } = await blockedWorker();
    const d = await f.harness.callRpc("command", { projectId: project.id, command: { action: "blocker-answer", assignment: "A1", question, context, note: "Use the staging keys." } });
    expect(d).toMatchObject({ notification: { coordinatorThreadId: "coordinator" } });
    await expect(f.harness.callAgentTool("initiative_task", { action: "blocker-answer", assignment: "A1", question, context, note: "x", to: "worker" }, { threadId: "coordinator" })).rejects.toThrow();
  });
});

describe("T130 the Blocked workers card", () => {
  async function card(over: { coordinatorThreadId?: null } = {}) {
    const { f, project, threadId } = await blockedWorker();
    const commands: any[] = [];
    let o = await f.overview(project.id, "summary");
    if ("coordinatorThreadId" in over) o = { ...o, project: { ...o.project, coordinatorThreadId: null } };
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, {
      rpc: {
        overview: async () => o,
        command: async ({ command }: any) => {
          commands.push(command);
          const result = command.action === "blocker-answer"
            ? await f.service.answerBlocker(project.id, command.assignment, seen, command.note, command.to)
            : await f.service.dismissBlocker(project.id, command.assignment, seen, command);
          o = { ...(await f.overview(project.id, "summary")), project: o.project };
          return result;
        },
      },
    } as never);
    slots.push(slot);
    await slot.findByRole("region", { name: "Blocked workers" });
    return { f, slot, commands, threadId };
  }

  it("has no Open worker thread or Open coordinator buttons; W1 links the worker's thread without folding the card", async () => {
    const { slot, threadId } = await card();
    expect(slot.queryByRole("button", { name: "Open worker thread" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Open coordinator" })).toBeNull();
    const details = slot.getByRole("region", { name: "Blocked workers" }).querySelector("details")!;
    expect(details.open).toBe(true);
    fireEvent.click(slot.getByRole("link", { name: "W1" }));
    expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId }]);
    expect(details.open).toBe(true);
  });

  it("sends to the coordinator by default, or to W1 from the chevron menu, opened and moved by keyboard", async () => {
    const { slot, commands } = await card();
    const toggle = slot.getByRole("button", { name: "More send options" });
    expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.change(slot.getByLabelText("Your answer"), { target: { value: "Use the staging keys." } });
    // ↓ opens the menu and focuses its first choice; Escape closes it and returns focus.
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "ArrowDown" });
    const item = await slot.findByRole("menuitem", { name: "Send to W1" });
    await waitFor(() => expect(document.activeElement).toBe(item));
    fireEvent.keyDown(item, { key: "Escape" });
    expect(slot.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.click(slot.getByRole("menuitem", { name: "Send to W1" }));
    await waitFor(() => expect(commands).toEqual([{ action: "blocker-answer", assignment: "A1", question, context, note: "Use the staging keys.", to: "worker" }]));
    expect(await slot.findByText(/Sent to W1, which continues A1 with it; the coordinator got an FYI/)).toBeTruthy();
    expect(slot.getByText(/Your answer · D\d+ · sent to W1/)).toBeTruthy();
  });

  it("without a coordinator, W1 is the default and there is no menu", async () => {
    const { slot, commands } = await card({ coordinatorThreadId: null });
    expect(slot.queryByRole("button", { name: "More send options" })).toBeNull();
    expect(slot.queryByRole("button", { name: "More dismiss options" })).toBeNull();
    fireEvent.change(slot.getByLabelText("Your answer"), { target: { value: "Use the staging keys." } });
    fireEvent.click(slot.getByRole("button", { name: "Send to W1" }));
    await waitFor(() => expect(commands[0]).toMatchObject({ action: "blocker-answer", to: "worker" }));
  });

  it("Dismiss is silent; the note field appears only from Dismiss and tell coordinator…", async () => {
    const { slot, commands } = await card();
    expect(slot.queryByLabelText("Note for the coordinator (optional)")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "More dismiss options" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Dismiss and tell coordinator…" }));
    expect(slot.getByLabelText("Note for the coordinator (optional)")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByLabelText("Note for the coordinator (optional)")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(commands).toEqual([{ action: "blocker-dismiss", assignment: "A1", question, context, notify: false, note: "" }]));
    await waitFor(() => expect(slot.queryByRole("region", { name: "Blocked workers" })).toBeNull());
  });
});
