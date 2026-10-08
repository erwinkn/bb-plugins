import { describe, expect, it } from "vitest";
import { projectFixture, report } from "./fake-native";
import { OPEN_REVIEW_QUERY } from "../lib/store";

// W228 (D440): a worker's thread context names the review pending or running of its latest
// report, so the Account Pooler keeps its prompt cache warm for the fix round. The next round's
// fresh reviewer renews it; the review's report and newer work for the worker end it.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const get = async (f: Fx, path: string) => (await (await f.harness.fetchHttp("GET", path)).json()) as any;
const review = async (f: Fx, threadId: string) => (await get(f, `/context/v1/thread?threadId=${threadId}`)).membership.review;
let seq = 300000;
const brief = (f: Fx) => (f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as { brief_text: string }).brief_text;
async function turn(f: Fx, threadId: string, text: string) {
  const requestId = `creq_${++seq}`;
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: Date.now(), data: { requestId, initiator: "agent", input: [{ type: "text", text: brief(f) }] } });
  f.history.push({ type: "turn/started", seq: ++seq, createdAt: Date.now() });
  f.history.push({ type: "turn/input/accepted", seq: ++seq, createdAt: Date.now(), data: { clientRequestId: requestId } });
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: Date.now(), data: { item: { type: "agentMessage", text } } });
  f.history.push({ type: "turn/completed", seq: ++seq, createdAt: Date.now(), data: { status: "completed" } });
  await f.runtime.onThreadIdle(f.idle(threadId));
}

describe("W228 review in the thread context", () => {
  it("is set while a review of the worker's latest report runs, renewed by the next round's reviewer, and cleared by its report", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    await turn(f, w.threadId, "Done.");
    expect(await review(f, w.threadId)).toBeNull();

    const [r] = await tool(f, "initiative_spawn", { role: "review", label: "Review", purpose: "review search", reviews: "W1", text: "Review it." });
    const first = f.store.assignment(project.id, 2)!;
    expect(await review(f, w.threadId)).toEqual({ ref: "A2", worker: "W2", phase: first.state === "running" ? "active" : "pending", since: first.createdAt });
    // Only the reviewed worker is marked; the coordinator and the reviewer are not.
    expect(await review(f, r.threadId)).toBeNull();
    expect(await review(f, "coordinator")).toBeNull();
    // The members route stays as it was.
    const members = (await get(f, `/context/v1/members?initiativeId=${project.id}`)).members;
    expect(members.every((m: Record<string, unknown>) => !("review" in m))).toBe(true);

    await turn(f, r.threadId, "Two findings.");
    expect(await review(f, w.threadId)).toBeNull();

    await tool(f, "initiative_message", { to: "W1", text: "Fix the findings.", work: true });
    await turn(f, w.threadId, "Fixed both.");
    expect(await review(f, w.threadId)).toBeNull();
    const [again] = await tool(f, "initiative_spawn", { role: "review", label: "Review fixes", purpose: "review the fixes", reviews: "W1", handoffs: ["W2"], text: "Review the fixes." });
    const second = f.store.assignment(project.id, Number(again.assignment.slice(1)))!;
    expect(await review(f, w.threadId)).toMatchObject({ ref: second.ref, worker: "W3", since: second.createdAt });

    // Newer work for the worker while the review still runs: the review is of an older report.
    await tool(f, "initiative_message", { to: "W1", text: "Also do this.", work: true });
    await turn(f, w.threadId, "Did it.");
    expect(await review(f, w.threadId)).toBeNull();
  });

  it("is cleared when the review is stopped", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    await turn(f, w.threadId, "Done.");
    await tool(f, "initiative_spawn", { role: "review", label: "Review", purpose: "review search", reviews: "W1", text: "Review it." });
    expect(await review(f, w.threadId)).toMatchObject({ ref: "A2" });
    await f.service.stopAssignment(project.id, "A2", "Not needed.").catch(() => undefined);
    expect(f.store.assignment(project.id, 2)!.state).not.toMatch(/^(dispatching|queued|running)$/);
    expect(await review(f, w.threadId)).toBeNull();
  });

  it("is cleared when the worker amends the reviewed report on the same assignment", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    await turn(f, w.threadId, "Done.");
    const [r] = await tool(f, "initiative_spawn", { role: "review", label: "Review", purpose: "review search", reviews: "W1", text: "Review it." });
    expect(await review(f, w.threadId)).toMatchObject({ ref: "A2" });
    const reported = f.store.assignment(project.id, 1)!.reportSeq;
    await f.service.report(w.threadId, { ...report(), summary: "Corrected after new evidence." } as never);
    expect(f.store.assignment(project.id, 1)!.reportSeq).toBeGreaterThan(reported);
    // A2 embeds the earlier filing of A1, so it is not a review of the latest report.
    expect(await review(f, w.threadId)).toBeNull();
    await turn(f, r.threadId, "Reviewed the first filing.");
    const [again] = await tool(f, "initiative_spawn", { role: "review", label: "Review again", purpose: "review the amended report", reviews: "W1", handoffs: ["W2"], text: "Review the amended report." });
    expect(await review(f, w.threadId)).toMatchObject({ ref: again.assignment, worker: "W3" });
  });

  it("finds the review through its partial index", async () => {
    const { f } = await projectFixture();
    const plan = (f.store.db.prepare(`EXPLAIN QUERY PLAN ${OPEN_REVIEW_QUERY}`).all("p", "A1", "v") as { detail: string }[])
      .map((row) => row.detail);
    expect(plan).toEqual([expect.stringMatching(/^SEARCH assignments USING INDEX assignments_open_review \(project_id=\? AND <expr>=\? AND <expr>=\?\)$/)]);
  });
});
