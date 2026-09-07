import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import type { Plan } from "./contract";

const disposers: Array<() => Promise<void>> = [];
async function setup(send = vi.fn(async (_args: unknown) => ({ ok: true }))) {
  const host = createFakePluginHost({ pluginId: "erwin-plans", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1" }), send },
    projects: { get: async () => ({ id: "project-1", name: "Test project" }) },
  } });
  await plugin(host.bb);
  disposers.push(() => host.harness.lifecycle.dispose());
  const rpc = async (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<Plan>;
  const plan = await rpc("create", { title: "A plan", markdown: "# A plan\n\nKeep the existing data.", threadId: "thread-1" });
  return { ...host, rpc, plan, send };
}
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

describe("Plans review workflow", () => {
  it("waits for a submitted revision after note-only feedback, even when the text is unchanged", async () => {
    const { rpc, plan } = await setup();
    const version = plan.versions[0]!;
    await rpc("submitReview", { id: plan.id, versionId: version.id, action: "feedback", note: "Explain the data retention step.", requestId: "note-only" });
    await expect(rpc("submitReview", { id: plan.id, versionId: version.id, action: "approve", note: "", requestId: "too-early" })).rejects.toThrow(/next revision/);
    const revised = await rpc("revise", { id: plan.id, markdown: version.markdown, expectedVersionId: version.id });
    expect(revised.versions).toHaveLength(2);
    expect(revised.status).toBe("review");
    const approved = await rpc("submitReview", { id: plan.id, versionId: revised.versions[1]!.id, action: "approve", note: "", requestId: "after-explanation" });
    expect(approved.status).toBe("approved");
  });

  it("delivers redlines as removal requests and blocks approval before feedback", async () => {
    const { rpc, plan, send } = await setup();
    const versionId = plan.versions[0]!.id;
    const marked = await rpc("addComment", { id: plan.id, versionId, quote: "existing data", kind: "redline" });
    expect(marked.comments[0]).toMatchObject({ kind: "redline", body: "", sentAt: null });
    await expect(rpc("submitReview", { id: plan.id, versionId, action: "approve", note: "", requestId: "redline-block" })).rejects.toThrow(/Send or delete/);
    const sent = await rpc("submitReview", { id: plan.id, versionId, action: "feedback", note: "", requestId: "redline-send" });
    expect(sent.comments[0]!.sentAt).not.toBeNull();
    expect(JSON.stringify(send.mock.calls)).toContain('redline');
    expect(JSON.stringify(send.mock.calls)).toContain('requests removal');
  });

  it("sends positive annotations with approval without blocking or duplicating delivery", async () => {
    const { rpc, plan, send } = await setup();
    const versionId = plan.versions[0]!.id;
    await rpc("addComment", { id: plan.id, versionId, quote: "existing data", kind: "looksGood" });
    const input = { id: plan.id, versionId, action: "approve", note: "", requestId: "positive-approval" };
    const approved = await rpc("submitReview", input);
    expect(approved.status).toBe("approved");
    expect(approved.comments[0]!.sentAt).not.toBeNull();
    expect(JSON.stringify(send.mock.calls)).toContain('looksGood');
    expect(JSON.stringify(send.mock.calls)).toContain('existing data');
    await rpc("submitReview", input);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends positive annotations with feedback and validates annotation input", async () => {
    const { rpc, plan } = await setup();
    const input = { id: plan.id, versionId: plan.versions[0]!.id, quote: "existing data" };
    await expect(rpc("addComment", input)).rejects.toThrow();
    await expect(rpc("addComment", { ...input, quote: " ", kind: "redline" })).rejects.toThrow();
    await expect(rpc("addComment", { ...input, kind: "unknown" })).rejects.toThrow();
    await rpc("addComment", { ...input, kind: "looksGood" });
    const sent = await rpc("submitReview", { id: plan.id, versionId: input.versionId, action: "feedback", note: "", requestId: "positive-feedback" });
    expect(sent.comments[0]!.sentAt).not.toBeNull();
  });

  it("saves a revision without moving existing comments and rejects stale approval", async () => {
    const { rpc, plan } = await setup();
    const versionId = plan.versions[0]!.id;
    const annotated = await rpc("addComment", { id: plan.id, versionId, quote: "existing data", body: "Keep the schedules too." });
    const revised = await rpc("revise", { id: plan.id, expectedVersionId: versionId, markdown: "# A plan\n\nKeep data and schedules." });
    expect(revised.comments[0]).toEqual(annotated.comments[0]);
    expect(revised.versions).toHaveLength(2);
    await expect(rpc("submitReview", { id: plan.id, versionId, action: "approve", note: "", requestId: "stale" })).rejects.toThrow(/latest version/);
    await expect(rpc("submitReview", { id: plan.id, versionId: revised.versions[1]!.id, action: "approve", note: "", requestId: "unresolved" })).rejects.toThrow(/Send or delete/);
    await rpc("resolveComment", { id: plan.id, commentId: annotated.comments[0]!.id, resolved: true });
    const approved = await rpc("submitReview", { id: plan.id, versionId: revised.versions[1]!.id, action: "approve", note: "", requestId: "resolved" });
    expect(approved.status).toBe("approved");
  });

  it("sends quoted feedback to the original thread once and keeps sent comments immutable", async () => {
    const { rpc, plan, send } = await setup();
    const versionId = plan.versions[0]!.id;
    const annotated = await rpc("addComment", { id: plan.id, versionId, quote: "existing data", body: "Include schedules." });
    const input = { id: plan.id, versionId, action: "feedback", note: "Please revise.", requestId: "review-1" };
    const sent = await rpc("submitReview", input);
    expect(sent.status).toBe("revising");
    expect(sent.comments[0]!.sentAt).not.toBeNull();
    await rpc("submitReview", input);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ threadId: "thread-1", mode: "queue-if-active", input: [{ type: "text", text: expect.stringContaining("Include schedules.") }] });
    await expect(rpc("updateComment", { id: plan.id, commentId: annotated.comments[0]!.id, body: "Changed" })).rejects.toThrow(/cannot be edited/);
  });

  it("approves only the reviewed snapshot and avoids duplicate starts", async () => {
    const { rpc, plan, send } = await setup();
    const input = { id: plan.id, versionId: plan.versions[0]!.id, action: "approve", note: "Proceed.", requestId: "approve-1" };
    const approved = await rpc("submitReview", input);
    expect(approved.status).toBe("approved");
    await expect(rpc("submitReview", { ...input, requestId: "approve-2" })).rejects.toThrow(/already approved/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets the reviewer approve a revision after sent feedback without resolving comments", async () => {
    const { rpc, plan } = await setup();
    const versionId = plan.versions[0]!.id;
    await rpc("addComment", { id: plan.id, versionId, quote: "existing data", body: "Keep schedules too." });
    await rpc("submitReview", { id: plan.id, versionId, action: "feedback", note: "", requestId: "sent-before-revise" });
    await expect(rpc("submitReview", { id: plan.id, versionId, action: "approve", note: "", requestId: "before-revise" })).rejects.toThrow(/next revision/);
    const revised = await rpc("revise", { id: plan.id, expectedVersionId: versionId, markdown: "# A plan\n\nKeep data and schedules." });
    const approved = await rpc("submitReview", { id: plan.id, versionId: revised.versions.at(-1)!.id, action: "approve", note: "", requestId: "after-revise" });
    expect(approved.status).toBe("approved");
    expect(approved.comments[0]!.body).toBe("Keep schedules too.");
  });

  it("never sends sample reviews to an agent", async () => {
    const { rpc, send } = await setup();
    const plan = await rpc("create", { title: "Sample", markdown: "Sample plan", sample: true });
    expect(plan.threadId).toBeNull();
    await rpc("submitReview", { id: plan.id, versionId: plan.versions[0]!.id, action: "feedback", note: "Make it shorter.", requestId: "sample-feedback" });
    const revision = await rpc("revise", { id: plan.id, expectedVersionId: plan.versions[0]!.id, markdown: "Short plan" });
    const approved = await rpc("submitReview", { id: plan.id, versionId: revision.versions.at(-1)!.id, action: "approve", note: "", requestId: "sample-approve" });
    expect(approved.status).toBe("approved");
    expect(send).not.toHaveBeenCalled();
    await expect(rpc("create", { title: "Bad sample", markdown: "Text", sample: true, threadId: "thread-1" })).rejects.toThrow(/cannot be linked/);
  });

  it("retains data through plugin reload", async () => {
    const { harness, plan } = await setup();
    const replacement = await harness.lifecycle.reload(plugin);
    disposers.push(() => replacement.harness.lifecycle.dispose());
    const loaded = await replacement.harness.behavior.callRpc("get", { id: plan.id }) as Plan;
    expect(loaded.versions).toEqual(plan.versions);
  });

  it("blocks automatic retry after an uncertain send and allows explicit reconciliation", async () => {
    const send = vi.fn(async () => { throw new Error("Connection lost"); });
    const { harness, rpc, plan } = await setup(send);
    const input = { id: plan.id, versionId: plan.versions[0]!.id, action: "approve", note: "", requestId: "uncertain" };
    await expect(rpc("submitReview", input)).rejects.toThrow(/could not be confirmed/);
    await expect(rpc("submitReview", input)).rejects.toThrow(/could not be confirmed/);
    await expect(rpc("revise", { id: plan.id, expectedVersionId: input.versionId, markdown: "Revised" })).rejects.toThrow(/pending/);
    expect(send).toHaveBeenCalledTimes(1);
    const result = await harness.behavior.runCli(["delivery", "uncertain", "sent"]);
    expect(result.exitCode).toBe(0);
    expect((await rpc("get", { id: plan.id })).status).toBe("approved");
  });

  it("serializes simultaneous approvals across browser windows", async () => {
    const { rpc, plan, send } = await setup();
    const input = { id: plan.id, versionId: plan.versions[0]!.id, action: "approve", note: "" };
    const results = await Promise.allSettled([
      rpc("submitReview", { ...input, requestId: "window-1" }),
      rpc("submitReview", { ...input, requestId: "window-2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects agent revisions from another thread", async () => {
    const { harness, plan } = await setup();
    await expect(harness.behavior.callAgentTool("plans_submit", {
      title: "Changed", markdown: "Changed plan", planId: plan.id, expectedVersionId: plan.versions[0]!.id,
    }, { threadId: "other-thread" })).rejects.toThrow(/another thread/);
  });

  it("hands the decision to a waiting agent and skips the thread message", async () => {
    const { harness, rpc, plan, send } = await setup();
    const versionId = plan.versions[0]!.id;
    await rpc("addComment", { id: plan.id, versionId, quote: "existing data", body: "Name the table." });
    const waiting = harness.behavior.runCli(["wait", plan.id, "--version", versionId, "--timeout", "30"], { threadId: "thread-1", signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rpc("submitReview", { id: plan.id, versionId, action: "feedback", note: "Be specific.", requestId: "attended" });
    const result = await waiting;
    expect(result.exitCode).toBe(0);
    const decision = JSON.parse(result.stdout!);
    expect(decision).toMatchObject({ status: "feedback", planId: plan.id, versionId, note: "Be specific.", comments: [{ quote: "existing data", body: "Name the table.", kind: "comment" }] });
    expect(decision.instruction).toMatch(/plans_submit/);
    expect(JSON.stringify(decision)).not.toContain("Keep the existing data");
    expect(send).not.toHaveBeenCalled();
    // A later wait on the same version reads the stored decision.
    const again = await harness.behavior.runCli(["wait", plan.id, "--version", versionId, "--timeout", "1"], { threadId: "thread-1", signal: new AbortController().signal });
    expect(JSON.parse(again.stdout!).status).toBe("feedback");
  });

  it("times out with a pending status and reports superseded versions", async () => {
    const { harness, rpc, plan } = await setup();
    const versionId = plan.versions[0]!.id;
    const pending = await harness.behavior.runCli(["wait", plan.id, "--timeout", "1"], { threadId: "thread-1", signal: new AbortController().signal });
    expect(JSON.parse(pending.stdout!)).toMatchObject({ status: "pending", versionId });
    const waiting = harness.behavior.runCli(["wait", plan.id, "--version", versionId, "--timeout", "30"], { threadId: "thread-1", signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const revised = await rpc("revise", { id: plan.id, expectedVersionId: versionId, markdown: "Changed" });
    expect(JSON.parse((await waiting).stdout!)).toMatchObject({ status: "superseded", latestVersionId: revised.versions[1]!.id });
  }, 10_000);

  it("messages the thread without the plan text when nobody is waiting, unless disabled", async () => {
    const { harness, rpc, plan, send } = await setup();
    const versionId = plan.versions[0]!.id;
    await rpc("submitReview", { id: plan.id, versionId, action: "approve", note: "Go.", requestId: "unattended" });
    const text = (send.mock.calls[0]![0] as { input: Array<{ text: string }> }).input[0]!.text;
    expect(text).toContain("approved plan");
    expect(text).toContain(`bb plans get ${plan.id} --version ${versionId}`);
    expect(text).not.toContain("Keep the existing data");
    await harness.behavior.setSettings({ notifyThreadWhenUnattended: false });
    const second = await rpc("create", { title: "Quiet", markdown: "Quiet plan", threadId: "thread-1" });
    await rpc("submitReview", { id: second.id, versionId: second.versions[0]!.id, action: "approve", note: "", requestId: "quiet" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets another thread review a plan through the CLI, but never the plan's own thread", async () => {
    const { harness, plan } = await setup();
    const versionId = plan.versions[0]!.id;
    const self = await harness.behavior.runCli(["review", plan.id, versionId, "feedback", "--note", "x"], { threadId: "thread-1", signal: new AbortController().signal });
    expect(self.exitCode).toBe(1);
    expect(self.stderr).toMatch(/own plan/);
    const parent = await harness.behavior.runCli(["review", plan.id, versionId, "feedback", "--redline", "existing data", "--comment", "A plan::Rename it", "--note", "From the parent."], { threadId: "parent-thread", signal: new AbortController().signal });
    expect(parent.exitCode).toBe(0);
    const got = await harness.behavior.runCli(["get", plan.id, "--version", versionId], { threadId: "thread-1", signal: new AbortController().signal });
    const shown = JSON.parse(got.stdout!);
    expect(shown.status).toBe("revising");
    expect(shown.comments).toEqual([
      expect.objectContaining({ quote: "existing data", kind: "redline", sent: true }),
      expect.objectContaining({ quote: "A plan", body: "Rename it", kind: "comment", sent: true }),
    ]);
  });

  it("reads submitted files on the invoking environment host", async () => {
    const { harness } = await setup();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "remote-environment" }));
    harness.inspection.sdk.stub("environments.get", async () => ({ id: "remote-environment", hostId: "remote-host" }));
    harness.inspection.sdk.stub("files.read", async () => ({ content: "# Remote plan", contentEncoding: "utf8" }));
    const result = await harness.behavior.runCli(["submit", "plan.md", "Remote plan"], { cwd: "/remote/work", threadId: "thread-1", signal: new AbortController().signal });
    expect(result.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("files.read")[0]![0]).toEqual({ path: "/remote/work/plan.md", hostId: "remote-host" });
  });
});
