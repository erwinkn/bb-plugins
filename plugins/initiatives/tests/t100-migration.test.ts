import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, projectFixture, report } from "./fake-native";
import { MIGRATIONS } from "../lib/store";
import { DEFAULT_PROFILES } from "../lib/schema";
import { settingsDescriptors } from "../lib/settings";
import { ownMetadata } from "../lib/identity";
import { applyMigrations } from "../lib/migration/bb-migrations";
import { copyRows, schemaDifferences, unsettledOperations, verifyCopy } from "../lib/migration/sqlite";
import { handBackProblem } from "../lib/migration/legacy";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const coordinator = { author: "coordinator" as const, threadId: "coordinator", assignment: null };

/**
 * A populated ledger written by this plugin's own code, saved where the
 * former `projects` install keeps it, without the import's bookkeeping.
 */
async function formerLedger() {
  const { f, project } = await projectFixture();
  const task = f.task(project.id);
  const [delegated] = await f.service.delegate(project.id, { route: "fresh", tasks: [task.ref] });
  await f.service.report(delegated.threadId!, report());
  f.service.recordDecision(project.id, { decision: { description: "Reuse the index.", madeBy: "agent" } }, coordinator);
  const dataDir = mkdtempSync(join(tmpdir(), "former-ledger-"));
  mkdirSync(join(dataDir, "plugins", "projects"), { recursive: true });
  const path = join(dataDir, "plugins", "projects", "data.db");
  copyFileSync(f.store.db.name, path);
  const copy = new Database(path);
  for (const { name } of copy
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_initiatives\\_%' ESCAPE '\\'")
    .all() as { name: string }[])
    copy.exec(`DROP TABLE "${name}"`);
  copy.close();
  const metadata = new Map([...f.metadata].filter(([, meta]) => Object.keys(meta).length));
  return { dataDir, path, project, worker: delegated.threadId!, metadata };
}

type Former = Awaited<ReturnType<typeof formerLedger>>;

/** A fresh `initiatives` install on the same BB, with namespaced metadata and tabs. */
function install(former: Former, legacy: { enabled: boolean; status: string } | null = { enabled: false, status: "disabled" }) {
  const f = fixture(undefined, { dataDir: former.dataDir });
  const state = { legacy };
  const namespaces = new Map<string, Map<string, Record<string, unknown>>>([
    ["projects", new Map(former.metadata)],
    ["initiatives", new Map()],
  ]);
  const tabs = new Map<string, { revision: number; tabs: Record<string, unknown>[] }>([
    ["coordinator", {
      revision: 3,
      tabs: [
        { id: "info", kind: "thread-info" },
        { id: "panel", kind: "plugin-panel", pluginId: "projects", actionId: "project-overview", title: "Initiative", paramsJson: '{"threadId":"coordinator"}' },
      ],
    }],
  ]);
  f.harness.sdk.stub("plugins.list", async () => ({
    plugins: state.legacy ? [{ id: "projects", ...state.legacy }] : [],
  }) as never);
  f.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId, pluginId }: { threadId: string; pluginId: string }) =>
    ({ ...(namespaces.get(pluginId)?.get(threadId) ?? {}) }) as never);
  f.harness.sdk.stub("threads.updatePluginMetadata", async ({ threadId, pluginId, set, remove }: any) => {
    const ns = namespaces.get(pluginId) ?? new Map();
    namespaces.set(pluginId, ns);
    const next = { ...(ns.get(threadId) ?? {}), ...(set ?? {}) };
    for (const key of remove ?? []) delete next[key];
    ns.set(threadId, next);
    return next as never;
  });
  f.harness.sdk.stub("threads.tabs.get", async ({ threadId }: { threadId: string }) =>
    (tabs.get(threadId) ?? { revision: 0, tabs: [] }) as never);
  f.harness.sdk.stub("threads.tabs.update", async ({ threadId, expectedRevision, tabs: next }: any) => {
    const current = tabs.get(threadId) ?? { revision: 0, tabs: [] };
    if (current.revision !== expectedRevision) throw Object.assign(new Error("stale"), { status: 409 });
    tabs.set(threadId, { revision: current.revision + 1, tabs: next });
    return tabs.get(threadId) as never;
  });
  const cli = (...argv: string[]) => f.harness.runCli(argv);
  const json = async (...argv: string[]) => {
    const result = await cli(...argv);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  };
  return { f, state, namespaces, tabs, cli, json };
}

const customProfiles = JSON.stringify({ ...DEFAULT_PROFILES, coordinator: { ...DEFAULT_PROFILES.coordinator, reasoningLevel: "xhigh" } }, null, 2);
function savedSettings(dir: string) {
  const path = join(dir, "projects-settings.json");
  writeFileSync(path, JSON.stringify({
    ok: true,
    schema: Object.fromEntries(Object.entries(settingsDescriptors).map(([key, d]) => [key, { type: d.type, label: d.label, default: d.default }])),
    values: {
      coordinatorInstructions: settingsDescriptors.coordinatorInstructions.default,
      workerInstructions: settingsDescriptors.workerInstructions.default,
      executionProfiles: customProfiles,
    },
  }));
  return path;
}

describe("T100 one-time import from the former projects ID", () => {
  it("an empty install beside a former ledger refuses every entry point and writes nothing", async () => {
    const former = await formerLedger();
    const { f, cli, json } = install(former);
    expect((await json("migrate", "status")).state).toBe("awaiting-import");
    const list = await cli("list");
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain("one-time import");
    await expect(f.harness.callRpc("tree", null)).rejects.toThrow(/one-time import/);
    await expect(f.harness.callRpc("membership", { threadId: "coordinator" })).rejects.toThrow(/one-time import/);
    const context = await f.harness.fetchHttp("GET", "/context/v1/thread?threadId=coordinator");
    expect(context.status).toBe(503);
    expect(await context.json()).not.toHaveProperty("version");
    await expect(f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" })).rejects.toThrow(/one-time import/);
    await expect(
      f.harness.callAgentTool("initiative_create", { action: "create", name: "Fresh", objective: "Would start empty", memberProjectIds: ["proj_a"], coordinator: { kind: "adopt", threadId: "coordinator" } }, { threadId: "coordinator" }),
    ).rejects.toThrow(/one-time import/);
    await expect(f.harness.callAgentTool("project_read", {}, { threadId: "coordinator" })).rejects.toThrow(/one-time import/);
    expect(f.store.projects()).toEqual([]);
  });

  it("refuses while the former plugin is enabled, not cleanly disabled, or its database is still open", async () => {
    const former = await formerLedger();
    const settings = savedSettings(former.dataDir);
    const { f, state, cli } = install(former, { enabled: true, status: "running" });
    const enabled = await cli("migrate", "import", "--settings", settings);
    expect(enabled.exitCode).toBe(1);
    expect(enabled.stderr).toMatch(/must be disabled before importing/);
    state.legacy = { enabled: false, status: "degraded" };
    expect((await cli("migrate", "import", "--settings", settings)).stderr).toMatch(/status degraded/);
    state.legacy = { enabled: false, status: "disabled" };
    writeFileSync(`${former.path}-wal`, "x");
    expect((await cli("migrate", "import", "--settings", settings)).stderr).toMatch(/not empty/);
    expect((await cli("migrate", "import")).stderr).toMatch(/--settings <file>/);
    expect(f.store.projects()).toEqual([]);
  });

  it("refuses unsettled native operations, lists them, and imports nothing", async () => {
    const former = await formerLedger();
    const db = new Database(former.path);
    db.prepare("UPDATE assignments SET op_state = 'uncertain' WHERE num = 1").run();
    db.prepare("UPDATE coordinator_starts SET state = 'pending'").run();
    db.close();
    const { f, cli, json } = install(former);
    const refused = await cli("migrate", "import", "--no-settings");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`${former.project.id} A1: operation`);
    expect(refused.stderr).toContain("uncertain");
    expect(f.store.projects()).toEqual([]);
    expect((await json("migrate", "status")).state).toBe("awaiting-import");
  });

  it("imports every row from a byte-identical copy, copies customized settings, metadata and tabs, then opens", async () => {
    const former = await formerLedger();
    const before = sha256(former.path);
    const settings = savedSettings(former.dataDir);
    const { f, namespaces, tabs, cli, json } = install(former);
    const result = await json("migrate", "import", "--settings", settings);
    expect(result.state).toBe("complete");
    expect(result.open).toEqual([]);
    // The former file was never written; the backup is its exact copy.
    expect(sha256(former.path)).toBe(before);
    const status = await json("migrate", "status");
    expect(status.gate).toBeNull();
    expect(status.report.backup.sha256).toBe(before);
    expect(status.report.settings).toMatchObject({ plan: { executionProfiles: customProfiles }, applied: true });
    // An independent check of the live ledger against the backup.
    const check = new Database(status.report.backup.path, { readonly: true });
    check.prepare("ATTACH DATABASE ? AS imported").run(f.store.db.name);
    expect(verifyCopy(check, "main", "imported").ok).toBe(true);
    check.close();
    expect((await f.preferences.handle.get()).executionProfiles).toBe(customProfiles);
    for (const [threadId, meta] of former.metadata) expect(namespaces.get("initiatives")!.get(threadId)).toEqual(meta);
    expect(tabs.get("coordinator")!.tabs).toEqual([
      { id: "info", kind: "thread-info" },
      { id: "panel", kind: "plugin-panel", pluginId: "initiatives", actionId: "initiative-overview", title: "Initiative", paramsJson: '{"threadId":"coordinator"}' },
    ]);
    // Open: the imported Initiative serves its coordinator and the CLI.
    expect((await json("list")).map((p: { id: string }) => p.id)).toEqual([former.project.id]);
    const read = JSON.parse((await f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" })) as string);
    expect(read.project?.id ?? read.id ?? JSON.stringify(read)).toContain(former.project.id);
    // Idempotent.
    expect((await json("migrate", "import", "--settings", settings)).note).toMatch(/Already imported/);
  });

  it("a metadata conflict is left for a person and keeps the gate closed until resolved", async () => {
    const former = await formerLedger();
    const { namespaces, cli, json } = install(former);
    namespaces.get("initiatives")!.set(former.worker, { projectId: "prj_other" });
    const result = await cli("migrate", "import", "--no-settings");
    expect(result.exitCode).toBe(1);
    const first = JSON.parse(result.stdout);
    expect(first.state).toBe("db-imported");
    expect(first.open).toEqual([expect.objectContaining({ threadId: former.worker, state: "conflict" })]);
    expect((await cli("list")).stderr).toMatch(/finishing its one-time import/);
    const second = await json("migrate", "import", "--no-settings", "--overwrite-conflicts");
    expect(second, JSON.stringify(second)).toMatchObject({ state: "complete" });
    expect(namespaces.get("initiatives")!.get(former.worker)).toEqual(former.metadata.get(former.worker));
  });

  it("pauses everything, sweep included, when the former plugin is enabled again after the import", async () => {
    const former = await formerLedger();
    const { f, state, cli, json } = install(former);
    await json("migrate", "import", "--no-settings");
    state.legacy = { enabled: true, status: "running" };
    const sweep = vi.spyOn(f.runtime, "sweep");
    const service = f.harness.runService("initiatives-sweep");
    await vi.waitFor(async () => expect((await json("migrate", "status")).gate).toMatch(/still enabled/));
    service.controller.abort();
    await service.done;
    expect(sweep).not.toHaveBeenCalled();
    expect((await cli("list")).stderr).toMatch(/still enabled/);
    await expect(f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" })).rejects.toThrow(/still enabled/);
  });

  it("the rollback export keeps writes made after the import and pauses this install", async () => {
    const former = await formerLedger();
    const { f, namespaces, tabs, cli, json } = install(former);
    await json("migrate", "import", "--no-settings");
    const later = f.service.recordDecision(former.project.id, { decision: { description: "Written after the import.", madeBy: "agent" } }, coordinator);
    namespaces.get("initiatives")!.set(former.worker, { ...namespaces.get("initiatives")!.get(former.worker), v: 99 });
    const exported = await json("migrate", "export");
    expect(exported.state).toBe("exported");
    expect((await cli("list")).stderr).toMatch(/handed its ledger back/);
    expect(namespaces.get("projects")!.get(former.worker)).toMatchObject({ v: 99 });
    expect(tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "projects", actionId: "project-overview" });
    // scripts/ledger.ts restore: replace the former rows with this plugin's ledger, verified.
    const legacy = new Database(former.path);
    legacy.prepare("ATTACH DATABASE ? AS src").run(f.store.db.name);
    expect(handBackProblem(legacy, "src")).toBeNull();
    expect(schemaDifferences(legacy, "src", "main")).toEqual([]);
    expect(unsettledOperations(legacy, "src")).toEqual([]);
    legacy.transaction(() => {
      copyRows(legacy, "src", "main", "replace");
      expect(verifyCopy(legacy, "src", "main").ok).toBe(true);
    })();
    expect(legacy.prepare("SELECT count(*) AS n FROM knowledge WHERE project_id = ? AND num = ?").get(former.project.id, later.num)).toEqual({ n: 1 });
    legacy.exec("DETACH DATABASE src");
    legacy.close();
    // A rollback abandoned before Projects did any work reopens this install, tabs included.
    expect((await json("migrate", "resume", "--no-settings")).state).toBe("complete");
    expect(tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "initiatives", actionId: "initiative-overview" });
    expect((await cli("list")).exitCode).toBe(0);
  });

  it("a fresh BB without a former ledger starts open, and start-fresh is explicit beside one", async () => {
    const open = fixture();
    expect((await open.harness.runCli(["list"])).exitCode).toBe(0);
    const former = await formerLedger();
    const { cli, json } = install(former, null);
    expect((await cli("list")).exitCode).toBe(1);
    expect((await json("migrate", "start-fresh")).state).toBe("fresh");
    expect((await cli("list")).exitCode).toBe(0);
    expect((await cli("migrate", "import", "--no-settings")).stderr).toMatch(/never imports on top/);
    expect(existsSync(former.path)).toBe(true);
  });
});

describe("T100 ledger copy and verification", () => {
  it("keeps rowids with gaps and AUTOINCREMENT counters, and names every kind of difference", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-copy-"));
    const a = new Database(join(dir, "a.db"));
    const b = new Database(join(dir, "b.db"));
    applyMigrations(a, MIGRATIONS);
    applyMigrations(b, MIGRATIONS);
    a.close();
    b.close();
    const db = new Database(join(dir, "a.db"));
    db.prepare("ATTACH DATABASE ? AS b").run(join(dir, "b.db"));
    db.exec(`INSERT INTO activity (project_id, at, kind, summary) VALUES ('prj_a', 1, 'k', 'one'), ('prj_a', 2, 'k', 'two'), ('prj_a', 3, 'k', 'three');
      DELETE FROM activity WHERE summary = 'two';
      INSERT INTO usage_turn_cursors (thread_id, project_id, last_seq, first_observed_at, last_observed_at) VALUES ('t1', 'prj_a', 5, 1, 2), ('t2', 'prj_a', 6, 1, 2);
      DELETE FROM usage_turn_cursors WHERE thread_id = 't1';`);
    expect(schemaDifferences(db, "main", "b")).toEqual([]);
    db.transaction(() => copyRows(db, "main", "b", "into-empty"))();
    expect(verifyCopy(db, "main", "b").ok).toBe(true);
    expect(db.prepare("SELECT rowid AS r, summary FROM b.activity ORDER BY rowid").all()).toEqual([{ r: 1, summary: "one" }, { r: 3, summary: "three" }]);
    expect(db.prepare("SELECT rowid FROM b.usage_turn_cursors").all()).toEqual(db.prepare("SELECT rowid FROM main.usage_turn_cursors").all());
    expect(() => copyRows(db, "main", "b", "into-empty")).toThrow(/not empty/);

    const failing = (mutate: string) => {
      db.exec("SAVEPOINT probe");
      db.exec(mutate);
      const check = verifyCopy(db, "main", "b");
      db.exec("ROLLBACK TO probe; RELEASE probe");
      return check.ok;
    };
    expect(failing("UPDATE b.activity SET summary = 'THREE' WHERE rowid = 3")).toBe(false);
    expect(failing("DELETE FROM b.activity WHERE rowid = 1")).toBe(false);
    expect(failing("UPDATE b.activity SET summary = CAST('three' AS BLOB) WHERE rowid = 3")).toBe(false);
    expect(failing("UPDATE b.sqlite_sequence SET seq = 99 WHERE name = 'activity'")).toBe(false);
    expect(failing("UPDATE b.usage_turn_cursors SET rowid = 7")).toBe(false);
    expect(verifyCopy(db, "main", "b").ok).toBe(true);

    db.exec("ALTER TABLE b.activity ADD COLUMN extra TEXT");
    expect(schemaDifferences(db, "main", "b")).toContain("table activity has different columns in main and b");
    db.exec("UPDATE b._bb_migrations SET statement_hash = 'x' WHERE id = 3");
    expect(schemaDifferences(db, "main", "b").join()).toMatch(/migration 3 differs/);
  });

  it("the per-table digest tells integer 1 from real 1.0, which the set comparison treats as equal", () => {
    const db = new Database(":memory:");
    db.exec("ATTACH DATABASE ':memory:' AS b; CREATE TABLE main.t (x); CREATE TABLE b.t (x); INSERT INTO main.t VALUES (1); INSERT INTO b.t VALUES (1.0);");
    const [check] = verifyCopy(db, "main", "b").tables;
    expect(check).toMatchObject({ table: "t", missing: 0, extra: 0, ok: false });
    expect(check!.sourceSha256).not.toBe(check!.targetSha256);
  });

  it("reads metadata from this plugin's namespace, falling back to the former one until it is copied", async () => {
    const calls: string[] = [];
    const sdk = {
      threads: {
        getPluginMetadata: async ({ pluginId }: { pluginId: string }) => {
          calls.push(pluginId);
          return pluginId === "projects" ? { op: "op_old" } : {};
        },
      },
    } as never;
    expect(await ownMetadata(sdk, "initiatives", "t")).toEqual({ op: "op_old" });
    expect(calls).toEqual(["initiatives", "projects"]);
    const own = { threads: { getPluginMetadata: async () => ({ op: "op_new" }) } } as never;
    expect(await ownMetadata(own, "initiatives", "t")).toEqual({ op: "op_new" });
  });
});

/** scripts/ledger.ts restore, as the runbook runs it after disabling Initiatives: replace the former rows, verified. */
function restoreInto(former: Former, ledger: string) {
  const legacy = new Database(former.path);
  legacy.prepare("ATTACH DATABASE ? AS src").run(ledger);
  try {
    expect(handBackProblem(legacy, "src")).toBeNull();
    legacy.transaction(() => {
      copyRows(legacy, "src", "main", "replace");
      expect(verifyCopy(legacy, "src", "main").ok).toBe(true);
    })();
  } finally {
    legacy.exec("DETACH DATABASE src");
    legacy.close();
  }
}

describe("A272 fixes: the hand-back and its ways back", () => {
  it("P1: export waits for an already admitted report, so the handed-back ledger has it", async () => {
    const former = await formerLedger();
    const { f, json } = install(former);
    await json("migrate", "import", "--no-settings");
    let release!: (v: any) => void;
    let entered = false;
    f.harness.sdk.stub("threads.defaultExecutionOptions", async () => {
      entered = true;
      return await new Promise((resolve) => { release = resolve; });
    });
    const later = { ...report(), summary: "Report landed while the export waited" };
    const pending = f.harness.callAgentTool("initiative_report", later, { threadId: former.worker });
    await vi.waitFor(() => expect(entered).toBe(true));
    let exportDone = false;
    const exporting = json("migrate", "export").then((r) => { exportDone = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    expect(exportDone).toBe(false);
    release({ model: "claude-opus-5-5", reasoningLevel: "high" });
    await pending;
    const exported = await exporting;
    expect(exported.finished).toBe(true);
    const snapshot = new Database(exported.snapshot.path, { readonly: true });
    const row = snapshot.prepare("SELECT report FROM assignments WHERE thread_id = ?").get(former.worker) as { report: string };
    expect(JSON.parse(row.report).summary).toBe(later.summary);
    snapshot.close();
    // A call arriving after the pause is refused, not admitted.
    await expect(f.harness.callAgentTool("initiative_read", {}, { threadId: "coordinator" })).rejects.toThrow(/handed its ledger back/);
  });

  it("P1: resume refuses once Projects worked after the hand-back; import --again brings that work forward", async () => {
    const former = await formerLedger();
    const { f, namespaces, cli, json } = install(former);
    await json("migrate", "import", "--no-settings");
    await json("migrate", "export");
    restoreInto(former, f.store.db.name);
    const old = new Database(former.path);
    old.prepare("INSERT INTO activity (project_id, at, kind, summary) VALUES (?, ?, ?, ?)").run(former.project.id, 99, "update", "Written after rollback enabled projects");
    old.close();
    namespaces.get("projects")!.set(former.worker, { ...namespaces.get("projects")!.get(former.worker), v: 7 });
    const refused = await cli("migrate", "resume", "--no-settings");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/changed after the hand-back/);
    expect((await json("migrate", "status")).state).toBe("exported");
    const again = await json("migrate", "import", "--again", "--no-settings");
    expect(again).toMatchObject({ state: "complete", finished: true });
    expect(f.store.db.prepare("SELECT count(*) AS n FROM activity WHERE summary = ?").get("Written after rollback enabled projects")).toEqual({ n: 1 });
    // The former namespace is authoritative when coming forward again.
    expect(namespaces.get("initiatives")!.get(former.worker)).toMatchObject({ v: 7 });
    expect((await json("migrate", "status")).report.ownBackup.path).toMatch(/before-reimport/);
  });

  it("P2: a failed settings write keeps the import paused, and the retry applies the saved settings", async () => {
    const former = await formerLedger();
    const settings = savedSettings(former.dataDir);
    const { f, cli, json } = install(former);
    vi.spyOn(f.preferences.handle, "experimental_set").mockRejectedValueOnce(new Error("simulated settings persistence failure"));
    const first = await cli("migrate", "import", "--settings", settings);
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain("simulated settings persistence failure");
    expect((await json("migrate", "status")).state).toBe("db-imported");
    expect((await cli("list")).exitCode).toBe(1);
    expect((await json("migrate", "import", "--settings", settings)).state).toBe("complete");
    expect((await f.preferences.handle.get()).executionProfiles).toBe(customProfiles);
  });

  it("P2: resume points tabs forward again, and abandon points an unfinished import's tabs back", async () => {
    const former = await formerLedger();
    const first = install(former);
    await first.json("migrate", "import", "--no-settings");
    await first.json("migrate", "export");
    expect(first.tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "projects", actionId: "project-overview" });
    await first.json("migrate", "resume", "--no-settings");
    expect(first.tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "initiatives", actionId: "initiative-overview" });

    const other = await formerLedger();
    const { namespaces, tabs, cli, json } = install(other);
    namespaces.get("initiatives")!.set(other.worker, { projectId: "other" });
    expect((await cli("migrate", "import", "--no-settings")).exitCode).toBe(1);
    expect(tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "initiatives" });
    expect(await json("migrate", "abandon")).toMatchObject({ state: "abandoned", finished: true });
    expect(tabs.get("coordinator")!.tabs).toEqual([
      { id: "info", kind: "thread-info" },
      { id: "panel", kind: "plugin-panel", pluginId: "projects", actionId: "project-overview", title: "Initiative", paramsJson: '{"threadId":"coordinator"}' },
    ]);
    expect((await cli("list")).stderr).toMatch(/gave up an unfinished import/);
    // Forward again later: the former ledger comes back in, tabs point forward, and it opens.
    expect(await json("migrate", "import", "--again", "--no-settings")).toMatchObject({ state: "complete", finished: true });
    expect(tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "initiatives", actionId: "initiative-overview" });
    expect((await cli("list")).exitCode).toBe(0);
  });

  it("P2: an unfinished export exits non-zero and the restore refuses it", async () => {
    const former = await formerLedger();
    const { f, cli, json } = install(former);
    await json("migrate", "import", "--no-settings");
    f.harness.sdk.stub("threads.tabs.update", async () => { throw Object.assign(new Error("simulated tab conflict"), { status: 409 }); });
    const result = await cli("migrate", "export");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "exported", finished: false, open: [expect.objectContaining({ kind: "tabs", state: "failed" })] });
    expect(result.stderr).toMatch(/Not finished/);
    expect(handBackProblem(f.store.db)).toMatch(/did not finish/);
  });

  it("P2: export saves the current settings for the former plugin", async () => {
    const former = await formerLedger();
    const { f, json } = install(former);
    await json("migrate", "import", "--no-settings");
    await f.preferences.handle.experimental_set({ executionProfiles: customProfiles });
    const exported = await json("migrate", "export");
    const saved = JSON.parse(readFileSync(exported.settings, "utf8"));
    expect(saved.values.executionProfiles).toBe(customProfiles);
    expect(saved.schema.executionProfiles.default).toBe(settingsDescriptors.executionProfiles.default);
    expect(Object.keys(saved.values).sort()).toEqual(Object.keys(settingsDescriptors).sort());
  });
});

describe("A272 fixes: restore preconditions", () => {
  it("a ledger that was never migrated or handed back is refused", () => {
    const db = new Database(":memory:");
    expect(handBackProblem(db)).toMatch(/not migrated, not exported/);
  });
});

describe("A272 fixes: settings back to the former plugin", () => {
  it("sets customized fields, unsets fields back at their default, and leaves equal ones alone", async () => {
    const { settingsSteps, settingsMismatches } = await import("../lib/migration/settings-transfer");
    const saved = {
      schema: { a: { default: "A" }, b: { default: "B" }, c: { default: "C" } },
      values: { a: "custom", b: "B", c: "C" },
    };
    const current = { a: "A", b: "old custom", c: "C" };
    expect(settingsSteps(saved, current)).toEqual([{ op: "set", key: "a", value: "custom" }, { op: "unset", key: "b" }]);
    expect(settingsMismatches(saved, current)).toEqual(["a", "b"]);
    expect(settingsMismatches(saved, { a: "custom", b: "B", c: "C" })).toEqual([]);
  });
});

describe("A275 fixes: repeated rollbacks", () => {
  const defaultsFile = (dir: string) => {
    const file = join(dir, "settings-reset.json");
    writeFileSync(file, JSON.stringify({
      schema: settingsDescriptors,
      values: Object.fromEntries(Object.entries(settingsDescriptors).map(([key, d]) => [key, d.default])),
    }));
    return file;
  };

  it("import --again reproduces saved settings that were reset to their defaults", async () => {
    const former = await formerLedger();
    const { f, json } = install(former);
    await json("migrate", "import", "--settings", savedSettings(former.dataDir));
    expect((await f.preferences.handle.get()).executionProfiles).toBe(customProfiles);
    await json("migrate", "export");
    const result = await json("migrate", "import", "--again", "--settings", defaultsFile(former.dataDir));
    expect(result).toMatchObject({ state: "complete", finished: true });
    expect((await f.preferences.handle.get()).executionProfiles).toBe(settingsDescriptors.executionProfiles.default);
  });

  it("resume applies and verifies the former plugin's current settings before reopening", async () => {
    const former = await formerLedger();
    const { f, cli, json } = install(former);
    await json("migrate", "import", "--no-settings");
    await json("migrate", "export");
    expect((await cli("migrate", "resume")).stderr).toMatch(/--settings <file>/);
    const resumed = await json("migrate", "resume", "--settings", savedSettings(former.dataDir));
    expect(resumed).toMatchObject({ state: "complete", finished: true });
    expect((await f.preferences.handle.get()).executionProfiles).toBe(customProfiles);
    // A failed settings write keeps the install paused.
    await json("migrate", "export");
    vi.spyOn(f.preferences.handle, "experimental_set").mockRejectedValueOnce(new Error("settings store unavailable"));
    const failed = await cli("migrate", "resume", "--settings", defaultsFile(former.dataDir));
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("settings store unavailable");
    expect((await json("migrate", "status")).state).toBe("exported");
  });

  it("abandon wins over an import pass already in flight, from the CLI or the sweep", async () => {
    const former = await formerLedger();
    const { f, cli, json, tabs } = install(former);
    let release!: () => void;
    let entered = false;
    const original = f.preferences.handle.experimental_set.bind(f.preferences.handle);
    vi.spyOn(f.preferences.handle, "experimental_set").mockImplementationOnce(async (patch: any) => {
      entered = true;
      await new Promise<void>((r) => { release = r; });
      return original(patch);
    });
    const importing = cli("migrate", "import", "--settings", savedSettings(former.dataDir));
    await vi.waitFor(() => expect(entered).toBe(true));
    const abandoning = json("migrate", "abandon");
    release();
    expect((await importing).exitCode).toBe(1);
    expect(await abandoning).toMatchObject({ state: "abandoned", finished: true });
    expect((await json("migrate", "status")).state).toBe("abandoned");
    expect(tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "projects", actionId: "project-overview" });

    // The sweep's retry, held in its thread scan, does not reopen the plugin either.
    const other = await formerLedger();
    const second = install(other);
    vi.spyOn(second.f.preferences.handle, "experimental_set").mockRejectedValueOnce(new Error("first settings failure"));
    expect((await second.cli("migrate", "import", "--settings", savedSettings(other.dataDir))).exitCode).toBe(1);
    let held = false;
    let resume!: () => void;
    second.f.harness.sdk.stub("threads.list", async (args: any) => {
      if (!held) { held = true; await new Promise<void>((r) => { resume = r; }); }
      return [...second.f.threads.values()]
        .filter((t) => !args.originPluginId || t.originPluginId === args.originPluginId)
        .filter((t) => Boolean(t.archivedAt) === Boolean(args.archived))
        .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200)) as never;
    });
    const sweep = second.f.harness.runService("initiatives-sweep");
    await vi.waitFor(() => expect(held).toBe(true));
    const abandon = second.json("migrate", "abandon");
    resume();
    expect(await abandon).toMatchObject({ state: "abandoned", finished: true });
    sweep.controller.abort();
    await sweep.done;
    expect((await second.json("migrate", "status")).state).toBe("abandoned");
    expect(second.tabs.get("coordinator")!.tabs[1]).toMatchObject({ pluginId: "projects" });
  });

  it("a second export that fails withdraws the first export's restore authorization", async () => {
    const former = await formerLedger();
    const { f, cli, json } = install(former);
    await json("migrate", "import", "--no-settings");
    await json("migrate", "export");
    expect(handBackProblem(f.store.db)).toBeNull();
    await json("migrate", "resume", "--no-settings");
    vi.spyOn(f.preferences.handle, "get").mockRejectedValueOnce(new Error("second export settings read failed"));
    const second = await cli("migrate", "export");
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("second export settings read failed");
    expect((await json("migrate", "status")).state).toBe("exported");
    expect(handBackProblem(f.store.db)).toMatch(/did not finish/);
  });
});
