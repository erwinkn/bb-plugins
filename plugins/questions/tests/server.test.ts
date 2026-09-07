import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { MIGRATIONS } from "../server/store";
import { emptyAnswer, threadStateSchema, type Answer, type Question, type Submission } from "../lib/model";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const ids = new Map<string, string>();
function uuid(label: string): string {
  if (!ids.has(label)) ids.set(label, randomUUID());
  return ids.get(label)!;
}
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup(beforePlugin?: (host: ReturnType<typeof createFakePluginHost>) => void) {
  const send = vi.fn(async () => ({ ok: true, delivery: "sent" }));
  const host = createFakePluginHost({
    pluginId: "questions",
    sdk: {
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: `proj_${threadId}`, environmentId: `env_${threadId}` }),
        send,
      },
      environments: {
        get: async ({ environmentId }) => ({ id: environmentId, hostId: `host_${environmentId}` }),
        paths: async () => ({ paths: [{ path: "src/app.ts", name: "app.ts", kind: "file" }], truncated: false }),
      },
      files: { read: async () => ({ content: JSON.stringify({ questions: [{ title: "Remote JSON?" }] }), contentEncoding: "utf8" }) },
      projects: { attachments: {
        upload: async ({ filename, mimeType }) => ({ path: "uploads/test.png", name: filename, mimeType, sizeBytes: 3 }),
        read: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", sizeBytes: 3 }),
      } },
    },
  });
  hosts.push(host);
  beforePlugin?.(host);
  await plugin(host.bb);
  const rpc = host.harness.behavior.callRpc;
  const state = async (threadId = "t") => threadStateSchema.parse(await rpc("questions_state", { threadId }));
  const ask = async (questions: unknown[], threadId = "t", mode = "panel") => {
    const result = await host.harness.behavior.callAgentTool("questions_ask", { mode, questions }, { threadId, projectId: `proj_${threadId}` });
    expect(typeof result).toBe("string");
    return (await state(threadId)).rounds.at(-1)!;
  };
  const save = async (q: Question, draft: Answer, version = 0, threadId = "t") => rpc("questions_save_draft", { threadId, questionId: q.id, draft, expectedVersion: version });
  const submit = async (questionIds: string[], submissionId = "s1", version = 1, retryOf: string | null = null) => rpc("questions_submit", {
    threadId: "t", submissionId: uuid(submissionId), items: questionIds.map((questionId) => ({ questionId, expectedVersion: version })), retryOf: retryOf === null ? null : uuid(retryOf),
  }) as Promise<{ outcome: string; submission: Submission }>;
  return { ...host, send, rpc, state, ask, save, submit };
}

describe("Questions backend", () => {
  it("passes a lowercase query to BB's fuzzy path search", async () => {
    const h = await setup();
    await h.rpc("questions_search_paths", { threadId: "t", query: "  Agents  " });
    expect(h.harness.inspection.sdk.callsTo("environments.paths").at(-1)?.[0]).toMatchObject({ query: "agents", limit: "20" });
  });
  it("disables retry for partial supersession even outside the recent list", async () => {
    const h = await setup();
    const [a, b, c] = (await h.ask([{ title: "A?" }, { title: "B?" }, { title: "C?" }])).questions;
    for (const q of [a!, b!, c!]) await h.save(q, { ...emptyAnswer(), text: "answer" });
    h.send.mockRejectedValueOnce(new Error("network timeout"));
    await h.submit([a!.id, b!.id]);
    expect((await h.state()).submissions.find((s) => s.id === uuid("s1"))!.canRetry).toBe(true);
    await h.submit([b!.id], "s2");
    // More recent unrelated sends push the overlapping send outside the page.
    for (let index = 0; index < 21; index++) {
      await h.save(c!, { ...emptyAnswer(), text: `answer ${index}` }, index + 1);
      await h.submit([c!.id], `later${index}`, index + 2);
    }
    const submissions = (await h.state()).submissions;
    expect(submissions.some((s) => s.id === uuid("s2"))).toBe(false);
    expect(submissions.find((s) => s.id === uuid("s1"))!.canRetry).toBe(false);
    await expect(h.submit([], "retry", 1, "s1")).rejects.toThrow("newer attempt");
  });
  it("keeps an empty Other selection as a draft without submitting an empty answer", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Choose?", options: ["A"] }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), other: true });
    expect((await h.state()).answers[0]!.draft?.other).toBe(true);
    expect(await h.submit([q.id])).toMatchObject({ outcome: "nothing" });
    await expect(h.save(q, { ...emptyAnswer(), other: true, selected: ["o1"] }, 1)).rejects.toThrow("Other cannot be combined");
  });

  it("does not send blank file searches to the host", async () => {
    const h = await setup();
    expect(await h.rpc("questions_search_paths", { threadId: "t", query: "  " })).toMatchObject({ hits: [], unavailable: null });
    expect(h.harness.inspection.sdk.callsTo("environments.paths")).toHaveLength(0);
  });

  it("migrates the old display mode without changing rounds or answers", async () => {
    const draft = { ...emptyAnswer(), text: "Unsent edit " };
    const submitted = { ...emptyAnswer(), text: "Original answer" };
    const h = await setup(({ bb }) => {
      const db = bb.storage.database();
      bb.storage.migrate(db, MIGRATIONS.slice(0, -1));
      db.prepare("INSERT INTO rounds VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy", "t", "proj_t", 1, "notebook", "Keep this", "[]", 123);
      db.prepare("INSERT INTO answers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy-q", "t", "legacy", JSON.stringify(draft), 7, JSON.stringify(submitted), 456, "legacy-s", 789);
    });
    const migrated = await h.state();
    expect(migrated.rounds[0]).toMatchObject({ id: "legacy", mode: "panel", number: 1, intro: "Keep this", createdAt: 123 });
    expect(migrated.answers[0]).toMatchObject({ questionId: "legacy-q", draft, submitted, version: 7, submittedAt: 456, submissionId: "legacy-s" });
    expect((await h.ask([{ title: "New panel round?" }])).mode).toBe("panel");
    await expect(h.harness.behavior.callAgentTool("questions_ask", { mode: "notebook", questions: [{ title: "Old mode?" }] }, { threadId: "t" })).rejects.toThrow("Invalid option");
    const beforeReload = await h.state();
    const replacement = await h.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    expect(threadStateSchema.parse(await replacement.harness.behavior.callRpc("questions_state", { threadId: "t" }))).toEqual(beforeReload);
  });

  it("accepts more than 200 panel questions but refuses six inline questions", async () => {
    const h = await setup();
    expect((await h.ask(Array.from({ length: 201 }, (_, i) => ({ title: `Question ${i}?` })))).questions).toHaveLength(201);
    const result = await h.harness.behavior.callAgentTool("questions_ask", { mode: "inline", questions: Array.from({ length: 6 }, () => ({ title: "Quick?" })) }, { threadId: "t", projectId: "proj_t" });
    expect(result).toMatchObject({ isError: true });
    expect((await h.state()).rounds).toHaveLength(1);
    const advanced = await h.harness.behavior.callAgentTool("questions_ask", { mode: "inline", questions: [{ title: "Quick?", help: "Extra context" }] }, { threadId: "t", projectId: "proj_t" });
    expect(advanced).toMatchObject({ isError: true });
    expect((await h.state()).rounds).toHaveLength(1);
  });

  it("scopes rounds, references and writes to the owning thread", async () => {
    const h = await setup();
    const first = await h.ask([{ title: "First?" }]);
    const other = await h.ask([{ title: "Other?" }], "other");
    expect(first.questions[0]!.id).not.toBe(other.questions[0]!.id);
    await expect(h.save(first.questions[0]!, { ...emptyAnswer(), text: "wrong thread" }, 0, "other")).rejects.toThrow("Unknown question");
    const result = await h.harness.behavior.callAgentTool("questions_ask", { questions: [{ title: "Cross thread?", cites: [first.questions[0]!.id] }] }, { threadId: "other", projectId: "proj_other" });
    expect(result).toMatchObject({ isError: true });
    expect((await h.state("other")).rounds).toHaveLength(1);
  });

  it("preserves whitespace and rejects stale saves without discarding either draft", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Draft?", options: ["A", "B"] }])).questions[0]!;
    const draft = { ...emptyAnswer(), selected: ["o1"], text: "Hello \n", details: { o1: "Because \n" } };
    expect(await h.save(q, draft)).toMatchObject({ outcome: "saved", state: { version: 1, draft } });
    expect(await h.save(q, { ...emptyAnswer(), text: "Other device" })).toMatchObject({ outcome: "conflict", state: { draft } });
    expect((await h.state()).answers[0]!.draft).toEqual(draft);
    const read = await h.harness.behavior.callAgentTool("questions_read", {}, { threadId: "t" });
    expect(String(read)).not.toContain("Hello");
    expect(await h.harness.behavior.runCli(["state"], { threadId: "t" })).toMatchObject({ exitCode: 1 });
  });

  it("partially submits once, freezes the snapshot, and ignores unchanged resubmissions", async () => {
    const h = await setup();
    const [a, b] = (await h.ask([{ title: "A?" }, { title: "B?" }])).questions;
    await h.save(a!, { ...emptyAnswer(), text: "A" });
    await h.save(b!, { ...emptyAnswer(), text: "B" });
    const result = await h.submit([a!.id, a!.id]);
    expect(result.submission.state).toBe("sent");
    expect(result.submission.questionIds).toEqual([a!.id]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.harness.inspection.sdk.callsTo("threads.send")[0]![0]).toMatchObject({ threadId: "t", mode: "queue-if-active", input: [{ type: "text", text: expect.stringContaining(`submission ${uuid("s1")}`) }] });
    await h.submit([a!.id]);
    expect(await h.submit([a!.id], "s2")).toMatchObject({ outcome: "nothing" });
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.save(a!, { ...emptyAnswer(), text: "Unsent change" }, 1);
    const state = await h.state();
    expect(state.answers.find((item) => item.questionId === a!.id)!.submitted!.text).toBe("A");
    expect(state.answers.find((item) => item.questionId === b!.id)!.submitted).toBeNull();
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("blocks overlapping sends while keeping edits made during delivery", async () => {
    const h = await setup();
    let finish!: (value: { ok: boolean; delivery: string }) => void;
    h.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "First" });
    const first = h.submit([q.id]);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await h.save(q, { ...emptyAnswer(), text: "New draft" }, 1);
    expect(await h.submit([q.id], "s2", 2)).toMatchObject({ outcome: "in-flight" });
    finish({ ok: true, delivery: "sent" });
    await first;
    expect((await h.state()).answers[0]).toMatchObject({ version: 2, draft: { text: "New draft" }, submitted: { text: "First" } });
  });

  it("records uncertain delivery, never auto-retries, and refuses obsolete retries", async () => {
    const h = await setup();
    h.send.mockRejectedValueOnce(new Error("response lost"));
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Original" });
    expect((await h.submit([q.id])).submission.state).toBe("uncertain");
    await h.submit([q.id]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect((await h.state()).answers[0]!.submitted).toBeNull();
    await h.save(q, { ...emptyAnswer(), text: "Newer edit" }, 1);
    const retry = await h.submit([], "s_retry", 2, "s1");
    expect(retry.submission.snapshot[q.id]!.text).toBe("Original");
    expect((await h.state()).answers[0]!.draft!.text).toBe("Newer edit");
    await expect(h.submit([], "s_retry_again", 2, "s1")).rejects.toThrow("newer attempt");
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("keeps drafts and changes interrupted pending delivery to uncertain on reload", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Saved" });
    await h.submit([q.id]);
    h.bb.storage.database().prepare("UPDATE submissions SET state = 'pending' WHERE id = ?").run(uuid("s1"));
    const replacement = await h.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    const state = threadStateSchema.parse(await replacement.harness.behavior.callRpc("questions_state", { threadId: "t" }));
    expect(state.submissions[0]!.state).toBe("uncertain");
    expect(state.answers[0]!.draft!.text).toBe("Saved");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("uploads real bytes, sends image inputs and denies forged attachment paths", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Evidence?", attachments: true }])).questions[0]!;
    await h.rpc("questions_upload_attachment", { threadId: "t", questionId: q.id, expectedVersion: 0, name: "image.png", mimeType: "image/png", dataBase64: "AQID" });
    expect(h.harness.inspection.sdk.callsTo("projects.attachments.upload")[0]![0]).toMatchObject({ projectId: "proj_t", filename: "image.png", clientFile: new Uint8Array([1, 2, 3]) });
    await h.submit([q.id]);
    expect(h.harness.inspection.sdk.callsTo("threads.send")[0]![0]).toMatchObject({ input: [expect.anything(), { type: "localImage", path: "uploads/test.png" }] });
    const draft = (await h.state()).answers[0]!.draft!;
    await expect(h.save(q, { ...draft, attachments: [{ ...draft.attachments[0]!, path: "/secrets" }] }, 1)).rejects.toThrow("Unknown attachment");
    await expect(h.rpc("questions_attachment_preview", { threadId: "t", questionId: q.id, path: "/secrets" })).rejects.toThrow("Unknown attachment");
  });

  it("validates optional controls, reference workspace and URL schemes", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "References?", references: true, confidence: true }])).questions[0]!;
    const reference = { kind: "workspace" as const, environmentId: "env_t", hostId: "host_env_t", path: "src/app.ts", entryKind: "file" as const };
    await h.save(q, { ...emptyAnswer(), text: "Reference answer", references: [reference], confidence: "high" });
    await h.submit([q.id]);
    const read = String(await h.harness.behavior.callAgentTool("questions_read", {}, { threadId: "t" }));
    expect(read).toContain("src/app.ts");
    expect(read).toContain('"confidence":"high"');
    await expect(h.save(q, { ...emptyAnswer(), references: [{ ...reference, environmentId: "other" }] }, 1)).rejects.toThrow("does not belong");
    await expect(h.save(q, { ...emptyAnswer(), references: [{ kind: "url", url: "javascript:alert(1)" }] }, 1)).rejects.toThrow();
    const plain = (await h.ask([{ title: "Plain?" }])).questions[0]!;
    await expect(h.save(plain, { ...emptyAnswer(), confidence: "high" })).rejects.toThrow("does not offer");
  });

  it("reads JSON on the invoking machine even when the target thread differs", async () => {
    const h = await setup();
    const result = await h.harness.behavior.runCli(["ask", "--thread", "other", "--file", "questions.json", "--json"], { threadId: "caller", cwd: "/workspace" });
    expect(result.exitCode).toBe(0);
    expect(h.harness.inspection.sdk.callsTo("files.read")[0]![0]).toMatchObject({ hostId: "host_env_caller", path: "/workspace/questions.json" });
    expect((await h.state("other")).rounds[0]!.questions[0]!.title).toBe("Remote JSON?");
    const missing = await h.harness.behavior.runCli(["ask", "--thread", "other", "--file", "/questions.json"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--host");
  });

  it("does not hide corrupt persisted answers", async () => {
    const h = await setup();
    const q = (await h.ask([{ title: "Question?" }])).questions[0]!;
    await h.save(q, { ...emptyAnswer(), text: "Saved" });
    h.bb.storage.database().prepare("UPDATE answers SET draft_json = '{}' WHERE question_id = ?").run(q.id);
    await expect(h.state()).rejects.toThrow("not readable");
  });

  it("removes only the deleted thread's question data", async () => {
    const h = await setup();
    await h.ask([{ title: "Delete this?" }]);
    await h.ask([{ title: "Keep this?" }], "other");
    await h.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "t" }) });
    expect((await h.state()).rounds).toEqual([]);
    expect((await h.state("other")).rounds).toHaveLength(1);
  });

  it("paginates complete submitted answers without exposing drafts", async () => {
    const h = await setup();
    const round = await h.ask(Array.from({ length: 30 }, (_, i) => ({ title: `Large ${i}?` })));
    for (const q of round.questions) await h.save(q, { ...emptyAnswer(), text: q.id + "x".repeat(19_900) });
    await h.submit(round.questions.map((q) => q.id));
    const read = String(await h.harness.behavior.callAgentTool("questions_read", {}, { threadId: "t" }));
    const after = read.match(/after="([^"]+)"/)?.[1];
    expect(after).toBeTruthy();
    const next = String(await h.harness.behavior.callAgentTool("questions_read", { after }, { threadId: "t" }));
    expect(next).toContain(round.questions.at(-1)!.id);
    const records = [...read.split("\n"), ...next.split("\n")].filter((line) => line.startsWith("{"));
    expect(records).toHaveLength(30);
    for (const line of records) expect(JSON.parse(line).submitted.text.length).toBeGreaterThan(19_900);
  });

  it("keeps unresolved delivery visible after more than 20 unrelated submissions", async () => {
    const h = await setup();
    h.send.mockRejectedValueOnce(new Error("lost response"));
    const round = await h.ask(Array.from({ length: 23 }, (_, i) => ({ title: `Answer ${i}?` })));
    for (const [i, q] of round.questions.entries()) {
      await h.save(q, { ...emptyAnswer(), text: `Answer ${i}` });
      await h.submit([q.id], `history_${i}`);
    }
    const state = await h.state();
    expect(state.submissions).toHaveLength(21);
    expect(state.submissions.find((s) => s.id === uuid("history_0"))!.state).toBe("uncertain");
  });

  it("uses only public SDK imports", async () => {
    const result = experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, { allow: [
      /^react(?:-dom)?(?:\/.*)?$/, /^@radix-ui\//, /^@hugeicons\//,
      /^@\/(?:components|lib|hooks)\/[\w/-]+$/, /^@testing-library\/react$/,
      /^(?:class-variance-authority|clsx|tailwind-merge|better-sqlite3|sonner|vaul)$/,
      /^vitest(?:\/.*)?$/,
    ] });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
