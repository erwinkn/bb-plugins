import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { MAX_ERROR_BYTES, clipBytes, nearest } from "../lib/tool-errors";
import { MAX_READ_BYTES } from "../lib/read";

type Fixture = Awaited<ReturnType<typeof projectFixture>>["f"];
const refused = async (f: Fixture, tool: string, input: unknown, threadId = "coordinator") => {
  try {
    await f.harness.callAgentTool(tool, input, { threadId });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${tool} accepted ${JSON.stringify(input)}`);
};
const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };

describe("T147 unknown keys name the fix", () => {
  it("spawn: brief and hostId point at text and host, the valid keys and an example follow", async () => {
    const { f } = await projectFixture();
    const message = await refused(f, "initiative_spawn", { label: "Search", purpose: "ranking", brief: "Do it.", hostId: "host_a" });
    expect(message).toContain("`brief` is not a key of initiative_spawn; did you mean `text`?");
    expect(message).toContain("`hostId` is not a key of initiative_spawn; did you mean `host` (a host name or id)?");
    expect(message).toContain("`text` is required.");
    expect(message).toContain("Valid keys: label, purpose, text, role, tasks, reviews, handoffs, kind, profile, project, host, worktree, environment, permissionMode.");
    expect(message).not.toContain("Example");
  });

  it("message: worker points at to, and the older target key is not listed", async () => {
    const { f } = await projectFixture();
    const message = await refused(f, "initiative_message", { worker: "W1", text: "hi" });
    expect(message).toContain("`worker` is not a key of initiative_message; did you mean `to`?");
    expect(message).toContain("Valid keys: to, text, mode, tasks, work, resumeCold.");
  });

  it("task: summary and description point at text; a key with no meant name still lists the valid ones", async () => {
    const { f } = await projectFixture();
    const message = await refused(f, "initiative_task", { action: "create", title: "Rank", summary: "Why.", description: "More.", priority: "high" });
    expect(message).toContain("`summary`, `description` are not keys of initiative_task; did you mean `text`?");
    expect(message).toContain("`priority` is not a key of initiative_task. Valid keys: action, task, title, text, note, status, reason, outcome.");
    expect(await refused(f, "initiative_task", { action: "close", task: "T1", outcome: "done", id: "T1" })).toContain("`id` is not a key of initiative_task; did you mean `task`?");
  });

  it("falls back to the nearest valid key by edit distance, and to none when nothing is close", async () => {
    const { f } = await projectFixture();
    expect(await refused(f, "initiative_task", { action: "update", task: "T1", titel: "x" })).toContain("`titel` is not a key of initiative_task; did you mean `title`?");
    expect(await refused(f, "initiative_spawn", { label: "a", purpose: "b", text: "c", permisionMode: "full" })).toContain("did you mean `permissionMode`?");
    expect(await refused(f, "initiative_worker", { action: "retire", worker: "W1", zzzzzz: 1 })).toContain("`zzzzzz` is not a key of initiative_worker. Valid keys:");
    expect(nearest("Text", ["to", "text"])).toBe("text");
    expect(nearest("brief", ["handoff", "briefText"])).toBe("briefText");
    expect(nearest("qqqq", ["to", "text"])).toBeNull();
  });

  it("pr: flat PR fields point at prs:[{url,…}]; a wrong key inside prs[0] is named by position", async () => {
    const { f } = await projectFixture();
    const flat = await refused(f, "initiative_pr", { url: "https://github.com/o/r/pull/1", stage: "in-review", note: "W2" });
    expect(flat).toContain("`url`, `stage`, `note` are not keys of initiative_pr; did you mean `prs:[{url,…}]`");
    expect(flat).toContain("Valid keys: prs, rename.");
    expect(flat).not.toContain("Example");
    const nested = await refused(f, "initiative_pr", { prs: [{ url: "https://github.com/o/r/pull/1", status: "in-review" }] });
    expect(nested).toContain("`status` is not a key of prs[0]; did you mean `stage`?");
    expect(nested).toContain("Valid keys: url, stage, note, category,");
  });

  it("read: an unknown key names the one meant", async () => {
    const { f } = await projectFixture();
    expect(await refused(f, "initiative_read", { view: "tasks", id: "T1" })).toContain("`id` is not a key of initiative_read; did you mean `refs`?");
  });
});

describe("T147 other mistakes say how to fix them", () => {
  it("a task title over 200 characters says to put the long text in text", async () => {
    const { f, project } = await projectFixture();
    const message = await refused(f, "initiative_task", { action: "create", title: "Rank threads. ".repeat(40) });
    expect(message).toContain("`title` is 560 characters; at most 200 fit. Put the long text in `text` and keep `title` short.");
    expect(f.store.tasks(project.id)).toEqual([]);
    // A field with no short counterpart just states the limit.
    expect(await refused(f, "initiative_task", { action: "update", task: "T1", note: "x".repeat(2001) })).toContain("`note` is 2001 characters; at most 2000 fit.");
    expect(await refused(f, "initiative_spawn", { label: "x".repeat(201), purpose: "p", text: "t" })).toContain("Put the long text in `text`");
  });

  it("a JSON string where an array or object belongs says to pass the structure", async () => {
    const { f } = await projectFixture();
    const message = await refused(f, "initiative_batch", { actions: JSON.stringify([{ tool: "message", to: "coordinator", text: "hi" }]) });
    expect(message).toContain("`actions` is a JSON string; pass an array, not a JSON string.");
    expect(message).not.toContain("characters; at most");
    expect(await refused(f, "initiative_spawn", { label: "a", purpose: "b", text: "c", environment: '{"type":"worktree"}' })).toContain("`environment` is a JSON string; pass an object, not a JSON string.");
    // A plain string keeps the type error.
    expect(await refused(f, "initiative_batch", { actions: "message" })).toContain("actions: Invalid input: expected array, received string");
  });

  it("a batch tool named with its initiative_ prefix says to drop it", async () => {
    const { f } = await projectFixture();
    expect(await refused(f, "initiative_batch", { actions: [{ tool: "initiative_message", to: "W1", text: "x" }] })).toContain('`actions.0.tool` is "initiative_message"; drop the initiative_ prefix ("message").');
    expect(await refused(f, "initiative_batch", { calls: [] })).toContain("`calls` is not a key of initiative_batch; did you mean `actions`?");
  });

  it("batched actions get the tool's own message, led by the action's index", async () => {
    const { f } = await projectFixture();
    const result = JSON.parse(await f.harness.callAgentTool("initiative_batch", { actions: [
      { tool: "task", action: "create", title: "Rank" },
      { tool: "message", worker: "W1", text: "hi" },
      { tool: "task", action: "create", title: "x".repeat(300) },
      { tool: "pr", url: "https://github.com/o/r/pull/1", stage: "in-review" },
    ] }, { threadId: "coordinator" }) as string);
    expect(result.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false, false, false]);
    expect(result.results[1].error).toMatch(/^actions\[1\]: Invalid arguments for initiative_message: `worker` is not a key of initiative_message; did you mean `to`\?/);
    expect(result.results[2].error).toMatch(/^actions\[2\]: Invalid arguments for initiative_task: `title` is 300 characters.*Put the long text in `text`/);
    expect(result.results[3].error).toMatch(/^actions\[3\]: Invalid arguments for initiative_pr: .*did you mean `prs:\[\{url,…\}\]`/);
  });

  it("initiative_read fields a kind lacks name the ones it has and the nearest; selectors without view or refs are named", async () => {
    const { f } = await projectFixture();
    // W492: brief reads as briefText now; a field the kind lacks still names the nearest.
    const nearest = await refused(f, "initiative_read", { view: "assignments", fields: ["handoff"] });
    expect(nearest).toContain("handoff applies to none of the records read (did you mean handoff → report.handoff?)");
    expect(nearest).toContain("assignments: briefText, report, report.handoff,");
    expect(await refused(f, "initiative_read", { view: "inbox", fields: ["report.handoff"] })).toContain("inbox: payload");
    const selectors = await refused(f, "initiative_read", { limit: 5, detailed: true });
    expect(selectors).toContain("Selectors (limit, detailed) need a view or refs, and this call has neither.");
    expect(selectors).not.toContain("initiative_read {");
    expect(await refused(f, "initiative_read", { view: "overview", limit: 5 })).toContain("overview has no limit selectors.");
  });

  it("superseding a replaced decision names the choice now standing, only when this caller may replace it", async () => {
    const { f, project } = await projectFixture();
    const choice = (description: string, madeBy: "user" | "agent", supersedes?: string) => ({ decision: { description, madeBy }, ...(supersedes ? { supersedes } : {}) });
    const record = (...args: Parameters<typeof choice>) => f.service.recordDecision(project.id, choice(...args), coordinator).ref;
    const refusal = (...args: Parameters<typeof choice>) => { try { f.service.recordDecision(project.id, choice(...args), coordinator); } catch (error) { return (error as Error).message; } throw new Error("accepted"); };
    // A chain D1 → D2 → D3: the choice to supersede is D3, not D2 (itself replaced).
    const d1 = record("Narrow.", "agent"), d2 = record("Wide.", "agent", d1), d3 = record("Wider.", "agent", d2);
    expect(refusal("None.", "agent", d1)).toBe(`${d1} is superseded, and only an active decision can be superseded. It was replaced, and ${d3} now stands. To change it, supersede ${d3}.`);
    // The user's explicit choice stands: an agent is sent to read, the user is not.
    const u1 = record("Pick A.", "user"), u2 = record("Pick B.", "user", u1);
    expect(refusal("Pick C.", "agent", u1)).toBe(`${u1} is superseded, and only an active decision can be superseded. Read what replaced it first: ${u2} (${u2} is the user's explicit choice, which an agent decision cannot replace).`);
    expect(refusal("Pick C.", "user", u1)).toContain(`supersede ${u2}.`);
    // A worker revises only its own choices.
    const other = { author: "worker" as const, threadId: "thr_other", assignment: null };
    expect(() => f.service.recordDecision(project.id, choice("Mine.", "agent", d1), other)).toThrow("workers revise only their own recorded choices");
    // A decision that was never replaced is recorded fresh, naming the old one.
    const question = f.service.recordQuestion(project.id, { title: "Which?", question: "Which?", context: "c", humanAttention: "needs-opinion" } as never, coordinator);
    f.service.withdrawQuestion(project.id, question.ref, "Settled in chat.", coordinator);
    expect(refusal("Pick A.", "agent", question.ref)).toBe(`${question.ref} is withdrawn, and only an active decision can be superseded. Record the new choice as its own decision and name ${question.ref} in the description.`);
  });

  it("the successor is found at the end of any chain, not after a fixed number of hops", async () => {
    const { f, project } = await projectFixture();
    let ref = f.service.recordDecision(project.id, { decision: { description: "Choice 0", madeBy: "agent" } }, coordinator).ref;
    const first = ref;
    for (let i = 1; i <= 60; i++) ref = f.service.recordDecision(project.id, { decision: { description: `Choice ${i}`, madeBy: "agent" }, supersedes: ref }, coordinator).ref;
    expect(() => f.service.recordDecision(project.id, { decision: { description: "Again", madeBy: "agent" }, supersedes: first }, coordinator)).toThrow(`It was replaced, and ${ref} now stands. To change it, supersede ${ref}.`);
  });
});

describe("T147 v2: review findings", () => {
  it("a close misspelling of a key is named, whatever the action", async () => {
    const { f } = await projectFixture();
    expect(await refused(f, "initiative_manage", { action: "resume", reson: "x" })).toContain("did you mean `reason`?");
  });

  const pr = (i: number, extra: object) => ({ url: `https://github.com/o/r/pull/${i + 1}`, stage: "in-review", ...extra });
  const bounded = (message: string) => expect(Buffer.byteLength(message)).toBeLessThan(4000);

  it("repeated problems are one sentence naming the first places; a batch keeps the error instead of omitting it", async () => {
    const { f } = await projectFixture();
    // 100 PRs x 10 notes, each note with an unknown key: 1000 issues, once a 70 KB error.
    const prs = Array.from({ length: 100 }, (_, i) => pr(i, { notes: Array.from({ length: 10 }, () => ({ text: "x", bad: 1 })) }));
    const message = await refused(f, "initiative_pr", { prs });
    bounded(message);
    expect(message).toContain("`bad` is not a key of prs[0].notes[0]. Same at prs[0].notes[1], prs[0].notes[2], prs[0].notes[3] and 996 more. Valid keys: kind, text, link.");
    expect(message.match(/Valid keys/g)).toHaveLength(1);
    const result = JSON.parse(await f.harness.callAgentTool("initiative_batch", { actions: [{ tool: "pr", prs }] }, { threadId: "coordinator" }) as string);
    expect(result.results[0]).toMatchObject({ tool: "pr", ok: false });
    expect(result.results[0].omitted).toBeUndefined();
    expect(result.results[0].error).toMatch(/^actions\[0\]: Invalid arguments for initiative_pr: `bad` is not a key of prs\[0\]\.notes\[0\]/);
  });

  it("distinct problems are capped, and a long unknown key is clipped", async () => {
    const { f } = await projectFixture();
    const keys = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${"z".repeat(300)}${i}`, 1]));
    const message = await refused(f, "initiative_task", { action: "update", task: "T1", ...keys });
    bounded(message);
    const prs = Array.from({ length: 12 }, (_, i) => ({ url: "oops", stage: "working", [`bad${i}`]: 1 }));
    const many = await refused(f, "initiative_pr", { prs });
    bounded(many);
    expect(many).toMatch(/And \d+ more kinds of problem\./);
  });

  it("a union lists the keys of the branch the input selects", async () => {
    const { f } = await projectFixture();
    const base = { label: "a", purpose: "b", text: "c" };
    const reuse = await refused(f, "initiative_spawn", { ...base, environment: { type: "reuse", envId: "env_a" } });
    expect(reuse).toContain("`envId` is not a key of environment.");
    expect(reuse).toContain("Valid keys: type, environmentId.");
    expect(await refused(f, "initiative_spawn", { ...base, environment: { type: "worktree", environmentId: "e" } })).toContain("`environmentId` is not a key of environment. Valid keys: type.");
    expect(await refused(f, "initiative_manage", { action: "handover", environment: { type: "reuse", envId: "e" } })).toContain("Valid keys: type, environmentId.");
  });

  it("an unknown key in one PR does not hide the independent failures in another", async () => {
    const { f } = await projectFixture();
    const message = await refused(f, "initiative_pr", { prs: [{ url: "oops", stage: "in-review" }, { url: "https://github.com/o/r/pull/1", stage: "in-review", bogus: 1 }] });
    expect(message).toContain("prs.0.url: Expected a GitHub PR URL");
    expect(message).toContain("`bogus` is not a key of prs[1]");
    // The invalid URL beside an unknown key in the same PR is independent too.
    const same = await refused(f, "initiative_pr", { prs: [{ url: "oops", status: "in-review" }] });
    expect(same).toContain("prs.0.url: Expected a GitHub PR URL");
    expect(same).toContain("`status` is not a key of prs[0]; did you mean `stage`?");
  });

  it("a prefixed batch tool is advised to drop the prefix only when the batch can run it", async () => {
    const { f } = await projectFixture();
    for (const tool of ["initiative_manage", "initiative_report", "initiative_spwn"]) {
      const message = await refused(f, "initiative_batch", { actions: [{ tool, action: "resume" }] });
      expect(message, tool).not.toContain("drop the initiative_ prefix");
      expect(message, tool).toContain(`\`actions.0.tool\` is "${tool}", which a batch cannot run. Use one of spawn, message, task, worker, question, rule, decision, update, pr, read (without the initiative_ prefix); any other tool is called on its own.`);
    }
    expect(await refused(f, "initiative_batch", { actions: [{ tool: "initiative_pr", prs: [] }] })).toContain('drop the initiative_ prefix ("pr")');
  });

  it("batched argument errors of the commands are indexed, operational errors are left as they are", async () => {
    const { f } = await projectFixture();
    const result = JSON.parse(await f.harness.callAgentTool("initiative_batch", { actions: [
      { tool: "task", action: "create" },
      { tool: "read", view: "assignments", fields: ["handoff"] },
      { tool: "message", text: "no recipient" },
      { tool: "read", refs: ["X9"] },
      { tool: "worker", action: "retire", worker: "W99" },
    ] }, { threadId: "coordinator" }) as string);
    const errors: string[] = result.results.map((r: { error: string }) => r.error);
    expect(errors[0]).toBe("actions[0]: title is required.");
    expect(errors[1]).toMatch(/^actions\[1\]: handoff applies to none of the records read/);
    expect(errors[2]).toMatch(/^actions\[2\]: Name the recipient/);
    expect(errors[3]).toMatch(/^actions\[3\]: Unknown durable ref X9/);
    expect(errors[4]).not.toMatch(/^actions\[/);
    expect(errors[4]).toMatch(/W99/);
  });

  it("names that exist on Object.prototype are plain unknown keys and actions", async () => {
    const { f } = await projectFixture();
    const read = await refused(f, "initiative_read", { view: "tasks", toString: "x", constructor: "y" });
    expect(read).toContain("`toString`, `constructor` are not keys of initiative_read.");
    expect(read).not.toContain("native code");
    const task = await refused(f, "initiative_task", { action: "constructor", task: "T1" });
    expect(task).not.toContain("undefined");
    expect(await refused(f, "initiative_task", { action: "toString" })).not.toContain("native code");
    expect(await refused(f, "initiative_task", { action: "create", title: "t", valueOf: 1 })).toContain("`valueOf` is not a key of initiative_task.");
  });

  it("a boolean given as a string, beside a JSON-string array, keeps its type error", async () => {
    const { f } = await projectFixture();
    const message = await refused(f, "initiative_read", { refs: '["A552"]', detailed: "true" });
    expect(message).toContain("`refs` is a JSON string; pass an array, not a JSON string.");
    expect(message).toContain("detailed: Invalid input: expected boolean, received string.");
  });
});

describe("T147 v3: review findings", () => {
  const unknownKeys = (count: number, name: (i: number) => string) => Object.fromEntries(Array.from({ length: count }, (_, i) => [name(i), 1]));
  const serialized = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;
  const run = async (f: Fixture, tool: string, input: unknown, threadId = "coordinator") => JSON.parse(await f.harness.callAgentTool(tool, input, { threadId }) as string);

  it("batch errors are bounded in serialized bytes, not characters, and every failure keeps its diagnostic", async () => {
    const { f } = await projectFixture();
    const cases: Record<string, (i: number) => string> = {
      multibyte: i => "界".repeat(39) + i,
      escaped: i => "\\".repeat(39) + i,
      control: i => "\u0001".repeat(39) + i,
    };
    for (const [name, key] of Object.entries(cases)) {
      const keys = unknownKeys(70, key);
      // Direct: the message itself fits the cap.
      const direct = await refused(f, "initiative_task", { action: "create", title: "x", ...keys });
      expect(serialized(direct), name).toBeLessThanOrEqual(MAX_ERROR_BYTES);
      expect(direct, name).toContain("are not keys of initiative_task");
      // Twenty of them in one batch: all twenty errors are there, indexed, none left out.
      const raw = await f.harness.callAgentTool("initiative_batch", { actions: Array.from({ length: 20 }, () => ({ tool: "task", action: "create", title: "x", ...keys })) }, { threadId: "coordinator" }) as string;
      expect(Buffer.byteLength(raw), name).toBeLessThanOrEqual(MAX_READ_BYTES);
      const results = JSON.parse(raw).results;
      expect(results.map((r: { omitted?: true }) => r.omitted), name).toEqual(Array(20).fill(undefined));
      results.forEach((r: { error: string }, i: number) => {
        expect(r.error.startsWith(`actions[${i}]: Invalid arguments for initiative_task: `), name).toBe(true);
        expect(serialized(r.error), name).toBeLessThanOrEqual(MAX_ERROR_BYTES);
        expect(r.error, name).toContain("are not keys of initiative_task");
      });
    }
  });

  it("clipBytes counts what the text costs inside JSON, and never splits a character", () => {
    expect(clipBytes("short", 100)).toBe("short");
    for (const char of ["a", "界", "\\", "\u0001", "😀"]) {
      const clipped = clipBytes(char.repeat(500), 100);
      expect(serialized(clipped), char).toBeLessThanOrEqual(100);
      expect(clipped.endsWith("…"), char).toBe(true);
      expect(clipped.length, char).toBeGreaterThan(1);
      expect(JSON.parse(JSON.stringify(clipped)), char).toBe(clipped);
    }
    expect(serialized(clipBytes("😀".repeat(500), 100))).toBeGreaterThan(90);
  });

  it("a successful read that nearly fills the response cannot push a later error out", async () => {
    const { f } = await projectFixture();
    for (let i = 0; i < 10; i++) await run(f, "initiative_update", { text: `${i}: ${"u".repeat(5997)}` });
    const read = { tool: "read", view: "updates", detailed: true, limit: 30 };
    const alone = await f.harness.callAgentTool("initiative_read", { view: "updates", detailed: true, limit: 30 }, { threadId: "coordinator" }) as string;
    expect(Buffer.byteLength(alone)).toBeGreaterThan(MAX_READ_BYTES - 4000);
    const raw = await f.harness.callAgentTool("initiative_batch", { actions: [read, { tool: "task", action: "create", title: "x", ...unknownKeys(70, i => `key${i}`.padEnd(40, "z")) }, { tool: "worker", action: "retire", worker: "W99" }] }, { threadId: "coordinator" }) as string;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_READ_BYTES);
    const batch = JSON.parse(raw);
    expect(batch).toMatchObject({ succeeded: 0 + (batch.results[0].ok ? 1 : 0), failed: 2 });
    expect(batch.results[1]).toMatchObject({ ok: false });
    expect(batch.results[1].omitted).toBeUndefined();
    expect(batch.results[1].error).toMatch(/^actions\[1\]: Invalid arguments for initiative_task: .*are not keys of initiative_task/);
    expect(batch.results[2].omitted).toBeUndefined();
    expect(batch.results[2].error).toMatch(/W99/);
  });

  it("an absence rule is said even beside an unrelated unknown key", async () => {
    const { f } = await projectFixture();
    const url = "https://github.com/o/r/pull/1";
    const note = await refused(f, "initiative_pr", { prs: [{ url, notes: [{ text: "review comment" }], note: "stage note", zzqq: 1 }] });
    expect(note).toContain("`zzqq` is not a key of prs[0]");
    expect(note).toContain("prs.0.note: A note goes with a stage.");
    expect(await refused(f, "initiative_pr", { prs: [{ url, notes: [{ text: "review comment" }], note: "stage note" }] })).toContain("prs.0.note: A note goes with a stage.");
    expect(await refused(f, "initiative_pr", { prs: [{ url, zzqq: 1 }] })).toContain("Give a stage or one of");
    expect(await refused(f, "initiative_pr", { zzqq: 1 })).toContain("Give prs, rename or both");
    // The advice works: the corrected call records the PR.
    const fixed = await run(f, "initiative_pr", { prs: [{ url, stage: "in-review", note: "stage note" }] });
    expect(JSON.stringify(fixed)).toContain("pull/1");
  });

  it("every argument validation failure in a batch is indexed, operational errors stay as they are", async () => {
    const { f } = await projectFixture();
    const batch = await run(f, "initiative_batch", { actions: [
      { tool: "read", view: "tasks", refs: ["W1"] },
      { tool: "decision", action: "veto-request" },
      { tool: "decision", description: "no action" },
      { tool: "read", view: "records" },
      { tool: "read", limit: "many", view: "workers" },
      { tool: "decision", action: "withdraw", ref: "D99", reason: "r" },
      { tool: "worker", action: "retire", worker: "W99" },
    ] });
    const errors: string[] = batch.results.map((r: { error: string }) => r.error);
    expect(errors[0]).toMatch(/^actions\[0\]: W1 belongs to workers, not tasks\. Omit view/);
    // v9: the decision log is retired, so a veto request is refused with where such a choice goes now.
    expect(errors[1]).toMatch(/^actions\[1\]: Veto requests are retired/);
    expect(errors[2]).toMatch(/^actions\[2\]: Unknown initiative_decision action/);
    expect(errors[3]).toMatch(/^actions\[3\]: view records requires refs/);
    expect(errors[4]).toMatch(/^actions\[4\]: Invalid arguments for initiative_read: /);
    // Not an argument problem: the decision does not exist, the worker does not exist.
    expect(errors[5]).not.toMatch(/^actions\[/);
    expect(errors[6]).not.toMatch(/^actions\[/);
  });
});

describe("T147 v5: malformed containers never break the formatter", () => {
  const url = "https://github.com/o/r/pull/1";
  const malformed: [string, unknown][] = [["empty array", []], ["JSON empty array", "[]"], ["array of null", [null]], ["number", 3]];

  it("a malformed prs beside flat PR fields gets a plain error, direct and in a batch with its index", async () => {
    const { f } = await projectFixture();
    for (const [name, prs] of malformed) {
      const input = { prs, url, stage: "in-review" };
      const message = await refused(f, "initiative_pr", input);
      expect(message, name).toMatch(/^Invalid arguments for initiative_pr: /);
      expect(message, name).not.toMatch(/TypeError|undefined|Cannot/);
      const batch = JSON.parse(await f.harness.callAgentTool("initiative_batch", { actions: [{ tool: "task", action: "create", title: "ok" }, { tool: "pr", ...input }] }, { threadId: "coordinator" }) as string);
      expect(batch.results[1].error, name).toMatch(/^actions\[1\]: Invalid arguments for initiative_pr: /);
      expect(batch.results[1].error, name).not.toMatch(/TypeError|Cannot/);
    }
  });

  it("each malformed prs alone is refused with a message that names it", async () => {
    const { f } = await projectFixture();
    expect(await refused(f, "initiative_pr", { prs: "[]" })).toContain("`prs` is a JSON string; pass an array, not a JSON string.");
    expect(await refused(f, "initiative_pr", { prs: 3 })).toContain("prs: Invalid input: expected array, received number.");
    expect(await refused(f, "initiative_pr", { prs: [null] })).toContain("prs.0: Invalid input: expected object, received null.");
  });
});
