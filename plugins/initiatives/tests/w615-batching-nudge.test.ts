import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installBatchingNudge, NUDGE } from "../lib/batching-nudge";
import { WORKER_SETTINGS_ENV } from "../lib/worker-session";
import { projectFixture } from "./fake-native";

const dir = mkdtempSync(join(tmpdir(), "w615-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const command = installBatchingNudge(join(dir, "hooks"));

type Call = [name: string, input?: Record<string, unknown>];
const read: Call = ["Read", { file_path: "/a.ts" }];
const bash = (cmd: string): Call => ["Bash", { command: cmd }];

/**
 * A transcript as Claude Code writes it: each request a thinking entry and one entry per call,
 * all under one message id, each call followed by its result; `nudged` adds the hook's line
 * after the request's first call.
 */
function transcript(requests: { calls: Call[]; nudged?: boolean }[]) {
  const lines: unknown[] = [{ type: "queue-operation" }, { type: "user", message: { role: "user", content: "go" } }];
  requests.forEach(({ calls, nudged }, r) => {
    const message = (content: unknown[]) => ({ type: "assistant", isSidechain: false, message: { id: `msg_${r}`, role: "assistant", content } });
    lines.push({ type: "api-request" }, message([{ type: "thinking", thinking: "…" }]));
    if (calls.length === 0) lines.push(message([{ type: "text", text: "done" }]));
    calls.forEach(([name, input = {}], c) => {
      const id = `toolu_${r}_${c}`;
      lines.push(message([{ type: "tool_use", id, name, input }]));
      lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] } });
      if (nudged && c === 0)
        lines.push({ type: "attachment", attachment: { type: "hook_additional_context", content: [NUDGE], toolUseID: id, hookEvent: "PostToolUse" } });
    });
  });
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

let n = 0;
/** Runs the hook after the last call of the last request, as Claude Code would. */
function hook(text: string, input: Record<string, unknown> = {}) {
  const path = join(dir, `t${n++}.jsonl`);
  writeFileSync(path, text);
  const last = [...text.matchAll(/"id":"(toolu_[^"]+)"/g)].at(-1)?.[1];
  const result = spawnSync("sh", ["-c", command], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", transcript_path: path, tool_use_id: last, tool_name: "Read", ...input }),
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout === "" ? null : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}
const run = (...requests: Call[][]) => hook(transcript(requests.map((calls) => ({ calls }))));

describe("W615 batching nudge", () => {
  it("is silent after 2 single reads", () => {
    expect(run([read], [read], [read])).toBeNull();
  });

  it("fires on the next call after 3 requests of one read each", () => {
    expect(run([read], [["Grep", { pattern: "x" }]], [bash("sed -n 1,80p a.ts | head -5")], [read])).toBe(NUDGE);
    expect(run([["Edit"]], [["Glob", { pattern: "*.ts" }]], [read], [read], [["Edit"]])).toBe(NUDGE);
  });

  it("is silent when one of the 3 was an edit, a write or not a single call", () => {
    expect(run([read], [["Edit", { file_path: "/a.ts" }]], [read], [read])).toBeNull();
    expect(run([read], [["Write", { file_path: "/a.ts" }]], [read], [read])).toBeNull();
    expect(run([read], [read, read], [read], [read])).toBeNull();
    expect(run([read], [], [read], [read])).toBeNull();
    expect(run([read], [read], [["mcp__bb-bridge__memory_zoom"]], [read])).toBeNull();
  });

  it("is silent while the current request already batches", () => {
    expect(run([read], [read], [read], [read, read])).toBeNull();
  });

  it("speaks at most once per 3 requests", () => {
    const reads = (count: number, nudgedAt?: number) =>
      Array.from({ length: count }, (_, r) => ({ calls: [read], nudged: r === nudgedAt }));
    expect(hook(transcript(reads(4)))).toBe(NUDGE);
    // Nudged at request 3: silent on requests 4 and 5, free again on 6.
    expect(hook(transcript(reads(5, 3)))).toBeNull();
    expect(hook(transcript(reads(6, 3)))).toBeNull();
    expect(hook(transcript(reads(7, 3)))).toBe(NUDGE);
    // Its own line on this very request (an earlier call of it): silent.
    expect(hook(transcript([...reads(3), { calls: [read], nudged: true }]))).toBeNull();
  });

  it("counts only Bash lines made of reading programs", () => {
    const fires = (cmd: string) => run([bash(cmd)], [read], [read], [read]) === NUDGE;
    for (const cmd of [
      "cat a.ts",
      `grep -n "a\\|b" -r src 2>/dev/null | head -20; sed -n '40,120p' a.ts`,
      "cd repo && git -C x log --oneline -5 && git diff --stat",
      "ls -la >/dev/null 2>&1 || echo none",
      "find . -name '*.ts' | sort | uniq -c | wc -l",
      `echo "it's > fine" && rg 'a>b' src`,
      "sed -n '1,5p;5q' a.ts",
      "sed -ne '$p' a.ts",
      "rg -n pattern \\\n  src | uniq -c -",
      "echo 'a\\\nb'",
      "sort -u -k2 -t, a.csv",
      "git grep -n x -- '*.ts'",
    ])
      expect(fires(cmd), cmd).toBe(true);
    for (const cmd of [
      "sed -i s/a/b/ a.ts",
      "sed -ni 1p a.ts",
      "cat a.ts > b.ts",
      "echo hi >> log",
      "echo $(rm -rf x)",
      'echo "$(touch x)"',
      "echo `id`",
      "cat <<EOF\nx\nEOF",
      "git commit -am x",
      "git -C repo checkout main",
      "find . -name x -delete",
      "sort -o out in",
      "sort -ooutput.txt in",
      "sort -uo out in",
      "sort --out=out in",
      "sed -n '1w output.txt' input.txt",
      "sed 'e touch output.txt' input.txt",
      "sed -n '/x/p' a.ts",
      "sed -e 1p -e 's/a/b/w out' a.ts",
      "sed --in-place=.bak 1p a.ts",
      "rg --pre ./generate.sh pattern input.txt",
      "rg --pre=./generate.sh pattern",
      "rg --hostname-bin=./x pattern",
      "git log --output=x",
      "git diff --out=x",
      "git grep -O x",
      "git grep -nOvim x",
      "git grep --open-files-in-pager=vim x",
      "tree -o out .",
      "uniq in out",
      "uniq -- /dev/null -output.txt",
      "uniq - output.txt",
      "uniq -u - output.txt",
      "find . -de\\\nlete",
      'find . "-de\\\nlete"',
      "rg --p\\\nre ./generate.sh pattern",
      "sort --{output=out.txt,unique} input.txt",
      "sort $'--output=out.txt' input.txt",
      'sort "$OPT" input.txt',
      "sort $OPT input.txt",
      "sort * ",
      "cat ~/x",
      "git diff --ext-diff",
      "git show --textconv HEAD",
      "git cat-file --filters HEAD:README.md",
      "python3 -c 'print(1)'",
      "npm test",
      "X=1 cat a",
      "rm a.ts",
      "cat 'unterminated",
    ])
      expect(fires(cmd), cmd).toBe(false);
  });

  it("is silent on a malformed transcript, a missing one, a bad input or a subagent's call", () => {
    const good = transcript([[read], [read], [read], [read]].map((calls) => ({ calls })));
    const lines = good.split("\n");
    lines.splice(lines.length - 6, 0, '{"type":"assistant", broken');
    expect(hook(lines.join("\n"))).toBeNull();
    expect(hook(good, { transcript_path: join(dir, "missing.jsonl") })).toBeNull();
    expect(hook(good, { tool_use_id: "toolu_unknown" })).toBeNull();
    expect(hook(good, { agent_id: "agent_1" })).toBeNull();
    expect(hook(good)).toBe(NUDGE);
    const bad = spawnSync("sh", ["-c", command], { input: "not json", encoding: "utf8" });
    expect([bad.status, bad.stdout, bad.stderr]).toEqual([0, "", ""]);
  });

  it("reads only the tail, and then needs one request older than the 3", () => {
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(3 * 1024 * 1024) } });
    const requests = (count: number) => transcript(Array.from({ length: count }, () => ({ calls: [read] })));
    const cut = (text: string) => `${filler}\n${text}`;
    expect(hook(cut(requests(4)))).toBeNull();
    expect(hook(cut(requests(5)))).toBe(NUDGE);
  });

  it("goes into worker sessions with a script that exists", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref], label: "Nudge", area: "Tokens", permissionMode: "full" });
    const env = await f.harness.resolveProviderEnv("claude-code", { threadId: d.threadId!, projectId: "proj_a", hostId: "host_a" });
    const settings = JSON.parse(env.find((e: { name: string }) => e.name === WORKER_SETTINGS_ENV)!.value as string);
    const [entry] = settings.hooks.PostToolUse;
    expect(entry.matcher).toBe("Read|Grep|Glob|Bash");
    const script = JSON.parse(entry.hooks[0].command.split(" ").at(-1));
    expect(existsSync(script)).toBe(true);
    expect(settings.permissions.deny).toContain("Workflow");
  });

  it("leaves the hook out on another host, where its node and script don't exist", async () => {
    const { f, project } = await projectFixture();
    const [d] = await f.service.delegate(project.id, { route: "fresh", tasks: [f.task(project.id).ref], label: "Nudge", area: "Tokens", permissionMode: "full" });
    const env = await f.harness.resolveProviderEnv("claude-code", { threadId: d.threadId!, projectId: "proj_a", hostId: "host_mac" });
    const settings = JSON.parse(env.find((e: { name: string }) => e.name === WORKER_SETTINGS_ENV)!.value as string);
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions.deny).toContain("Workflow");
  });
});
