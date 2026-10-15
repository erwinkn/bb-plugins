// @vitest-environment jsdom
// W476 (v9 §10.2): a blocked report carries options and a recommendation, and
// its Inbox card answers like a question: pick an option (detail optional) or
// Other (text required), sent to the coordinator or straight to the worker.
// The recipient reads the picked label verbatim, then the detail. The options
// and the pick are stored beside the JSON the previous build decodes.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture, report } from "./fake-native";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const question = "Row lock or advisory lock for the swap reconciliation?";
const options = [
  { label: "Accept as is (advisory lock)", consequences: "Balance reads stay unblocked." },
  { label: "More work: take the row lock", consequences: "4 more review rounds." },
  { label: "Drop the PR", consequences: "" },
];
const recommendation = "Accept as is (advisory lock): same safety in the race test, no blocked reads.";
const sentTo = (f: Fx, threadId: string) => f.send.mock.calls.map(([args]) => args).filter((args) => args.threadId === threadId);
const raw = (f: Fx, sql: string, ...params: unknown[]) => f.store.db.prepare(sql).get(...params) as Record<string, string | null>;

/** W1 reports blocked through initiative_report, with or without options. */
async function blockedWorker(withOptions = true) {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Swap reconciliation");
  const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.harness.callAgentTool("initiative_report", {
    outcome: "blocked", summary: "Still rejected after 4 rounds: lock choice.", question, report: "Full report.",
    ...(withOptions ? { options, recommendation } : {}),
  }, { threadId: a.threadId! });
  f.idle(a.threadId!);
  f.send.mockClear();
  const blocker = (await f.overview(project.id, "summary")).blockers[0]!;
  return { f, project, threadId: a.threadId!, seen: { question: blocker.question, context: blocker.context } };
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

describe("W476 a blocked report's options", () => {
  it("reach the Inbox item, stored beside the report JSON the previous build reads", async () => {
    const { f, project } = await blockedWorker();
    expect((await f.overview(project.id, "summary")).blockers[0]).toMatchObject({ question, options, recommendation });
    const row = raw(f, "SELECT report, blocker_options FROM assignments WHERE project_id = ? AND num = 1", project.id);
    expect(JSON.parse(row.report!).blocker).toEqual({ question, context: "Still rejected after 4 rounds: lock choice." });
    expect(JSON.parse(row.blocker_options!)).toEqual({ options, recommendation });
  });

  it("a later report replaces them; one without options clears them", async () => {
    const { f, project, threadId } = await blockedWorker();
    await f.service.report(threadId, report() as never);
    expect(raw(f, "SELECT blocker_options FROM assignments WHERE project_id = ? AND num = 1", project.id).blocker_options).toBeNull();
  });

  it("read back exactly as filed, so an identical re-file is recognized and its lead is told once", async () => {
    for (const extra of [{ recommendation }, { options: [] as typeof options }]) {
      const { f, project } = await projectFixture();
      const task = f.task(project.id, "Swap reconciliation");
      const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
      f.send.mockClear();
      const file = () => f.harness.callAgentTool("initiative_report", { outcome: "blocked", summary: "Lock choice.", question, report: "Full report.", ...extra }, { threadId: a.threadId! });
      await file();
      const filed = f.store.assignment(project.id, 1)!.report;
      await file();
      expect(f.store.assignment(project.id, 1)!.report).toEqual(filed);
      expect(sentTo(f, "coordinator")).toHaveLength(1);
    }
  });

  it("refuses two options with the same label, since the answer names its option by label", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Swap reconciliation");
    const [a] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
    await expect(f.harness.callAgentTool("initiative_report", {
      outcome: "blocked", summary: "Lock choice.", question, report: "r",
      options: [{ label: "Proceed", consequences: "Now." }, { label: "proceed ", consequences: "Later." }],
    }, { threadId: a.threadId! })).rejects.toThrow(/Option labels must be unique/);
    expect(f.store.assignment(project.id, 1)!.report).toBeNull();
  });

  it("an older report without options still lists the blocker, with no options", async () => {
    const { f, project } = await blockedWorker(false);
    expect((await f.overview(project.id, "summary")).blockers[0]).toMatchObject({ question, options: [], recommendation: null });
  });
});

describe("W476 answering a blocker with an option", () => {
  it("to the coordinator: the label verbatim, then the detail; the pick is stored beside the answer", async () => {
    const { f, project, seen } = await blockedWorker();
    const d = await f.service.answerBlocker(project.id, "A1", seen, "Keep the race test in CI.", "coordinator", options[0]!.label);
    expect(d.body.answer).toMatchObject({ choice: options[0]!.label, note: "Keep the race test in CI." });
    expect(d.description).toBe("Accept as is (advisory lock) · Keep the race test in CI.");
    const [notice] = sentTo(f, "coordinator");
    expect(notice!.input[0].text).toContain("Answer: Accept as is (advisory lock)\nDetail: Keep the race test in CI.\n\nContinue W1");
    // The JSON keeps the previous build's shape (choice null); the pick lives in its own column.
    const row = raw(f, "SELECT body, blocker_choice FROM knowledge WHERE project_id = ? AND num = ?", project.id, d.num);
    expect(JSON.parse(row.body!).answer.choice).toBeNull();
    expect(row.blocker_choice).toBe(options[0]!.label);
    expect((await f.overview(project.id, "summary")).blockers[0]!.answer).toMatchObject({ ref: d.ref, choice: options[0]!.label, note: "Keep the race test in CI." });
  });

  it("to the worker with no detail: the label alone, in the message and the FYI", async () => {
    const { f, project, threadId, seen } = await blockedWorker();
    await f.service.answerBlocker(project.id, "A1", seen, "", "worker", "Drop the PR");
    expect(sentTo(f, threadId)[0]!.input[0].text).toContain("Answer: Drop the PR\n\nContinue A1");
    expect(sentTo(f, "coordinator")[0]!.input[0].text).toContain("Answer: Drop the PR\n\nW1 continues");
  });

  it("refuses a label that is not one of the options, and an empty answer", async () => {
    const { f, project, seen } = await blockedWorker();
    await expect(f.service.answerBlocker(project.id, "A1", seen, "", "coordinator", "Something else")).rejects.toThrow(/not one of A1's options/);
    await expect(f.service.answerBlocker(project.id, "A1", seen, "  ", "coordinator")).rejects.toThrow(/Pick an option or write an answer/);
    await expect(f.harness.callRpc("command", { projectId: project.id, command: { action: "blocker-answer", assignment: "A1", ...seen, note: "  " } })).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("the same pick is a retry; a different pick supersedes and is sent again", async () => {
    const { f, project, seen } = await blockedWorker();
    const first = await f.service.answerBlocker(project.id, "A1", seen, "", "coordinator", options[0]!.label);
    expect(await f.service.answerBlocker(project.id, "A1", seen, "", "coordinator", options[0]!.label)).toMatchObject({ ref: first.ref });
    const second = await f.service.answerBlocker(project.id, "A1", seen, "", "coordinator", options[1]!.label);
    expect(second).toMatchObject({ supersedes: first.num, body: { answer: { choice: options[1]!.label } } });
    expect(sentTo(f, "coordinator")).toHaveLength(2);
  });
});

describe("W476 the Blocked workers card", () => {
  it("lists the options, marks the recommended one, and sends a pick with optional detail", async () => {
    const { f, project } = await blockedWorker();
    const slot = dashboard(f, project.id);
    const card = await slot.findByRole("region", { name: "Blocked workers" });
    const group = within(card).getByRole("radiogroup");
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual([...options.map((o) => o.label), "__other__"]);
    expect(within(group).getByRole("radio", { name: /^Accept as is \(advisory lock\) Recommended/ })).toBeTruthy();
    expect(within(card).getByText("W1 recommends")).toBeTruthy();
    const send = () => within(card).getByRole("button", { name: "Send to coordinator" }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    expect(within(card).queryByLabelText("Add detail (optional)")).toBeNull();
    fireEvent.click(within(group).getByRole("radio", { name: /^More work: take the row lock/ }));
    expect(send().disabled).toBe(false);
    fireEvent.change(within(card).getByLabelText("Add detail (optional)"), { target: { value: "Row lock, then ship." } });
    fireEvent.click(send());
    await waitFor(() => expect(sentTo(f, "coordinator")).toHaveLength(1));
    expect(sentTo(f, "coordinator")[0]!.input[0].text).toContain("Answer: More work: take the row lock\nDetail: Row lock, then ship.");
    // Answered: the pick, then the detail; Change answer comes back with the pick selected.
    expect(await within(card).findByText("More work: take the row lock", { selector: ".cr-blocker-choice" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Change answer" }));
    expect((within(card).getByRole("radio", { name: /^More work: take the row lock/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByLabelText("Add detail (optional)") as HTMLTextAreaElement).value).toBe("Row lock, then ship.");
  });

  it("keeps the pick by its label when a refresh reorders the options, and drops it when the option goes", async () => {
    const { f, project } = await blockedWorker();
    const slot = dashboard(f, project.id);
    const card = await slot.findByRole("region", { name: "Blocked workers" });
    fireEvent.click(within(card).getByRole("radio", { name: /^Accept as is/ }));
    const store = (list: typeof options) => f.store.db.prepare("UPDATE assignments SET blocker_options = ? WHERE project_id = ? AND num = 1").run(JSON.stringify({ options: list, recommendation }), project.id);
    store([...options].reverse());
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await waitFor(() => expect(within(card).getAllByRole("radio")[0]!.getAttribute("value")).toBe("Drop the PR"));
    expect((within(card).getByRole("radio", { name: /^Accept as is/ }) as HTMLInputElement).checked).toBe(true);
    store(options.slice(1));
    await slot.behavior.emitRealtime("initiatives-changed", { projectId: project.id });
    await waitFor(() => expect(within(card).queryByRole("radio", { name: /^Accept as is/ })).toBeNull());
    expect(within(card).getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect((within(card).getByRole("button", { name: "Send to coordinator" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Other needs the written answer, sent to the worker from the menu", async () => {
    const { f, project, threadId } = await blockedWorker();
    const slot = dashboard(f, project.id);
    const card = await slot.findByRole("region", { name: "Blocked workers" });
    fireEvent.click(within(card).getByRole("radio", { name: "Other Write your own answer." }));
    const send = within(card).getByRole("button", { name: "Send to coordinator" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText("Your answer"), { target: { value: "Pair with W2 on it first." } });
    expect(send.disabled).toBe(false);
    fireEvent.click(within(card).getByRole("button", { name: "More send options" }));
    fireEvent.click(within(card).getByRole("menuitem", { name: "Send to W1" }));
    await waitFor(() => expect(sentTo(f, threadId)).toHaveLength(1));
    expect(sentTo(f, threadId)[0]!.input[0].text).toContain("Answer: Pair with W2 on it first.\n\nContinue A1");
  });

  it("a report without options keeps the plain written answer", async () => {
    const { f, project } = await blockedWorker(false);
    const slot = dashboard(f, project.id);
    const card = await slot.findByRole("region", { name: "Blocked workers" });
    expect(within(card).queryByRole("radiogroup")).toBeNull();
    fireEvent.change(within(card).getByLabelText("Your answer"), { target: { value: "Advisory lock is fine." } });
    fireEvent.click(within(card).getByRole("button", { name: "Send to coordinator" }));
    await waitFor(() => expect(sentTo(f, "coordinator")).toHaveLength(1));
    expect(sentTo(f, "coordinator")[0]!.input[0].text).toContain("Answer: Advisory lock is fine.\n\nContinue W1");
  });

  it("a failed send retries with the same pick", async () => {
    const { f, project } = await blockedWorker();
    f.send.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
    const slot = dashboard(f, project.id);
    const card = await slot.findByRole("region", { name: "Blocked workers" });
    fireEvent.click(within(card).getByRole("radio", { name: /^Drop the PR/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Send to coordinator" }));
    fireEvent.click(await within(card).findByRole("button", { name: "Retry sending to the coordinator" }));
    await waitFor(() => expect(sentTo(f, "coordinator")).toHaveLength(2));
    expect(sentTo(f, "coordinator")[1]!.input[0].text).toContain("Answer: Drop the PR\n\nContinue W1");
    expect(f.store.decisions(project.id).filter((d) => d.body.blocker)).toHaveLength(1);
  });
});

describe("W476 a question's answer", () => {
  it("reads as the label verbatim, then the detail", async () => {
    const { f, project } = await projectFixture();
    const q = f.service.recordQuestion(project.id, { title: "Scope", question: "Include archives?", context: "Need scope", humanAttention: "needs-opinion", options: [{ label: "Yes", consequences: "" }] }, { author: "coordinator", threadId: "coordinator", assignment: null });
    await f.service.answerOpinion(project.id, q.ref, { choice: "Yes", note: "Only the last year." });
    expect(sentTo(f, "coordinator").at(-1)!.input[0].text).toContain("Include archives?\nAnswer: Yes\nDetail: Only the last year.");
  });
});
