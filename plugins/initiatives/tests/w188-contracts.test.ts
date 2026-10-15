import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manageCommand, manageToolSchema, messageCommand, messageToolSchema, questionToolSchema, ruleCommand, ruleToolSchema, spawnCommand, spawnToolSchema, taskCommand, taskToolSchema, workerCommand, workerToolSchema } from "../lib/agent-tools";
import { prToolSchema } from "../lib/pr-stages";
import { parseDecisionCommand, REMOVED_ACTIONS } from "../lib/commands";
import { agentReadSchema, readOptionsSchema, validateFields, validateSelection, viewForRef, withImpliedDetail, type ReadView } from "../lib/read";

/**
 * W188 (F5): every call an error or hint suggests must work through the real tool API.
 * This scans the plugin's own source for suggested calls — `initiative_<tool> {…}` and bare
 * `{"action":…}` examples — fills in their placeholders, and parses each one exactly as the
 * tool does. Tool descriptions and the standing instructions (lib/guidance.ts) document fields
 * in a shorthand ({action:"create",title,text?}) and are exempt.
 */
const root = new URL("../", import.meta.url);
const sources = ["server.ts", ...readdirSync(new URL("lib/", root)).filter(f => f.endsWith(".ts") && f !== "guidance.ts").map(f => `lib/${f}`)];

/** The text from an opening brace to its match, with `${…}` expressions replaced by @@. */
function extract(text: string, start: number) {
  let out = "", depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text.startsWith("${", i)) {
      let d = 0, j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "{") d++;
        if (text[j] === "}" && --d === 0) break;
      }
      out += "@@";
      i = j;
      continue;
    }
    const c = text[i]!;
    out += c;
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return out;
  }
  return null;
}

const BY_KEY: Record<string, string> = { ref: "D12", supersedes: "D12", decision: "D12", task: "T4", tasks: "T4", assignment: "A3", to: "W3", worker: "W3", reviews: "W3", refs: "A3", handoffs: "W3" };
const PLACEHOLDER: Record<string, string> = { "T#": "T4", "W#": "W3", "D#": "D12", "A#": "A3", "<the PR URL>": "https://github.com/o/r/pull/12" };
function fill(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map(v => fill(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, k)]));
  if (typeof value !== "string") return value;
  if (value in PLACEHOLDER) return PLACEHOLDER[value];
  return value.includes("@@") ? value.replace(/@@/g, BY_KEY[key] ?? "x") : value;
}

const DECISION = ["user-choice", "veto-request", "question", "answer", "withdraw", "decision"];
const TASK = ["create", "update", "status", "close", "reopen"];
const RULE = ["add", "edit", "remove"];
const WORKER = ["retire", "stop", "adopt"];
const MANAGE = ["pause", "resume", "stop-work", "archive", "edit", "handover"];
function toolFor(example: Record<string, unknown>) {
  const action = example.action;
  if (typeof action === "string") {
    if (DECISION.includes(action)) return "initiative_decision";
    if (TASK.includes(action)) return "initiative_task";
    if (RULE.includes(action)) return "initiative_rule";
    if (WORKER.includes(action)) return "initiative_worker";
    if (MANAGE.includes(action)) return "initiative_manage";
    return null;
  }
  if ("to" in example) return "initiative_message";
  if ("refs" in example || "view" in example) return "initiative_read";
  return null;
}

/** Parse exactly as the tool's execute does; throws when the tool would refuse the input. */
function parseAs(tool: string, raw: Record<string, unknown>) {
  const action = raw.action;
  if (typeof action === "string" && action in REMOVED_ACTIONS) throw new Error(`suggests the removed action ${action}`);
  switch (tool) {
    case "initiative_decision": return parseDecisionCommand(raw);
    case "initiative_task": return taskCommand(taskToolSchema.parse(raw));
    case "initiative_worker": return workerCommand(workerToolSchema.parse(raw));
    case "initiative_message": return messageCommand(messageToolSchema.parse(raw));
    case "initiative_manage": return manageCommand(manageToolSchema.parse(raw));
    case "initiative_spawn": return spawnCommand(spawnToolSchema.parse(raw));
    case "initiative_rule": return ruleCommand(ruleToolSchema.parse(raw));
    case "initiative_question": return questionToolSchema.parse(raw);
    case "initiative_pr": return prToolSchema.parse(raw);
    case "initiative_read": {
      const { view, category, stage, unassigned, ...rest } = agentReadSchema.parse(raw);
      const options = withImpliedDetail(readOptionsSchema.parse(rest));
      if ((category !== undefined || stage !== undefined || unassigned !== undefined) && (view !== "prs" || options.refs)) throw new Error("category, stage and unassigned select a slice of view prs");
      // Like the server: mixed refs need a field for some kind, a view needs its own refs and fields.
      if (!view && options.refs || view === "records") validateFields([...new Set((options.refs ?? []).map(viewForRef))], options);
      else if (view && !["overview", "context"].includes(view)) validateSelection(view as ReadView, options);
      return options;
    }
    default: throw new Error(`unknown tool ${tool}`);
  }
}

interface Example { file: string; line: number; tool: string | null; text: string }
function examples(): Example[] {
  const found: Example[] = [];
  for (const file of sources) {
    const text = readFileSync(new URL(file, root), "utf8");
    const pattern = /(initiative_[a-z_]+) \{|\{"(?:action|to|refs|view)":/g;
    for (let m; (m = pattern.exec(text)); ) {
      const brace = text.indexOf("{", m.index);
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const line = text.slice(lineStart, text.indexOf("\n", m.index));
      // Tool descriptions document fields in shorthand; they are not calls.
      if (/^\s*(description:|\.describe\(|\/\/|\*)/.test(line) || /\.describe\(/.test(text.slice(lineStart, m.index))) continue;
      const body = extract(text, brace);
      if (!body) continue;
      found.push({ file, line: text.slice(0, m.index).split("\n").length, tool: m[1] ?? null, text: body });
    }
  }
  return found;
}

describe("W188 every suggested call parses through the real API", () => {
  const all = examples();

  it("finds the suggested calls (the scan itself works)", () => {
    // notOpenQuestion's rule hints, the read hints, the removed-action replacements.
    expect(all.length).toBeGreaterThan(10);
    expect(all.some(e => e.file === "lib/service.ts" && e.tool === "initiative_rule" && e.text.includes('"action":"add"'))).toBe(true);
  });

  it.each(all.map(e => [`${e.file}:${e.line} ${e.text.slice(0, 90)}`, e] as const))("%s", (_name, example) => {
    const json = example.text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    let raw: Record<string, unknown>;
    try {
      raw = fill(JSON.parse(json)) as Record<string, unknown>;
    } catch {
      throw new Error(`${example.file}:${example.line} suggests a call that is not valid JSON: ${example.text}`);
    }
    const tool = example.tool ?? toolFor(raw);
    expect(tool, `${example.file}:${example.line} names no tool and its fields map to none: ${example.text}`).not.toBeNull();
    expect(() => parseAs(tool!, raw), `${example.file}:${example.line} ${tool} ${JSON.stringify(raw)}`).not.toThrow();
  });
});

describe("W188 F5: the CLI", () => {
  it("lists describe in its usage, routes describe decision, and names an unknown subcommand", async () => {
    const { projectFixture } = await import("./fake-native");
    const { f } = await projectFixture();
    const decision = await f.harness.runCli(["describe", "decision"]);
    expect(decision.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(decision.stdout!))).toEqual(["question", "answer", "quiet-answer", "withdraw"]);
    const unknown = await f.harness.runCli(["decision", "--help"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toMatch(/^Unknown subcommand decision\. Usage: bb initiative describe \[name\] \| list/);
    const badName = await f.harness.runCli(["describe", "cleanup"]);
    expect(badName.stderr).toMatch(/Unknown example cleanup\. Available: read, decision, initiative_decision/);
  });
});

describe("W188: a long initiative_report summary", () => {
  it("is clipped for the dashboard, kept in full, and the result says so", async () => {
    const { projectFixture } = await import("./fake-native");
    const { f, project } = await projectFixture();
    const [w] = JSON.parse(await f.harness.callAgentTool("initiative_spawn", { label: "Search", purpose: "search", text: "Do it." }, { threadId: "coordinator" }) as string);
    const summary = `Indexed archived records and ranked them below live ones. ${"Verified with the full suite and a manual check. ".repeat(14)}`.trim();
    expect(summary.length).toBeGreaterThan(600);
    const result = JSON.parse(await f.harness.callAgentTool("initiative_report", { outcome: "done", summary, report: "Done." }, { threadId: w.threadId }) as string);
    expect(result.note).toContain(`The summary is ${summary.length} characters: the dashboard shows its first 300, and the full text is kept with the report.`);
    const report = f.store.assignment(project.id, 1)!.report!;
    expect(report.summary).toHaveLength(300);
    expect(report.summary.endsWith("…")).toBe(true);
    expect(report.handoff.summary).toBe(summary);
  });
});
