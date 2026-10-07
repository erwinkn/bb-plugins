import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { clearCatalogCache } from "../lib/bb";

// W188 (F1): a handover is written from the state at replacement. A preview is reused only while
// nothing it was written from has changed; a replacement queued behind a busy coordinator is
// written from that coordinator's final state; the first message says when it was captured.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
let seq = 50_000;
function luna(f: Fx) {
  f.execution.set("catalog-probe", { model: "gpt-6-luna", reasoningLevel: "high" });
  clearCatalogCache();
}
/** One completed turn in `threadId`: an input, then a final message. */
function turn(f: Fx, threadId: string, input: string, reply: string, initiator = "user") {
  const request = `creq_${++seq}`, at = Date.now();
  f.history.push({ threadId, type: "client/turn/requested", seq: ++seq, createdAt: at, data: { requestId: request, initiator, input: [{ type: "text", text: input }] } });
  f.history.push({ threadId, type: "turn/started", seq: ++seq, createdAt: at });
  f.history.push({ threadId, type: "turn/input/accepted", seq: ++seq, createdAt: at, data: { clientRequestId: request } });
  f.history.push({ threadId, type: "item/completed", seq: ++seq, createdAt: at, data: { item: { type: "agentMessage", id: `m${seq}`, text: reply } } });
  f.history.push({ threadId, type: "turn/completed", seq: ++seq, createdAt: at + 1, data: { status: "completed" } });
}
const writers = (f: Fx) => f.spawn.mock.calls.filter(([args]: any) => args.pluginMetadata?.role === "handover-writer").map(([args]: any) => args);
const coordinators = (f: Fx) => f.spawn.mock.calls.filter(([args]: any) => args.pluginMetadata?.role === "coordinator").map(([args]: any) => args);
/** Let the latest writer finish with `text` as its handover. */
async function finishWriter(f: Fx, text: string) {
  const writer = f.store.handoverDraft(f.store.projects()[0]!.id)!.threadId!;
  turn(f, writer, "Write the handover", text, "agent");
  await f.runtime.onThreadIdle(f.idle(writer));
}
async function preview(f: Fx, projectId: string, text: string) {
  const dry = await f.service.recreateCoordinators([projectId], { dryRun: true, waitMs: 0 });
  expect(dry[0]).toMatchObject({ state: "generating" });
  await finishWriter(f, text);
  expect(f.store.handoverDraft(projectId)).toMatchObject({ state: "ready", source: "luna", text, purpose: "preview" });
}

describe("W188 F1: fresh handovers", () => {
  it("reuses a preview when nothing changed since, and dates the first message by its capture", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    turn(f, "coordinator", "Ship T4 tonight.", "On it.");
    f.idle("coordinator");
    await preview(f, project.id, "Preview: T4 ships tonight.");
    const captured = f.store.handoverDraft(project.id)!.capturedAt!;
    await f.service.recreateCoordinators([project.id], { dryRun: false, waitMs: 0 });
    expect(writers(f)).toHaveLength(1);
    const seed = coordinators(f).at(-1)!.prompt as string;
    expect(seed).toContain(`Written from a snapshot captured at ${new Date(captured).toISOString().slice(0, 16).replace("T", " ")} UTC; anything later is not in it. Read the overview first (initiative_read): things may have moved since the capture time.\n\nPreview: T4 ships tonight.`);
    expect(seed).toContain("this replacement is complete");
  });

  it("writes the handover again when the coordinator spoke after the preview", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.idle("coordinator");
    await preview(f, project.id, "Preview: waiting for Erwin's go.");
    // Erwin answers after the preview: the preview no longer holds.
    turn(f, "coordinator", "yes let's go", "Replacing all nine now.");
    f.idle("coordinator");
    const result = await f.service.recreateCoordinators([project.id], { dryRun: false, waitMs: 0 });
    expect(writers(f)).toHaveLength(2);
    expect(writers(f)[1].prompt).toContain("yes let's go");
    expect(result[0]).toMatchObject({ result: { state: "writing-handover" } });
    expect(coordinators(f)).toHaveLength(0);
    await finishWriter(f, "Fresh: the transfer is complete; carry on with T4.");
    const seed = coordinators(f).at(-1)!.prompt as string;
    expect(seed).toContain("Fresh: the transfer is complete");
    expect(seed).not.toContain("waiting for Erwin's go");
  });

  it("writes it again when a live worker or the ledger changed after the preview", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.idle("coordinator");
    await preview(f, project.id, "Preview: no workers.");
    // A worker spawned after the preview (Equisafe's W104).
    await f.harness.callAgentTool("initiative_spawn", { label: "Simplify review", purpose: "#2069", text: "Review #2069." }, { threadId: "coordinator" });
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(writers(f)).toHaveLength(2);
    expect(writers(f)[1].prompt).toMatch(/### W1 "Simplify review"/);
  });

  it("writes it again when the preview was captured too long ago, even if nothing changed", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.idle("coordinator");
    await preview(f, project.id, "Preview from long ago.");
    f.store.db.prepare("UPDATE handover_drafts SET captured_at = captured_at - ? WHERE project_id = ?").run(31 * 60_000, project.id);
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(writers(f)).toHaveLength(2);
  });

  it("a replacement queued behind a busy coordinator is written from its final state", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
    await f.service.recreateCoordinators([project.id], { dryRun: false, waitMs: 0 });
    // Written while the coordinator works: a preview only.
    await finishWriter(f, "Early: the coordinator was mid-turn.");
    expect(f.store.handoverDraft(project.id)).toMatchObject({ state: "ready", purpose: "preview" });
    expect(f.store.pendingHandover(project.id)).not.toBeNull();
    expect(coordinators(f)).toHaveLength(0);
    // The turn ends with a final message the preview never saw.
    turn(f, "coordinator", "Status?", "Final state: #90 merged, W50 is on part 4.", "user");
    f.idle("coordinator");
    await f.service.drainHandover(project.id);
    expect(writers(f)).toHaveLength(2);
    expect(writers(f)[1].prompt).toContain("Final state: #90 merged, W50 is on part 4.");
    await finishWriter(f, "From the final state: #90 merged; W50 on part 4.");
    expect(f.store.handoverDraft(project.id)).toBeNull();
    const seed = coordinators(f).at(-1)!.prompt as string;
    expect(seed).toContain("From the final state: #90 merged; W50 on part 4.");
    expect(seed).not.toContain("Early: the coordinator was mid-turn.");
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
  });

  it("a draft written for a replacement is written again if the coordinator spoke while Luna wrote it", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    turn(f, "coordinator", "Wait, also hand over the T9 plan.", "Noted: T9 plan goes in the handover.");
    f.idle("coordinator");
    await finishWriter(f, "Written before the T9 note.");
    expect(writers(f)).toHaveLength(2);
    expect(writers(f)[1].prompt).toContain("Wait, also hand over the T9 plan.");
    await finishWriter(f, "Written with the T9 note.");
    expect(coordinators(f).at(-1)!.prompt).toContain("Written with the T9 note.");
  });

  it("a replacement whose coordinator is already quiet uses its own fresh draft once, even as workers keep going", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    const [w] = JSON.parse(await f.harness.callAgentTool("initiative_spawn", { label: "Busy worker", purpose: "work", text: "Keep going." }, { threadId: "coordinator" }) as string);
    f.idle("coordinator");
    const started = await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(started).toMatchObject({ state: "writing-handover" });
    expect(f.store.handoverDraft(project.id)).toMatchObject({ purpose: "replacement" });
    // The worker keeps talking while Luna writes; the draft is not rewritten for that.
    turn(f, w.threadId, "brief", "Still working on part 2.", "agent");
    await finishWriter(f, "Written for this replacement.");
    expect(writers(f)).toHaveLength(1);
    expect(coordinators(f).at(-1)!.prompt).toContain("Written for this replacement.");
  });
});
