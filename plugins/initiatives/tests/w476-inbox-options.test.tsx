// W476 (v9 §10.2): a blocked report carries options and a recommendation, stored beside the
// JSON the previous build decodes. W555: they reach the coordinator, which asks the user.
import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";

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
  const [notice] = sentTo(f, "coordinator");
  f.send.mockClear();
  return { f, project, threadId: a.threadId!, notice: notice?.input[0].text as string | undefined };
}

describe("W476 a blocked report's options", () => {
  it("reach the coordinator's notice and the report, stored beside the report JSON the previous build reads", async () => {
    const { f, project, notice } = await blockedWorker();
    expect(notice).toContain(`W1 is blocked on A1: ${question}\n\nOptions:\n- Accept as is (advisory lock): Balance reads stay unblocked.\n- More work: take the row lock: 4 more review rounds.\n- Drop the PR\nRecommendation: ${recommendation}\n\nFull report.`);
    expect(f.store.assignment(project.id, 1)!.report!.blocker).toMatchObject({ question, options, recommendation });
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

  it("a report without options tells the coordinator only the question", async () => {
    const { f, project, notice } = await blockedWorker(false);
    expect(notice).toContain(`W1 is blocked on A1: ${question}\n\nFull report.`);
    expect(notice).not.toContain("Options:");
    expect(f.store.assignment(project.id, 1)!.report!.blocker).not.toHaveProperty("options");
  });
});
