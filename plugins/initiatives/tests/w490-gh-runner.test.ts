// W490: runGh against a real child process, a fake `gh` on PATH. execFile's own `timeout`
// destroyed stdout before it signalled, so a gh that had already exited 0 while the event loop
// was busy resolved with "" and the list read "Unexpected end of JSON input".
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGh } from "../lib/merge-queue-server";

describe("runGh (W490)", () => {
  let dir: string;
  const path = process.env.PATH;
  /** Installs a `gh` that runs this shell script, alone on PATH. */
  const fakeGh = (script: string) => {
    writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:/usr/bin:/bin`;
  };
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "w490-gh-")); });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands over all a gh wrote when it exits while the event loop is busy past the bound", async () => {
    // 100 KB fits the stdio socket's buffer: gh can write it all and exit before a byte is read.
    const answer = JSON.stringify({ data: { search: { nodes: ["x".repeat(100_000)] } } });
    writeFileSync(join(dir, "answer.json"), answer);
    fakeGh(`exec cat "${join(dir, "answer.json")}"`);
    const out = runGh(["api", "graphql"], 50);
    // Busy, as the BB server is during a ledger rebuild: gh exits, then the bound passes, unread.
    const until = Date.now() + 1_000;
    while (Date.now() < until);
    await expect(out).resolves.toBe(answer);
  });

  it("kills a gh that outlives its bound and says it timed out", async () => {
    fakeGh("exec sleep 5");
    const start = Date.now();
    await expect(runGh(["pr", "list"], 200)).rejects.toThrow(/^gh pr list timed out after 1 s$/);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("names a failure by stderr's last line, else by its exit code", async () => {
    fakeGh('echo "retrying" >&2; echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1');
    await expect(runGh(["api", "graphql"])).rejects.toThrow(/^HTTP 502: Bad Gateway \(https:\/\/api\.github\.com\/graphql\)$/);
    fakeGh("exit 3");
    await expect(runGh(["pr", "view", "https://github.com/o/r/pull/1"])).rejects.toThrow(/^gh pr view exited with code 3$/);
  });

  it("says so when gh is not installed", async () => {
    rmSync(join(dir, "gh"));
    process.env.PATH = dir;
    await expect(runGh(["api", "user"])).rejects.toThrow("the GitHub CLI (gh) is not installed on the BB server");
  });
});
