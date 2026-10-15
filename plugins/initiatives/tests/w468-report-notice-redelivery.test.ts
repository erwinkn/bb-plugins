import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";

// W468: BB can reject the turn a report notice starts ("competing turn") and says so only with a
// client/turn/rejected event in the lead's history. The notice is checked against that history
// and sent again once the lead's turn has ended; an accepted one is never sent twice.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const REPORT = "## Done\n\nArchived records are indexed.\n\nRan npm test: 14 passed.";
let seq = 5000;

type Outcome = "accepted" | "rejected" | "unrecorded" | "unresolved";
const push = (f: Fx, row: { type: string; threadId: string; data: Record<string, unknown> }) => f.history.push({ ...row, seq: ++seq, createdAt: Date.now() });
/** What BB does with each send: record the turn request, then take it, refuse it or say nothing. */
function bbReceives(f: Fx, outcomes: Outcome[]) {
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (args: Record<string, any>) => {
    const outcome = outcomes.shift() ?? "accepted";
    if (outcome !== "unrecorded") {
      const requestId = `creq_${++seq}`;
      push(f, { type: "client/turn/requested", threadId: args.threadId, data: { requestId, initiator: "agent", senderThreadId: args.senderThreadId, input: args.input } });
      if (outcome === "accepted") push(f, { type: "turn/input/accepted", threadId: args.threadId, data: { clientRequestId: requestId } });
      if (outcome === "rejected") push(f, { type: "client/turn/rejected", threadId: args.threadId, data: { requestId, reason: "competing_turn", message: "Another turn is starting" } });
    }
    return original(args);
  });
}
const notice = (f: Fx, num = 1) => f.store.reportNotice(f.store.projects()[0]!.id, num)!;
/** The last send is old enough for BB's verdict to be in the history. */
const aged = (f: Fx) => f.store.db.prepare("UPDATE report_notices SET sent_at = sent_at - 60000, started_at = started_at - 60000").run();
const lead = (f: Fx, status: "idle" | "active") => f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status });
/** BB's own retry of a refused request: the same message again, naming the original request. */
const retryOf = (f: Fx, original: string, outcome: "accepted" | "rejected" | "unresolved") => {
  const first = f.history.find(r => r.type === "client/turn/requested" && r.data!.requestId === original)!;
  const requestId = `creq_${++seq}`;
  push(f, { type: "client/turn/requested", threadId: "coordinator", data: { ...first.data, requestId, retryOfRequestId: original } });
  if (outcome === "accepted") push(f, { type: "turn/input/accepted", threadId: "coordinator", data: { clientRequestId: requestId } });
  if (outcome === "rejected") push(f, { type: "client/turn/rejected", threadId: "coordinator", data: { requestId } });
  return requestId;
};
const lastRequest = (f: Fx) => f.history.filter(r => r.type === "client/turn/requested").at(-1)!;

async function reported(outcomes: Outcome[]) {
  const { f, project } = await projectFixture();
  const task = f.task(project.id, "Archived search");
  const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
  bbReceives(f, outcomes);
  await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives", report: REPORT }, w.threadId);
  return { f, project, w };
}

describe("W468 report notice redelivery", () => {
  it("a refused notice goes out again when the lead's turn has ended, and not before", async () => {
    const { f } = await reported(["rejected", "accepted"]);
    expect(f.send).toHaveBeenCalledTimes(1);
    aged(f);
    lead(f, "active");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    lead(f, "idle");
    await f.runtime.onThreadIdle(f.threads.get("coordinator")!);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1][0].input[0].text).toBe(f.send.mock.calls[0][0].input[0].text);
    // The second send was taken: nothing more, now or on later sweeps.
    aged(f);
    await f.service.redeliverReports();
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(notice(f).open).toBe(false);
  });

  it("the sweep sends a notice that BB never recorded, once the lead is idle", async () => {
    const { f } = await reported(["unrecorded", "accepted"]);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    aged(f);
    await f.service.checkWorkers();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("a notice BB took is not sent again", async () => {
    const { f } = await reported(["accepted"]);
    aged(f);
    lead(f, "idle");
    await f.service.checkWorkers();
    await f.runtime.onThreadIdle(f.threads.get("coordinator")!);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("a request with no verdict yet stays open, and is sent again if BB refuses it later", async () => {
    const { f } = await reported(["unresolved", "accepted"]);
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(notice(f).open).toBe(true);
    push(f, { type: "client/turn/rejected", threadId: "coordinator", data: { requestId: lastRequest(f).data!.requestId } });
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("gives up after three sends and says so in the activity log", async () => {
    const { f, project } = await reported(["rejected", "rejected", "rejected"]);
    lead(f, "idle");
    for (let pass = 0; pass < 5; pass++) {
      aged(f);
      await f.service.redeliverReports();
    }
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.store.activity(project.id, 100).some(a => /never reached its lead after 3 sends/.test(a.summary))).toBe(true);
    expect(notice(f).open).toBe(false);
  });

  it("a notice BB queued is BB's while it waits; once dispatched, BB's verdict decides", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Archived search");
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
    f.queueSend("qm9");
    await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives", report: REPORT }, w.threadId);
    f.queued.set("coordinator", [{ id: "qm9", payload: { kind: "inline" }, content: [] } as never]);
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(notice(f).open).toBe(true);
    // BB dispatched it, and the daemon refused the turn: that is still ours to resend.
    f.queued.set("coordinator", []);
    bbReceives(f, ["accepted"]);
    const text = f.send.mock.calls[0][0];
    const requestId = `creq_${++seq}`;
    push(f, { type: "client/turn/requested", threadId: "coordinator", data: { requestId, initiator: "agent", senderThreadId: text.senderThreadId, input: text.input } });
    push(f, { type: "client/turn/rejected", threadId: "coordinator", data: { requestId } });
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("a send still in flight is not sent again by the sweep", async () => {
    const { f, project } = await projectFixture();
    const task = f.task(project.id, "Archived search");
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it.", tasks: [task.ref] });
    let release!: () => void;
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async (args: any) => { await new Promise<void>(r => { release = r; }); return original(args); });
    const reporting = tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives", report: REPORT }, w.threadId);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    release();
    await reporting;
  });

  it("a delayed acceptance of an earlier send of the notice settles it", async () => {
    const { f } = await reported(["rejected", "rejected", "accepted"]);
    const first = lastRequest(f).data!.requestId;
    lead(f, "idle");
    aged(f);
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(2);
    push(f, { type: "turn/input/accepted", threadId: "coordinator", data: { clientRequestId: first } });
    aged(f);
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(notice(f).open).toBe(false);
  });

  it("the sweep and the idle event together send a refused notice once", async () => {
    const { f } = await reported(["rejected", "accepted"]);
    aged(f);
    lead(f, "idle");
    await Promise.all([f.service.redeliverReports(), f.runtime.onThreadIdle(f.threads.get("coordinator")!)]);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("a different report on the assignment starts its own notice; the old one's verdict does not settle it", async () => {
    const { f, w } = await reported(["accepted", "unrecorded", "accepted"]);
    const first = notice(f).hash;
    await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives, revised", report: `${REPORT}\n\nRevised.` }, w.threadId);
    expect(notice(f)).toMatchObject({ open: true, attempts: 1 });
    expect(notice(f).hash).not.toBe(first);
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(3);
    // The same report filed again is no new notice.
    await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives, revised", report: `${REPORT}\n\nRevised.` }, w.threadId);
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it("finds a notice BB took among more than a page of newer requests", async () => {
    const { f } = await reported(["accepted"]);
    for (let i = 0; i < 120; i++) push(f, { type: "client/turn/requested", threadId: "coordinator", data: { requestId: `other${i}`, initiator: "user", input: [{ type: "text", text: "hello" }] } });
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(notice(f).open).toBe(false);
  });

  it("a retired worker's refused notice is still sent again", async () => {
    const { f, project } = await reported(["rejected", "accepted"]);
    f.store.updateWorker(project.id, 1, { state: "retired" });
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  describe("when BB holds a retry of the refused turn", () => {
    it("does not send while the retry is queued, nor after it was taken", async () => {
      const { f } = await reported(["rejected"]);
      const refused = lastRequest(f).data!.requestId as string;
      f.queued.set("coordinator", [{ id: "q1", payload: { kind: "retry", attempt: 1, reason: "competing_turn", retryOfTurnRequestId: refused }, content: [] } as never]);
      aged(f);
      lead(f, "idle");
      await f.service.redeliverReports();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(notice(f).open).toBe(true);
      // BB sent the retry after the turn ended, and the daemon took it.
      f.queued.set("coordinator", []);
      retryOf(f, refused, "accepted");
      await f.service.redeliverReports();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(notice(f).open).toBe(false);
    });

    it("every retry names the original request: a refused retry with another queued is still BB's", async () => {
      const { f } = await reported(["rejected"]);
      const refused = lastRequest(f).data!.requestId as string;
      retryOf(f, refused, "rejected");
      f.queued.set("coordinator", [{ id: "q2", payload: { kind: "retry", attempt: 2, reason: "competing_turn", retryOfTurnRequestId: refused }, content: [] } as never]);
      aged(f);
      lead(f, "idle");
      await f.service.redeliverReports();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(notice(f).open).toBe(true);
    });

    it("a retry dispatched between the history read and the queue read is not sent again", async () => {
      const { f } = await reported(["rejected"]);
      const refused = lastRequest(f).data!.requestId as string;
      f.queued.get = () => { f.queued.get = Map.prototype.get; retryOf(f, refused, "accepted"); return []; };
      aged(f);
      lead(f, "idle");
      await f.service.redeliverReports();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(notice(f).open).toBe(false);
    });

    it("sends again when the retries were refused and none is queued", async () => {
      const { f } = await reported(["rejected", "accepted"]);
      retryOf(f, lastRequest(f).data!.requestId as string, "rejected");
      aged(f);
      lead(f, "idle");
      await f.service.redeliverReports();
      expect(f.send).toHaveBeenCalledTimes(2);
    });

    it("an unanswered retry keeps the notice pending", async () => {
      const { f } = await reported(["rejected"]);
      retryOf(f, lastRequest(f).data!.requestId as string, "unresolved");
      aged(f);
      lead(f, "idle");
      await f.service.redeliverReports();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(notice(f).open).toBe(true);
    });
  });

  it("renaming the Initiative after the notice was taken does not send it again", async () => {
    const { f, project } = await reported(["accepted"]);
    f.store.db.prepare("UPDATE projects SET name = 'Renamed' WHERE id = ?").run(project.id);
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(notice(f).open).toBe(false);
  });

  it("a notice that only extends another's text is a different message", async () => {
    const { f, w } = await reported(["accepted", "unrecorded"]);
    await tool(f, "initiative_report", { outcome: "done", summary: "Search covers archives", report: REPORT.slice(0, 30) }, w.threadId);
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it("a lead whose history is gone (404) gets the notice at the lead now current", async () => {
    const { f, project } = await reported(["rejected", "accepted"]);
    f.intercept((path, args, call) => {
      if (path === "threads.events.list" && args.threadId === "coordinator" && gone) throw Object.assign(new Error("Not found"), { status: 404 });
      return call();
    });
    let gone = true;
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    // The coordinator is still its lead here, so it is sent again rather than left open silently.
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.store.activity(project.id, 100).some(a => /went to a lead that is gone/.test(a.summary))).toBe(true);
    gone = false;
  });

  it("finds an accepted notice that BB ran in one turn with another message from the same worker", async () => {
    const { f } = await reported(["unrecorded"]);
    const sent = f.send.mock.calls[0][0];
    const requestId = `creq_${++seq}`;
    const header = `[bb message from thread:${sent.senderThreadId}; sent 2026-10-15T10:00:00Z]\n`;
    push(f, { type: "client/turn/requested", threadId: "coordinator", data: { requestId, initiator: "agent", senderThreadId: sent.senderThreadId,
      input: [...sent.input, { type: "text", text: `${header}Also: tests are green.` }],
      inputGroups: [sent.input, [{ type: "text", text: `${header}Also: tests are green.` }]] } });
    push(f, { type: "turn/input/accepted", threadId: "coordinator", data: { clientRequestId: requestId } });
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(notice(f).open).toBe(false);
  });

  it("a history read that fails other than with 404 sends nothing", async () => {
    const { f } = await reported(["accepted"]);
    f.intercept((path, args, call) => {
      if (path === "threads.events.list") throw Object.assign(new Error("Response too large"), { status: 413 });
      return call();
    });
    aged(f);
    lead(f, "idle");
    await f.service.redeliverReports();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(notice(f).open).toBe(true);
  });
});
