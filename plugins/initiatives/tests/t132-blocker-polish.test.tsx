// @vitest-environment jsdom
// T132: the blocker card's question and context go to BB's Markdown whole
// (the live app renders them; the test host echoes the source), and the
// coordinator FYI after Send to W# is a notice like any other: retried after a
// failure, never after an unconfirmed send, and shown until delivered, also
// once the card is gone.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Which **Railway** env keys does `tekk-paris` need? See [the runbook](https://example.com/runbook).";
const context = "The deploy needs `STRIPE_KEY` and the **Postmark** token.";
const blocked = { ...report(), outcome: "blocked" as const, summary: "Blocked on secrets.", blocker: { question, context } };
const seen = { question, context };
const sentTo = (f: Fx, threadId: string) => f.send.mock.calls.map(([args]) => args).filter((args) => args.threadId === threadId);
const refused = () => Object.assign(new Error("refused"), { status: 400 });

async function blockedWorker() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Deploy Tekk Paris");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(a.threadId!, blocked as never);
  f.idle(a.threadId!);
  f.send.mockClear();
  return { f, project, threadId: a.threadId! };
}
function dashboard(f: Fx, projectId: string) {
  const slot = renderSlot({ component: Dashboard }, { projectId }, {
    rpc: {
      overview: (input: unknown) => f.harness.callRpc("overview", input),
      command: (input: unknown) => f.harness.callRpc("command", input),
    },
  } as never);
  slots.push(slot);
  return slot;
}

describe("T132 blocker card Markdown", () => {
  it("passes the question and context whole to BB's Markdown, never as plain text", async () => {
    const { f, project } = await blockedWorker();
    const slot = dashboard(f, project.id);
    const section = await slot.findByRole("region", { name: "Blocked workers" });
    // The test host's Markdown echoes its source; live BB renders bold, code and links from it.
    expect(Array.from(section.querySelectorAll("[data-testid=bb-markdown]")).map((el) => el.textContent)).toEqual([question, context]);
    expect(Array.from(section.querySelectorAll(".cr-detail > .cr-blocker > :not([data-testid=bb-markdown])")).some((el) => el.textContent?.includes("**"))).toBe(false);
  });
});

describe("T132 the Send to W# FYI is a retried notice", () => {
  it("a failed FYI is retried alone; the worker is not sent the answer again", async () => {
    const { f, project, threadId } = await blockedWorker();
    f.send.mockResolvedValueOnce({ delivery: "sent" } as never).mockRejectedValueOnce(refused());
    const d = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(d).toMatchObject({ notification: { state: "failed", coordinatorThreadId: "coordinator" }, body: { answer: { delivery: { state: "sent", threadId } } } });
    const retried = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(retried).toMatchObject({ ref: d.ref, notification: { state: "sent" } });
    expect(sentTo(f, threadId)).toHaveLength(1);
    expect(sentTo(f, "coordinator")).toHaveLength(2);
    // Delivered: nothing more is sent.
    await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it("an unconfirmed FYI is never sent again", async () => {
    const { f, project } = await blockedWorker();
    f.send.mockResolvedValueOnce({ delivery: "sent" } as never).mockRejectedValueOnce(new Error("socket hang up"));
    const d = await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(d.notification).toMatchObject({ state: "uncertain" });
    await f.service.answerBlocker(project.id, "A1", seen, "Use the staging keys.", "worker");
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("the card shows a failed FYI with its retry, and once the worker reports again the Inbox keeps it under Not delivered", async () => {
    const { f, project, threadId } = await blockedWorker();
    f.send.mockResolvedValueOnce({ delivery: "sent" } as never).mockRejectedValueOnce(refused());
    const slot = dashboard(f, project.id);
    fireEvent.change(await slot.findByLabelText("Your answer"), { target: { value: "Use the staging keys." } });
    fireEvent.click(slot.getByRole("button", { name: "More send options" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Send to W1" }));
    expect(await slot.findByText(/Sent to W1, which continues with it, but the coordinator FYI failed: refused/)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Retry coordinator FYI" })).toBeTruthy();
    // W1 continues and reports again: the card goes, the undelivered FYI stays visible.
    await f.service.report(threadId, report() as never);
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    const undelivered = await slot.findByRole("region", { name: "Not delivered" });
    await waitFor(() => expect(slot.queryByRole("region", { name: "Blocked workers" })).toBeNull());
    expect(within(undelivered).getByText(/but the coordinator FYI failed/)).toBeTruthy();
    fireEvent.click(within(undelivered).getByRole("button", { name: "Retry coordinator FYI" }));
    await waitFor(() => expect(sentTo(f, "coordinator")).toHaveLength(2));
    expect(sentTo(f, threadId)).toHaveLength(1);
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await waitFor(() => expect(slot.queryByRole("region", { name: "Not delivered" })).toBeNull());
  });

  it("a failed delivery to the worker is retried, then the FYI goes out once", async () => {
    const { f, project, threadId } = await blockedWorker();
    f.send.mockRejectedValueOnce(refused());
    const slot = dashboard(f, project.id);
    fireEvent.change(await slot.findByLabelText("Your answer"), { target: { value: "Use the staging keys." } });
    fireEvent.click(slot.getByRole("button", { name: "More send options" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Send to W1" }));
    expect(await slot.findByText(/Sending to W1 failed: refused/)).toBeTruthy();
    expect(sentTo(f, "coordinator")).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Retry sending to W1" }));
    expect(await slot.findByText(/Sent to W1, which continues with it; the coordinator got an FYI/)).toBeTruthy();
    expect(sentTo(f, threadId)).toHaveLength(2);
    expect(sentTo(f, "coordinator")).toHaveLength(1);
  });
});
