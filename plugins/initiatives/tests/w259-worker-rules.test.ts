import { describe, expect, it } from "vitest";
import { fixture, projectFixture } from "./fake-native";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";

// W259: one PR per worker, model by difficulty, fresh fix workers. The cold-worker refusal has no
// agent override (w213-cold-cache), and the Account Pooler stops warming a reported worker from
// the thread route's assignment.reportedAt.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
const membership = async (f: Fx, threadId: string) =>
  ((await (await f.harness.fetchHttp("GET", `/context/v1/thread?threadId=${threadId}`)).json()) as any).membership;
let seq = 400000;
const brief = (f: Fx) => (f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as { brief_text: string }).brief_text;
async function turn(f: Fx, threadId: string, text: string) {
  const requestId = `creq_${++seq}`;
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: Date.now(), data: { requestId, initiator: "agent", input: [{ type: "text", text: brief(f) }] } });
  f.history.push({ type: "turn/started", seq: ++seq, createdAt: Date.now() });
  f.history.push({ type: "turn/input/accepted", seq: ++seq, createdAt: Date.now(), data: { clientRequestId: requestId } });
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: Date.now(), data: { item: { type: "agentMessage", text } } });
  f.history.push({ type: "turn/completed", seq: ++seq, createdAt: Date.now(), data: { status: "completed" } });
  // v9: only initiative_report finishes work.
  await f.harness.callAgentTool("initiative_report", { outcome: "done", summary: text, report: text }, { threadId });
  await f.runtime.onThreadIdle(f.idle(threadId));
}

describe("W259 coordinator guidance", () => {
  it("sizes work per worker, picks models by difficulty and sends fixes to a fresh worker", () => {
    // v9 reverses W259's fresh fix workers: a worker owns its PR to a clean review, and more work
    // (a rule- or user-settled finding, back to review) goes back to the same worker.
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("One worker per PR (or a few small related ones) with initiative_spawn.");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("very-fast (mechanical: lookups, scans, renames, simple scripted checks).");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("More work goes back to the same worker (initiative_message work:true).");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Don't start reviewers: workers do.");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
  });

  it("a saved copy of the previous default upgrades; the user's edited text stays", async () => {
    const previous = PREVIOUS_DEFAULTS.coordinator.find((text) => text.includes("Send fixes to the same worker"))!;
    expect(previous).toContain("Send fixes to the same worker");
    const f = fixture({ coordinatorInstructions: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration().coordinatorInstructions).toBe(DEFAULT_COORDINATOR_INSTRUCTIONS);

    const edited = `${previous}\n- Always ask Erwin before touching CI.`;
    const g = fixture({ coordinatorInstructions: edited });
    g.store.setFlag(GUIDANCE_RESET_FLAG);
    await g.preferences.ready;
    expect(g.preferences.configuration().coordinatorInstructions).toBe(edited);
  });
});

describe("W259 assignment.reportedAt in the thread context", () => {
  it("is the stored report time, stable across reads, and null on newer work", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "Do it." });
    expect((await membership(f, w.threadId)).assignment.reportedAt).toBeNull();
    await turn(f, w.threadId, "Done.");
    const stored = f.store.assignment(project.id, 1)!.reportedAt;
    expect(stored).toEqual(expect.any(Number));
    const first = await membership(f, w.threadId);
    expect(first.assignment).toMatchObject({ ref: "A1", phase: "reported", reportedAt: stored });
    expect(first.next).toBeNull();
    // A later read does not restart the Pooler's grace.
    expect((await membership(f, w.threadId)).assignment.reportedAt).toBe(stored);

    await tool(f, "initiative_message", { to: "W1", text: "Small related fix.", work: true });
    const after = await membership(f, w.threadId);
    expect(after.assignment).toMatchObject({ ref: "A2", reportedAt: null });
    expect(after.next).toBeNull();
  });
});
