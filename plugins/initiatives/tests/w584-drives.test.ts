import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { DriveError, Drives, INDEX_MAX, cleanPath } from "../lib/drive";
import { EDIT_MAX_BYTES } from "../lib/drive-types";
import { projectFixture } from "./fake-native";

// W584: an Adventure's drive, a folder on the server host shared by its threads.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function drives() {
  const dir = mkdtempSync(join(tmpdir(), "w584-"));
  dirs.push(dir);
  return new Drives(join(dir, "drives"));
}

describe("W584 drive paths", () => {
  it("takes relative paths only", () => {
    expect(cleanPath("notes/plan.md")).toBe("notes/plan.md");
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a/", "a\\b", "a\0b", ".drive-tmp-1"])
      expect(() => cleanPath(bad), JSON.stringify(bad)).toThrow(DriveError);
  });

  it("refuses symlinks that lead outside the drive, for reads and writes, and lists only the ones that stay inside", () => {
    const d = drives();
    const outside = mkdtempSync(join(tmpdir(), "w584-out-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "# Secret\n");
    d.save("p1", "inside.md", "# Inside\n", null);
    const root = d.root("p1");
    symlinkSync(join(outside, "secret.md"), join(root, "leak.md"));
    symlinkSync(outside, join(root, "out"));
    symlinkSync(join(root, "inside.md"), join(root, "alias.md"));
    expect(() => d.read("p1", "leak.md")).toThrow(/outside the drive/);
    expect(() => d.read("p1", "out/secret.md")).toThrow(/outside the drive/);
    expect(() => d.save("p1", "out/new.md", "x", null)).toThrow(/outside the drive/);
    expect(() => d.change("p1", { kind: "upload", path: "out/new.bin", base64: "AAAA", replace: false })).toThrow(/outside the drive/);
    expect(() => d.change("p1", { kind: "delete", path: "out/secret.md" })).toThrow(/outside the drive/);
    expect(() => d.change("p1", { kind: "move", from: "inside.md", to: "out/moved.md" })).toThrow(/outside the drive/);
    expect(readdirSync(outside)).toEqual(["secret.md"]);
    expect(d.read("p1", "alias.md").text).toBe("# Inside\n");
    expect(d.list("p1").entries.map((e) => e.path)).toEqual(["alias.md", "inside.md"]);
    // Deleting a link removes the link, never what it points to.
    d.change("p1", { kind: "delete", path: "leak.md" });
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("# Secret\n");
  });
});

describe("W584 a drive folder that is itself a link", () => {
  it("is refused for every operation, so a link can't move the boundary outside", () => {
    const d = drives();
    const outside = mkdtempSync(join(tmpdir(), "w584-out-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "# Secret\n");
    mkdirSync(d.dir, { recursive: true });
    symlinkSync(outside, d.root("p1"));
    expect(() => d.read("p1", "secret.md")).toThrow(/is a link/);
    expect(() => d.save("p1", "secret.md", "x", null)).toThrow(/is a link/);
    expect(() => d.save("p1", "new.md", "x", null)).toThrow(/is a link/);
    expect(() => d.change("p1", { kind: "delete", path: "secret.md" })).toThrow(/is a link/);
    expect(() => d.list("p1")).toThrow(/is a link/);
    expect(d.indexLine("p1")).toMatch(/file list is unavailable \(.*is a link.*\): ls the folder\.$/);
    expect(readdirSync(outside)).toEqual(["secret.md"]);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("# Secret\n");
  });
});

describe("W584 drive files", () => {
  it("creates the folder on the first write, and lists folders first with markdown headings", () => {
    const d = drives();
    expect(d.list("p1").entries).toEqual([]);
    expect(() => readdirSync(d.root("p1"))).toThrow();
    d.save("p1", "plan.md", "Intro\n\n# The plan\n", null);
    d.change("p1", { kind: "mkdir", path: "refs" });
    d.change("p1", { kind: "upload", path: "refs/logo.png", base64: Buffer.from([0x89, 0x50, 0, 1]).toString("base64"), replace: false });
    const list = d.list("p1");
    expect(list.entries.map((e) => [e.path, e.kind, e.title])).toEqual([
      ["refs", "dir", null], ["refs/logo.png", "file", null], ["plan.md", "file", "The plan"],
    ]);
    expect(d.read("p1", "refs/logo.png")).toMatchObject({ size: 4, text: null });
    expect(() => d.change("p1", { kind: "upload", path: "refs/logo.png", base64: "AA==", replace: false })).toThrow(/already exists/);
    d.change("p1", { kind: "move", from: "refs", to: "assets/refs" });
    expect(() => d.change("p1", { kind: "move", from: "assets", to: "assets/inner" })).toThrow(/into itself/);
    d.change("p1", { kind: "delete", path: "assets" });
    expect(d.list("p1").entries.map((e) => e.path)).toEqual(["plan.md"]);
  });

  it("refuses a save over a file that changed since it was loaded, and keeps the newer file", () => {
    const d = drives();
    const created = d.save("p1", "notes.md", "one\n", null);
    if (!("saved" in created)) throw new Error("expected a save");
    // An agent rewrites the file with its own tools.
    writeFileSync(join(d.root("p1"), "notes.md"), "agent\n");
    const stale = d.save("p1", "notes.md", "mine\n", created.saved.version);
    expect(stale).toMatchObject({ conflict: { text: "agent\n" } });
    expect(readFileSync(join(d.root("p1"), "notes.md"), "utf8")).toBe("agent\n");
    // Creating over an existing file, or saving over a deleted one, is a conflict too.
    expect(d.save("p1", "notes.md", "new\n", null)).toMatchObject({ conflict: { text: "agent\n" } });
    rmSync(join(d.root("p1"), "notes.md"));
    expect(d.save("p1", "notes.md", "mine\n", created.saved.version)).toEqual({ conflict: null });
    const fresh = d.save("p1", "notes.md", "mine\n", null);
    expect(fresh).toMatchObject({ saved: { text: "mine\n" } });
    expect(() => d.save("p1", "big.md", "x".repeat(EDIT_MAX_BYTES + 1), null)).toThrow(/at most/);
    // A refused save creates nothing, not even its folder.
    expect(d.save("p1", "gone/plan.md", "mine\n", created.saved.version)).toEqual({ conflict: null });
    // Writes go through a temp file the listing never shows.
    expect(readdirSync(d.root("p1"))).toEqual(["notes.md"]);
  });
});

describe("W584 the drive's index line", () => {
  it("names the path and at most INDEX_MAX newest files, never their contents", () => {
    const d = drives();
    expect(d.indexLine("p1")).toMatch(/drives\/p1\/, the files .* It is empty so far\.$/);
    for (let i = 0; i < INDEX_MAX + 12; i++) d.save("p1", `notes/n${String(i).padStart(2, "0")}.md`, `# Note ${i}\n\nSECRET BODY ${i}\n`, null);
    const line = d.indexLine("p1");
    expect(line).not.toMatch(/SECRET BODY/);
    expect(line.match(/notes\/n\d\d\.md/gu)).toHaveLength(INDEX_MAX);
    expect(line).toMatch(/"Note \d+"/);
    expect(line).toMatch(/; \+12 more: ls the folder\.$/);
    expect(line.length).toBeLessThan(2000);
    // Long paths fill the character budget before the count.
    for (let i = 0; i < 20; i++) d.save("p1", `research/${"long-name-".repeat(10)}${i}.md`, "x", null);
    const long = d.indexLine("p1");
    expect(long.match(/research\//gu)!.length).toBeLessThan(15);
    expect(long.length).toBeLessThan(2000);
  });

  it("skips FIFOs and anything else that is neither a file nor a folder", () => {
    const d = drives();
    d.save("p1", "a.md", "# A\n", null);
    execFileSync("mkfifo", [join(d.root("p1"), "x.md")]);
    expect(d.list("p1").entries.map((e) => e.path)).toEqual(["a.md"]);
    expect(d.indexLine("p1")).not.toContain("x.md");
    expect(() => d.read("p1", "x.md")).toThrow(/is not a file/);
  });

  it("finds the newest files past the listing's limit, and counts the rest", () => {
    const d = drives();
    mkdirSync(join(d.root("p1"), "a"), { recursive: true });
    const old = new Date("2026-01-01");
    for (let i = 0; i < 2005; i++) {
      writeFileSync(join(d.root("p1"), "a", `f${String(i).padStart(4, "0")}.txt`), "x");
      utimesSync(join(d.root("p1"), "a", `f${String(i).padStart(4, "0")}.txt`), old, old);
    }
    d.save("p1", "z-newest.md", "# Newest\n", null);
    expect(d.list("p1").truncated).toBe(true);
    const line = d.indexLine("p1");
    expect(line).toMatch(/newest first: z-newest\.md \([^)]*"Newest"\);/);
    expect(line).toMatch(/; \+1976 more: ls the folder\.$/);
  });

  it("says the list is unavailable, and why, instead of calling an unreadable drive empty", () => {
    const d = drives();
    d.save("p1", "plan.md", "# Plan\n", null);
    chmodSync(d.root("p1"), 0o000);
    try {
      expect(d.indexLine("p1")).toMatch(/Its file list is unavailable \(EACCES[^)]*\): ls the folder\.$/);
    } finally {
      chmodSync(d.root("p1"), 0o755);
    }
  });

  it("skips an unreadable folder inside the drive and lists the rest", () => {
    const d = drives();
    for (const name of ["a", "b", "c"]) d.save("p1", `${name}/x.md`, "x", null);
    chmodSync(join(d.root("p1"), "b"), 0o000);
    try {
      expect(d.list("p1").entries.map((e) => e.path).sort()).toEqual(["a", "a/x.md", "b", "c", "c/x.md"]);
      expect(d.indexLine("p1")).toContain("c/x.md");
    } finally {
      chmodSync(join(d.root("p1"), "b"), 0o755);
    }
  });

  it("counts the files instead of calling the drive empty when none fits the budget", () => {
    const d = drives();
    const deep = join(d.dir, "p1", ...Array.from({ length: 8 }, (_, i) => `${i}`.repeat(200)));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "plan.md"), "# Plan\n");
    expect(d.indexLine("p1")).toMatch(/ It holds 1 file: ls the folder\.$/);
  });

  it("goes into every brief, the coordinator's instructions and the overview read", async () => {
    const { f, project } = await projectFixture();
    const drive = f.service.drives!;
    drive.save(project.id, "plan.md", "# Rollout plan\n\nsteps\n", null);
    const [w] = JSON.parse((await f.harness.callAgentTool("initiative_spawn", { label: "Docs", purpose: "Write docs", text: "Do it." }, { threadId: "coordinator" })) as string);
    const brief = f.store.assignments(project.id).at(-1)!.briefText;
    expect(brief).toContain(`Adventure drive: ${drive.root(project.id)}/`);
    expect(brief).toMatch(/plan\.md \([\d.]+ B, \d{4}-\d\d-\d\d, "Rollout plan"\)/);
    expect(brief).not.toContain("steps");
    expect(w.threadId).toBeTruthy();
    const { instructions } = await f.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: f.threads.get("coordinator")! }));
    expect(instructions).toContain(`${drive.root(project.id)}/`);
    expect(instructions).not.toContain("plan.md");
    const overview = JSON.parse((await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" })) as string);
    expect(overview.drive).toContain("plan.md");
  });
});

describe("W584 the raw file route", () => {
  it("streams a file's bytes with its length, and refuses folders and unknown Initiatives", async () => {
    const { f, project } = await projectFixture();
    const drive = f.service.drives!;
    drive.save(project.id, "refs/data.txt", "x".repeat(100_000), null);
    const url = (projectId: string, path: string) => `/drive/raw?${new URLSearchParams({ projectId, path })}`;
    const ok = await f.harness.fetchHttp("GET", url(project.id, "refs/data.txt"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-length")).toBe("100000");
    expect(ok.body).toBeInstanceOf(ReadableStream);
    expect((await ok.text()).length).toBe(100_000);
    expect((await f.harness.fetchHttp("GET", url(project.id, "refs"))).status).toBe(404);
    expect((await f.harness.fetchHttp("GET", url("prj_nope", "refs/data.txt"))).status).toBe(404);
  });
});

describe("W584 the drive watcher", () => {
  it("announces each changed drive once per burst", async () => {
    const d = drives();
    const seen: string[] = [];
    mkdirSync(d.dir, { recursive: true });
    const stop = d.watch((projectId) => seen.push(projectId), (message) => { throw new Error(message); });
    try {
      for (let i = 0; i < 10; i++) d.save("p1", `n${i}.md`, "x", null);
      d.save("p2", "a.md", "x", null);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(seen.sort()).toEqual(["p1", "p2"]);
    } finally {
      stop();
    }
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

  it("doesn't follow a symlinked folder out of the drive", async () => {
    const d = drives();
    const outside = mkdtempSync(join(tmpdir(), "w584-out-"));
    dirs.push(outside);
    d.save("p1", "a.md", "x", null);
    symlinkSync(outside, join(d.root("p1"), "repo"));
    const seen: string[] = [];
    const stop = d.watch((projectId) => seen.push(projectId), (message) => { throw new Error(message); });
    try {
      mkdirSync(join(outside, "sub"));
      writeFileSync(join(outside, "file.txt"), "x");
      writeFileSync(join(outside, "sub", "deep.txt"), "x");
      await settle();
      expect(seen).toEqual([]);
      writeFileSync(join(d.root("p1"), "b.md"), "x");
      await settle();
      expect(seen).toEqual(["p1"]);
    } finally {
      stop();
    }
  });

  it("keeps announcing after a drive folder, or a folder in it, is replaced in place", async () => {
    const d = drives();
    d.save("p1", "notes/a.md", "x", null);
    const seen: string[] = [];
    const stop = d.watch((projectId) => seen.push(projectId), (message) => { throw new Error(message); });
    const away = mkdtempSync(join(tmpdir(), "w584-away-"));
    dirs.push(away);
    try {
      renameSync(d.root("p1"), join(away, "p1"));
      d.save("p1", "notes/b.md", "x", null);
      await settle();
      seen.length = 0;
      writeFileSync(join(d.root("p1"), "notes", "c.md"), "x");
      await settle();
      expect(seen).toEqual(["p1"]);
      // Writes in the folder that moved away no longer count.
      writeFileSync(join(away, "p1", "notes", "old.md"), "x");
      await settle();
      expect(seen).toEqual(["p1"]);
    } finally {
      stop();
    }
  });

  it("keeps watching the folders after an unreadable one", async () => {
    const d = drives();
    for (const name of ["a", "b", "c"]) d.save("p1", `${name}/x.md`, "x", null);
    chmodSync(join(d.root("p1"), "b"), 0o000);
    const seen: string[] = [];
    const stop = d.watch((projectId) => seen.push(projectId), () => {});
    try {
      writeFileSync(join(d.root("p1"), "c", "y.md"), "x");
      await settle();
      expect(seen).toEqual(["p1"]);
    } finally {
      stop();
      chmodSync(join(d.root("p1"), "b"), 0o755);
    }
  });

  it("keeps announcing after a folder is deleted and made again under the same name (ext4 reuses its inode)", async () => {
    const d = drives();
    d.save("p1", "notes/a.md", "x", null);
    const seen: string[] = [];
    const stop = d.watch((projectId) => seen.push(projectId), (message) => { throw new Error(message); });
    try {
      for (const folder of [join(d.root("p1"), "notes"), d.root("p1")]) {
        rmSync(folder, { recursive: true });
        mkdirSync(join(d.root("p1"), "notes"), { recursive: true });
        await settle();
        seen.length = 0;
        writeFileSync(join(d.root("p1"), "notes", "c.md"), "x");
        await settle();
        expect(seen, folder).toEqual(["p1"]);
      }
    } finally {
      stop();
    }
  });
});
