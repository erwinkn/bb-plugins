import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { clearCatalogCache } from "../lib/bb";
import { finalAgentMessage } from "../lib/handover";

// A296 review of T136, each finding ported from its reproduction.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
const tool = async (f: Fx, name: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(name, input, { threadId }) as string);
let seq = 1000;
const latestBrief = (f: Fx) => (f.store.db.prepare("SELECT brief_text FROM assignments ORDER BY rowid DESC LIMIT 1").get() as { brief_text: string } | undefined)?.brief_text ?? "";
function finish(f: Fx, text: string, status = "completed", input = latestBrief(f)) {
  const request = `creq_${++seq}`;
  f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: Date.now(), data: { requestId: request, initiator: "agent", input: [{ type: "text", text: input }] } });
  f.history.push({ type: "turn/started", seq: ++seq, createdAt: Date.now() - 1 });
  f.history.push({ type: "turn/input/accepted", seq: ++seq, createdAt: Date.now(), data: { clientRequestId: request } });
  f.history.push({ type: "item/completed", seq: ++seq, createdAt: Date.now(), data: { item: { type: "agentMessage", text } } });
  f.history.push({ type: "turn/completed", seq: ++seq, createdAt: Date.now() + 1, data: { status } });
}
function luna(f: Fx) {
  f.execution.set("catalog-probe", { model: "gpt-6-luna", reasoningLevel: "high" });
  clearCatalogCache();
}

describe("A296 P1: report capture is bound to a completed turn of that work", () => {
  it("1: agent text without a completed turn boundary is not a final message", async () => {
    const { f } = await projectFixture();
    f.history.push({ type: "turn/started", seq: ++seq, createdAt: seq });
    f.history.push({ type: "item/completed", seq: ++seq, createdAt: seq, data: { item: { type: "agentMessage", text: "I will investigate." } } });
    expect(await finalAgentMessage(f.service.sdk, "coordinator")).toBeNull();
  });

  it("2: a late idle callback never copies the previous final message into newly delivered work", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Work", purpose: "work", text: "First work" });
    finish(f, "First batch complete");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.assignment(project.id, 1)!.report!.finalMessage).toBe("First batch complete");
    await tool(f, "initiative_message", { to: w.worker, work: true, text: "Second work" });
    await f.runtime.onThreadIdle(f.threads.get(w.threadId)!);
    expect(f.store.assignment(project.id, 2)!.report).toBeNull();
    // Its own turn does report it.
    finish(f, "Second batch complete");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.assignment(project.id, 2)!.report!.finalMessage).toBe("Second batch complete");
  });

  it("2: an interrupted short-report turn never attaches a later chat reply", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Work", purpose: "work", text: "Do work" });
    await tool(f, "initiative_report", { outcome: "blocked", summary: "Need a key", question: "Which key?" }, w.threadId);
    finish(f, "Blocked details", "interrupted");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    await tool(f, "initiative_message", { to: w.worker, text: "Explain the issue more" });
    finish(f, "Here is a later unrelated explanation.", "completed", "Explain the issue more");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    expect(f.store.assignment(project.id, 1)!.report!.finalMessage).toBeUndefined();
  });
});

describe("A296 P1: briefs, handovers and recreation", () => {
  it("3: read-only work from an older session's initiative_delegate still says read-only in its brief", async () => {
    const { f, project } = await projectFixture();
    const t = f.task(project.id);
    await tool(f, "initiative_delegate", { action: "delegate", route: "fresh", label: "Audit", area: "audit", tasks: [t.ref], access: "read-only", permissionMode: "full", note: "Check the metrics." });
    expect(f.store.assignment(project.id, 1)!.access).toBe("read-only");
    expect(f.spawn.mock.calls.at(-1)![0].prompt).toContain("Access: read-only. Don't write source or install state, even with full permissions");
  });

  it("4: the fallback handover keeps the user's recent instructions", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: seq, data: { requestId: "u1", initiator: "user", input: [{ type: "text", text: "Do not deploy until I approve." }] } });
    f.history.push({ type: "item/completed", seq: ++seq, createdAt: seq, data: { item: { type: "userMessage", content: [{ type: "text", text: "Keep W3 on the index." }] } } });
    await f.service.replaceCoordinator(project.id, { reason: "restart" });
    const seed = f.spawn.mock.calls.at(-1)![0].prompt as string;
    expect(seed).toContain("(Generated without Luna:");
    expect(seed).toContain("Do not deploy until I approve.");
    expect(seed).toContain("Keep W3 on the index.");
  });

  it("4: a writer that fails later still falls back to the same messages", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.history.push({ type: "client/turn/requested", seq: ++seq, createdAt: seq, data: { requestId: "u2", initiator: "user", input: [{ type: "text", text: "Ship only after the review." }] } });
    await f.service.startHandoverDraft(project.id, {});
    const writer = f.store.handoverDraft(project.id)!.threadId!;
    await f.service.finishHandoverDraft(writer, "the writer failed");
    expect(f.store.handoverDraft(project.id)!.text).toContain("Ship only after the review.");
  });

  it("5: a busy coordinator that fails after recreation was queued is still recreated", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
    await f.service.recreateCoordinators([project.id], { dryRun: false, waitMs: 0 });
    const writer = f.store.handoverDraft(project.id)!.threadId!;
    finish(f, "handover ready");
    await f.runtime.onThreadIdle(f.idle(writer));
    expect(f.store.pendingHandover(project.id)).not.toBeNull();
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "error" });
    await f.runtime.onThreadFailed(f.threads.get("coordinator")!, "restart failure");
    await f.runtime.sweep();
    expect(f.store.project(project.id)!.coordinatorThreadId).not.toBe("coordinator");
    expect(f.spawn.mock.calls.at(-1)![0].prompt).toContain("handover ready");
  });

  it("9: CLI recreation and a dashboard replacement racing each other start one coordinator", async () => {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    f.store.saveHandoverDraft({ projectId: project.id, state: "ready", note: null, text: "Ready handover", source: "luna", threadId: null, detail: null, thenReplace: null });
    let spawned = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    f.intercept(async (path, args, call) => {
      if (path === "threads.spawn" && (args as { pluginMetadata?: { role?: string } }).pluginMetadata?.role === "coordinator") {
        const value = call();
        spawned++;
        if (spawned === 2) release();
        await gate;
        return value;
      }
      return call();
    });
    const timeout = setTimeout(() => release(), 300);
    await Promise.allSettled([
      f.harness.callRpc("command", { projectId: project.id, command: { action: "replace-coordinator", reason: "dashboard", handover: "Reviewed handover" } }),
      f.harness.runCli(["recreate-coordinators", project.id, "--wait=0"]),
    ]);
    clearTimeout(timeout);
    f.intercept();
    expect(spawned).toBe(1);
    const live = [...f.threads.values()].filter(t => f.metadata.get(t.id)?.role === "coordinator" && t.archivedAt === null);
    expect(live.map(t => t.id)).toEqual([f.store.project(project.id)!.coordinatorThreadId]);
  });
});

describe("A296 P2 and retained sessions", () => {
  it("6: concurrent draft creation starts exactly one writer", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.store.saveHandoverDraft({ projectId: project.id, state: "requested", note: null, text: null, source: null, threadId: null, detail: "queued", thenReplace: null });
    await Promise.all([f.harness.callRpc("command", { projectId: project.id, command: { action: "handover-draft" } }), f.service.pumpHandoverWriters()]);
    const writers = [...f.threads.values()].filter(t => f.metadata.get(t.id)?.role === "handover-writer" && t.archivedAt === null);
    expect(writers).toHaveLength(1);
    expect(f.store.handoverDraft(project.id)!.threadId).toBe(writers[0]!.id);
  });

  it("7: a failed writer archive stays tracked and the sweep retries it", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    await f.service.startHandoverDraft(project.id);
    const writer = f.store.handoverDraft(project.id)!.threadId!;
    f.archive.mockRejectedValueOnce(new Error("archive temporarily unavailable"));
    await f.service.finishHandoverDraft(writer, "timeout");
    expect(f.store.trackedWriters().map(w => w.threadId)).toEqual([writer]);
    await f.service.sweepHandoverDrafts();
    expect(f.threads.get(writer)!.archivedAt).not.toBeNull();
    expect(f.store.trackedWriters()).toEqual([]);
  });

  it("8: an older session's adopt payload with area still works", async () => {
    const { f } = await projectFixture();
    f.threads.set("adopt-me", { ...f.threads.get("coordinator")!, id: "adopt-me", parentThreadId: null });
    await expect(tool(f, "initiative_worker", { action: "adopt", threadId: "adopt-me", role: "work", label: "Audit", area: "metrics" })).resolves.toBeTruthy();
  });

  it("the coordinator's `bb initiative message` CLI gives work with work:true or tasks", async () => {
    const { f, project } = await projectFixture();
    const [w] = await tool(f, "initiative_spawn", { label: "Search", purpose: "search", text: "First." });
    finish(f, "Done.");
    await f.runtime.onThreadIdle(f.idle(w.threadId));
    const r = await f.harness.runCli(["message", JSON.stringify({ to: "W1", text: "Second part.", work: true })], { threadId: "coordinator" });
    expect(r.exitCode).toBe(0);
    expect(f.store.assignment(project.id, 2)).toMatchObject({ workerNum: 1, route: "continue" });
  });
});
