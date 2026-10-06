import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ProjectError, errorMessage } from "../bb";
import { LEGACY_PLUGIN_ID } from "../identity";
import { settingsDescriptors, type PreferencesReader } from "../settings";
import {
  copyRows,
  dataTables,
  describeVerification,
  integrity,
  rowCounts,
  schemaDifferences,
  unsettledOperations,
  verifyCopy,
  type CopyVerification,
  type UnsettledOperation,
} from "./sqlite";

// The one-time move from the former `projects` plugin ID, and the way back.
//
// Lifecycle of this install's ledger, stored in `_initiatives_migration`:
//   (no row, former ledger on disk)  awaiting import: every entry point refuses
//   db-imported   rows copied and verified; settings, thread metadata and tabs still moving
//   complete      imported, settings applied and every thread moved: open
//   fresh         started without a former ledger: open
//   exported      handed back to `projects` for a rollback: refuses until resumed
//   abandoned     an unfinished import given up, tabs pointed back: refuses
// Independently, the plugin refuses everything while the former plugin is
// enabled, so the two never run the same Initiatives at once.

type Db = Database.Database;
type Sdk = BbPluginApi["sdk"];
type State = "db-imported" | "complete" | "fresh" | "exported" | "abandoned";
/** A pass over threads: which namespace and tabs move, and from which plugin to which. */
type Direction = "import" | "export" | "resume" | "abandon";

/** Thread panels this plugin registered under its former ID, by current ID. */
const PANEL_IDS: Record<string, string> = { "project-overview": "initiative-overview" };
const SETTLED_TIMEOUT_MS = 60_000;

interface MigrationRow {
  state: State;
  report: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface LegacyInstall {
  installed: boolean;
  enabled: boolean;
  status: string | null;
  checkedAt: number;
}

interface ThreadMove {
  threadId: string;
  kind: "metadata" | "tabs" | "settings";
  state: "copied" | "none" | "gone" | "conflict" | "failed";
  detail: string | null;
}

/**
 * Saved settings to reproduce exactly: `plan` is the write (null resets a
 * field to its default) and `expected` the effective values to read back.
 */
interface SettingsPhase {
  file: string | null;
  plan: Record<string, string | null>;
  expected: Record<string, string>;
  applied: boolean;
  error?: string;
}

export interface MigrationPaths {
  /** The former plugin's data.db, or null when BB's data directory cannot be read. */
  legacyDatabase: () => string | null;
  /** Where import backups and rollback exports go by default. */
  backupDir: () => string | null;
}

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const stamp = (now: number) => new Date(now).toISOString().replace(/[:.]/g, "-");
const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

export function defaultMigrationPaths(bb: BbPluginApi, db: Db): MigrationPaths {
  return {
    legacyDatabase: () => {
      try {
        const root = bb.server.experimental_dataDir;
        return root ? join(root, "plugins", LEGACY_PLUGIN_ID, "data.db") : null;
      } catch {
        return null;
      }
    },
    backupDir: () => (isAbsolute(db.name) ? join(dirname(db.name), "migration") : null),
  };
}

export class LegacyMigration {
  private legacy: LegacyInstall | null = null;
  private cached: MigrationRow | null = null;
  /** Thread-level work runs one pass at a time. */
  private moving: Promise<unknown> | null = null;
  /** Migration operations (import, its retries, abandon, export, resume) run one at a time. */
  private lock: Promise<unknown> = Promise.resolve();
  /** Set while abandon waits or runs: an import pass in flight must not complete. */
  private abandonRequested = false;

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  constructor(
    private readonly bb: BbPluginApi,
    private readonly db: Db,
    private readonly preferences: PreferencesReader,
    private readonly paths: MigrationPaths,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS _initiatives_migration (
      id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, report TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS _initiatives_migration_threads (
      direction TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      before TEXT, detail TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (direction, thread_id, kind))`);
    // Decide a missing state now when BB's data directory is readable, so
    // the first sweep or call does not write it.
    this.row();
  }

  /**
   * The stored state; without one, decide it. A ledger that already holds
   * Initiatives, or a BB without a former ledger, starts open. An empty
   * ledger beside a former one waits for the import, and an unreadable data
   * directory waits too (re-checked on every call): it never starts empty.
   */
  private row(): MigrationRow | null {
    if (this.cached) return this.cached;
    const row = this.db.prepare("SELECT state, report, created_at, updated_at FROM _initiatives_migration WHERE id = 1").get() as
      | { state: State; report: string; created_at: number; updated_at: number }
      | undefined;
    if (row) return (this.cached = { state: row.state, report: JSON.parse(row.report), createdAt: row.created_at, updatedAt: row.updated_at });
    const legacy = this.paths.legacyDatabase();
    if (!this.ledgerEmpty()) this.write("fresh", { reason: "ledger already populated" });
    else if (legacy !== null && !existsSync(legacy)) this.write("fresh", { reason: "no former ledger" });
    else return null;
    return this.row();
  }

  private write(state: State, report: Record<string, unknown>) {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO _initiatives_migration (id, state, report, created_at, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, report = excluded.report, updated_at = excluded.updated_at`,
      )
      .run(state, JSON.stringify(report), now, now);
    // A write inside a transaction that later rolls back must not linger.
    this.cached = null;
  }

  private note(extra: Record<string, unknown>) {
    const row = this.row();
    if (row) this.write(row.state, { ...row.report, ...extra });
  }

  private ledgerEmpty(schema = "main") {
    return Object.values(rowCounts(this.db, schema)).every((n) => n === 0);
  }

  /**
   * Why every Initiative entry point must refuse right now, or null when
   * open. Synchronous: the former plugin's install state is the cached
   * result of the last `refreshLegacy`, which the sweep renews before every
   * pass and every migration command renews before acting.
   */
  gate(): string | null {
    if (this.legacy?.enabled)
      return `Initiatives is paused because the former Projects plugin is still enabled (status ${this.legacy.status ?? "unknown"}). Only one of them may own the Initiative ledger. Ask the user to disable it: bb plugin disable ${LEGACY_PLUGIN_ID}.`;
    const row = this.row();
    if (!row)
      return this.paths.legacyDatabase() === null
        ? "Initiatives is paused: it could not read BB's data directory to look for the former Projects ledger, so it will not start empty. Ask the user to check bb initiative migrate status."
        : "Initiatives is waiting for its one-time import from the former Projects plugin. Nothing is lost; ask the user to finish the migration (bb initiative migrate status).";
    if (row.state === "db-imported")
      return "Initiatives is finishing its one-time import (settings, thread metadata and tabs). Retry in a minute; bb initiative migrate status shows progress.";
    if (row.state === "exported")
      return "This Initiatives install handed its ledger back to the former Projects plugin for a rollback and stays paused. With Projects disabled again, bb initiative migrate resume reopens it unchanged, or migrate import --again brings Projects' later work forward.";
    if (row.state === "abandoned")
      return "This Initiatives install gave up an unfinished import and stays paused; the former Projects plugin owns the Initiatives.";
    return null;
  }

  async refreshLegacy(): Promise<LegacyInstall> {
    const plugins = (await this.bb.sdk.plugins.list()).plugins as { id: string; enabled?: boolean; status?: string }[];
    const row = plugins.find((p) => p.id === LEGACY_PLUGIN_ID);
    this.legacy = {
      installed: row !== undefined,
      enabled: row?.enabled === true,
      status: row?.status ?? null,
      checkedAt: this.now(),
    };
    return this.legacy;
  }

  async status() {
    let legacy: LegacyInstall | { error: string };
    try {
      legacy = await this.refreshLegacy();
    } catch (error) {
      legacy = { error: errorMessage(error) };
    }
    const row = this.row();
    const path = this.paths.legacyDatabase();
    const threads = this.db
      .prepare("SELECT direction, kind, state, count(*) AS n FROM _initiatives_migration_threads GROUP BY 1, 2, 3 ORDER BY 1, 2, 3")
      .all();
    return {
      state: row?.state ?? (path === null ? "unknown" : "awaiting-import"),
      gate: this.gate(),
      formerPlugin: legacy,
      formerLedger: path === null ? null : { path, exists: existsSync(path) },
      ledgerRows: rowCounts(this.db, "main"),
      threads,
      report: row?.report ?? null,
      since: row?.updatedAt ?? null,
    };
  }

  /** The former plugin must be installed-and-disabled (or gone) with its database closed. */
  private async requireLegacyClosed(action: string) {
    const legacy = await this.refreshLegacy();
    if (legacy.enabled || (legacy.installed && legacy.status !== "disabled"))
      throw new ProjectError(
        `The former plugin must be disabled before ${action} (now ${legacy.enabled ? "enabled" : "not enabled"}, status ${legacy.status ?? "unknown"}). Run bb plugin disable ${LEGACY_PLUGIN_ID} and wait until bb plugin list shows it disabled with no hung service.`,
      );
    const source = this.paths.legacyDatabase();
    if (source === null || !existsSync(source)) throw new ProjectError(`No former ledger found${source ? ` at ${source}` : ""}.`);
    const wal = `${source}-wal`;
    if (existsSync(wal) && statSync(wal).size > 0)
      throw new ProjectError(
        `${wal} is not empty: something still has the former database open, or it was not closed cleanly. Disable the former plugin, close any other reader, and check again.`,
      );
    return source;
  }

  /** A byte-identical copy of the former ledger; the original is never opened. */
  private copyLegacy(source: string, backupDir: string, label: string) {
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${LEGACY_PLUGIN_ID}-${label}-${stamp(this.now())}.db`);
    const sourceSha256 = sha256File(source);
    copyFileSync(source, backup);
    const sha256 = sha256File(backup);
    if (sha256 !== sourceSha256) throw new ProjectError("The copy of the former ledger does not match the original; nothing changed.");
    return { path: backup, sha256, bytes: statSync(backup).size };
  }

  private backupDirOf(given?: string) {
    const dir = given ?? this.paths.backupDir();
    if (!dir) throw new ProjectError("Pass --backup-dir <directory> for the migration's copies.");
    return dir;
  }

  /**
   * Copy the former ledger into this one, then apply settings and move thread
   * metadata and tabs. Never opens the former database file: it is copied
   * byte for byte while the former plugin is disabled (BB has closed it), and
   * every read and the verification use that copy. Idempotent: a finished
   * import returns its report, a partial one resumes where it stopped.
   *
   * `again` brings the former ledger forward once more after a rollback that
   * let Projects work: it replaces this ledger's rows (backed up first) and
   * treats the former plugin's thread metadata as authoritative.
   */
  importLegacy(
    options: { settings: string | null; backupDir?: string; overwrite?: boolean; again?: boolean },
    signal?: AbortSignal,
  ) {
    return this.exclusive(() => this.importOnce(options, signal));
  }

  private async importOnce(
    options: { settings: string | null; backupDir?: string; overwrite?: boolean; again?: boolean },
    signal?: AbortSignal,
  ) {
    const row = this.row();
    if (row?.state === "complete" && !options.again) return { state: "complete", note: "Already imported; nothing changed.", report: row.report, finished: true, open: [] };
    if (row?.state === "fresh")
      throw new ProjectError("This install started without a former ledger and may already hold its own Initiatives; it never imports on top of them.");
    if ((row?.state === "exported" || row?.state === "abandoned") && !options.again)
      throw new ProjectError(
        `This install is ${row.state}. Use bb initiative migrate resume to reopen it unchanged, or migrate import --again to bring the former ledger forward (its current rows replace these).`,
      );
    if (options.again && row?.state !== "exported" && row?.state !== "abandoned")
      throw new ProjectError(`import --again only follows a hand-back or an abandoned import (state ${row?.state ?? "awaiting-import"}).`);
    if (row?.state === "db-imported") {
      const legacy = await this.refreshLegacy();
      if (legacy.enabled) throw new ProjectError(`Disable the former plugin again before finishing the import: bb plugin disable ${LEGACY_PLUGIN_ID}.`);
      return this.finishImport(signal, options.overwrite);
    }

    const source = await this.requireLegacyClosed("importing");
    if (!options.again && !this.ledgerEmpty())
      throw new ProjectError("This install's ledger is not empty; the import only fills an empty one.");
    const settings = this.settingsPhase(options.settings);
    const backupDir = this.backupDirOf(options.backupDir);
    let ownBackup: { path: string; sha256: string } | null = null;
    if (options.again) {
      mkdirSync(backupDir, { recursive: true });
      const path = join(backupDir, `${this.bb.pluginId}-before-reimport-${stamp(this.now())}.db`);
      await this.db.backup(path);
      ownBackup = { path, sha256: sha256File(path) };
    }
    // The copy is the import's source of truth and its rollback anchor.
    const backup = this.copyLegacy(source, backupDir, "data");

    this.db.prepare("ATTACH DATABASE ? AS legacy").run(backup.path);
    try {
      const health = integrity(this.db, "legacy");
      if (health !== "ok") throw new ProjectError(`The former ledger copy fails its integrity check: ${health}`);
      const differences = schemaDifferences(this.db, "legacy", "main");
      if (differences.length)
        throw new ProjectError(`The former ledger's schema differs from this plugin's: ${differences.join("; ")}. Nothing was imported.`);
      const unsettled = unsettledOperations(this.db, "legacy");
      if (unsettled.length) throw new ProjectError(unsettledMessage(unsettled));
      const activeWork = activeAssignments(this.db, "legacy");
      let verification: CopyVerification | undefined;
      this.db.transaction(() => {
        copyRows(this.db, "legacy", "main", options.again ? "replace" : "into-empty");
        verification = verifyCopy(this.db, "legacy", "main");
        if (!verification.ok)
          throw new ProjectError(`Verification failed; nothing was imported.\n${describeVerification(verification).join("\n")}`);
        // A new pass over threads starts clean; the former namespace is
        // authoritative when coming forward again.
        this.db.prepare("DELETE FROM _initiatives_migration_threads WHERE direction = 'import'").run();
        this.write("db-imported", {
          direction: "import",
          from: LEGACY_PLUGIN_ID,
          again: options.again === true,
          overwriteMetadata: options.again === true,
          previous: options.again ? row?.report ?? null : undefined,
          ownBackup,
          backup,
          rows: Object.fromEntries(verification.tables.map((t) => [t.table, t.targetRows])),
          verification: describeVerification(verification),
          activeWork,
          settings: { ...settings, applied: !Object.keys(settings.plan).length } satisfies SettingsPhase,
          importedAt: this.now(),
        });
      })();
    } finally {
      this.db.exec("DETACH DATABASE legacy");
    }
    return this.finishImport(signal, options.overwrite);
  }

  /**
   * After the rows: apply the saved settings and verify them, then move
   * threads; only then is the import complete and the gate open. A failed
   * settings write leaves the import paused and is retried by the next
   * import call or sweep.
   */
  private async finishImport(signal?: AbortSignal, overwrite?: boolean) {
    await this.applySettings();
    if (this.abandonRequested)
      return { state: this.row()?.state, threads: [], open: [{ threadId: "-", kind: "settings" as const, state: "failed" as const, detail: "the import is being abandoned" }], finished: false };
    const report = this.row()?.report ?? {};
    const moved = await this.moveThreads("import", signal, overwrite === true || report.overwriteMetadata === true);
    const settings = this.row()?.report.settings as SettingsPhase | undefined;
    const open = [...moved.open];
    if (settings && !settings.applied)
      open.unshift({ threadId: "-", kind: "settings", state: "failed", detail: settings.error ?? "settings not applied" });
    // An abandon that arrived meanwhile wins: this pass never reopens the plugin.
    if (this.abandonRequested || this.row()?.state !== "db-imported")
      open.push({ threadId: "-", kind: "settings", state: "failed", detail: "the import was abandoned meanwhile" });
    const finished = moved.finished && open.length === 0;
    if (finished) this.write("complete", { ...(this.row()?.report ?? {}), threads: moved.threads, completedAt: this.now() });
    return { state: this.row()?.state, threads: moved.threads, open, finished };
  }

  private async applySettings() {
    const phase = this.row()?.report.settings as SettingsPhase | undefined;
    if (!phase || phase.applied) return;
    this.note({ settings: await this.writeSettings(phase) });
  }

  /** Write a saved plan and read every saved field back; the phase records the outcome. */
  private async writeSettings(phase: SettingsPhase): Promise<SettingsPhase> {
    try {
      if (Object.keys(phase.plan).length) await this.preferences.handle.experimental_set(phase.plan as never);
      const applied = (await this.preferences.handle.get()) as Record<string, unknown>;
      const wrong = Object.keys(phase.expected).filter((key) => applied[key] !== phase.expected[key]);
      return wrong.length
        ? { ...phase, applied: false, error: `read back differently: ${wrong.join(", ")}` }
        : { ...phase, applied: true, error: undefined };
    } catch (error) {
      return { ...phase, applied: false, error: errorMessage(error) };
    }
  }

  /**
   * The former plugin's effective settings, from `bb plugin config projects
   * --json` saved while it ran. Every saved field is reproduced: a value at
   * its default resets the field (a retained install may hold an older
   * customization), anything else is set.
   */
  private settingsPhase(file: string | null): SettingsPhase {
    if (file === null) return { file, plan: {}, expected: {}, applied: true };
    let parsed: { schema?: Record<string, { default?: unknown }>; values?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new ProjectError(`Could not read the saved settings ${file}: ${errorMessage(error)}`);
    }
    if (!parsed.values || !parsed.schema)
      throw new ProjectError(`${file} is not the output of bb plugin config ${LEGACY_PLUGIN_ID} --json.`);
    const plan: Record<string, string | null> = {};
    const expected: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.values)) {
      if (!(key in settingsDescriptors))
        throw new ProjectError(`The saved settings carry an unknown field ${key}; nothing was imported.`);
      if (typeof value !== "string") throw new ProjectError(`The saved setting ${key} is not text.`);
      plan[key] = value === parsed.schema[key]?.default ? null : value;
      expected[key] = value;
    }
    return { file, plan, expected, applied: false };
  }

  /** Resume an interrupted import from the sweep; no-op when nothing is pending. */
  async continuePending(signal?: AbortSignal) {
    if (this.abandonRequested || this.row()?.state !== "db-imported") return;
    await this.exclusive(async () => {
      if (!this.abandonRequested && this.row()?.state === "db-imported") await this.finishImport(signal);
    });
  }

  /**
   * Copy each Initiative thread's metadata into the other namespace and point
   * plugin-panel tabs at the other ID. Resumable: finished threads are
   * skipped and failures are retried on the next pass. A namespace that
   * already differs is a conflict left for a person, except where `overwrite`
   * says the source is authoritative. `resume` and `abandon` move tabs only.
   */
  private async moveThreads(direction: Direction, signal?: AbortSignal, overwrite = false) {
    if (this.moving) await this.moving.catch(() => undefined);
    const run = this.moveThreadsOnce(direction, signal, overwrite);
    this.moving = run;
    try {
      return await run;
    } finally {
      if (this.moving === run) this.moving = null;
    }
  }

  private async moveThreadsOnce(direction: Direction, signal: AbortSignal | undefined, overwrite: boolean) {
    const sdk = this.bb.sdk as Sdk;
    const forward = direction === "import" || direction === "resume";
    const [from, to] = forward ? [LEGACY_PLUGIN_ID, this.bb.pluginId] : [this.bb.pluginId, LEGACY_PLUGIN_ID];
    const done = new Set(
      (
        this.db
          .prepare(
            "SELECT thread_id || ':' || kind AS key FROM _initiatives_migration_threads WHERE direction = ? AND state IN ('copied', 'none', 'gone')",
          )
          .all(direction) as { key: string }[]
      ).map((r) => r.key),
    );
    const record = (move: ThreadMove, before: unknown = null) =>
      this.db
        .prepare(
          `INSERT INTO _initiatives_migration_threads (direction, thread_id, kind, state, before, detail, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(direction, thread_id, kind) DO UPDATE SET state = excluded.state,
             before = COALESCE(_initiatives_migration_threads.before, excluded.before), detail = excluded.detail, updated_at = excluded.updated_at`,
        )
        .run(direction, move.threadId, move.kind, move.state, before === null ? null : JSON.stringify(before), move.detail, this.now());

    if (direction === "import" || direction === "export")
      for (const threadId of await this.initiativeThreads(sdk, from)) {
        if (signal?.aborted) break;
        if (done.has(`${threadId}:metadata`)) continue;
        try {
          const source = await sdk.threads.getPluginMetadata({ threadId, pluginId: from });
          if (!Object.keys(source).length) {
            record({ threadId, kind: "metadata", state: "none", detail: null });
            continue;
          }
          const target = await sdk.threads.getPluginMetadata({ threadId, pluginId: to });
          // Export overwrites: the current plugin's namespace is authoritative
          // and the former one is only a stale pre-import copy. The import
          // overwrites when coming forward again after a rollback, or when a
          // person read the conflict and asked for it.
          if (Object.keys(target).length && !sameJson(source, target) && direction === "import" && !overwrite) {
            record({ threadId, kind: "metadata", state: "conflict", detail: JSON.stringify({ [from]: source, [to]: target }) });
            continue;
          }
          if (!sameJson(source, target)) {
            const removed = Object.keys(target).filter((key) => !(key in source));
            await sdk.threads.updatePluginMetadata({ threadId, pluginId: to, set: source as never, ...(removed.length ? { remove: removed } : {}) });
          }
          const check = await sdk.threads.getPluginMetadata({ threadId, pluginId: to });
          record(
            sameJson(source, check)
              ? { threadId, kind: "metadata", state: "copied", detail: null }
              : { threadId, kind: "metadata", state: "failed", detail: "the copy reads back differently" },
            target,
          );
        } catch (error) {
          const gone = (error as { status?: number }).status === 404;
          record({ threadId, kind: "metadata", state: gone ? "gone" : "failed", detail: gone ? null : errorMessage(error) });
        }
      }
    if (!signal?.aborted) await this.moveTabs(sdk, forward, from, to, done, record, signal);

    const counts = this.db
      .prepare("SELECT kind, state, count(*) AS n FROM _initiatives_migration_threads WHERE direction = ? GROUP BY 1, 2")
      .all(direction) as { kind: string; state: string; n: number }[];
    const open = this.db
      .prepare(
        "SELECT thread_id AS threadId, kind, state, detail FROM _initiatives_migration_threads WHERE direction = ? AND state IN ('conflict', 'failed') ORDER BY thread_id",
      )
      .all(direction) as ThreadMove[];
    return { threads: counts, open, finished: !signal?.aborted && open.length === 0 };
  }

  /**
   * Every thread that may carry the source namespace: each thread the ledger
   * names, plus every thread the source plugin created, archived or not.
   */
  private async initiativeThreads(sdk: Sdk, from: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const name of dataTables(this.db, "main"))
      for (const column of (this.db.prepare(`PRAGMA main.table_info("${name}")`).all() as { name: string }[])
        .map((c) => c.name)
        .filter((c) => c === "thread_id" || c.endsWith("_thread_id")))
        for (const row of this.db.prepare(`SELECT DISTINCT "${column}" AS id FROM main."${name}" WHERE "${column}" IS NOT NULL`).all() as { id: string }[])
          ids.add(row.id);
    for (const archived of [false, true])
      for (let offset = 0; ; offset += 200) {
        const rows = await sdk.threads.list({ originPluginId: from, archived, includeHidden: true, limit: 200, offset });
        for (const row of rows) ids.add(row.id);
        if (rows.length < 200) break;
      }
    return [...ids].sort();
  }

  /** Point every plugin-panel tab of one plugin at the other, keeping unrelated tabs and checking revisions. */
  private async moveTabs(
    sdk: Sdk,
    forward: boolean,
    from: string,
    to: string,
    done: Set<string>,
    record: (move: ThreadMove, before?: unknown) => unknown,
    signal?: AbortSignal,
  ) {
    const panel = (actionId: string) =>
      forward
        ? (PANEL_IDS[actionId] ?? actionId)
        : (Object.entries(PANEL_IDS).find(([, current]) => current === actionId)?.[0] ?? actionId);
    for (const archived of [false, true])
      for (let offset = 0; ; offset += 200) {
        const rows = await sdk.threads.list({ archived, includeHidden: true, limit: 200, offset });
        for (const { id: threadId } of rows) {
          if (signal?.aborted) return;
          if (done.has(`${threadId}:tabs`)) continue;
          done.add(`${threadId}:tabs`);
          try {
            const current = await sdk.threads.tabs.get({ threadId });
            const moved = current.tabs.map((tab) =>
              tab.kind === "plugin-panel" && tab.pluginId === from ? { ...tab, pluginId: to, actionId: panel(tab.actionId) } : tab,
            );
            if (sameJson(moved, current.tabs)) {
              record({ threadId, kind: "tabs", state: "none", detail: null });
              continue;
            }
            await sdk.threads.tabs.update({ threadId, expectedRevision: current.revision, tabs: moved as never });
            record({ threadId, kind: "tabs", state: "copied", detail: null }, current);
          } catch (error) {
            const gone = (error as { status?: number }).status === 404;
            record({ threadId, kind: "tabs", state: gone ? "gone" : "failed", detail: gone ? null : errorMessage(error) });
          }
        }
        if (rows.length < 200) break;
      }
  }

  /** Record a fresh start on a BB that has a former ledger the user chose not to import. */
  startFresh() {
    if (this.row()) throw new ProjectError(`The migration is already ${this.row()!.state}.`);
    if (!this.ledgerEmpty()) throw new ProjectError("The ledger is not empty.");
    this.write("fresh", { reason: "user chose to start without importing", formerLedger: this.paths.legacyDatabase(), at: this.now() });
    return { state: "fresh", finished: true, open: [] };
  }

  /**
   * Give up an import that has not completed: point every tab it moved back
   * at the former plugin and stay paused, so the former plugin can be
   * enabled again. Imported rows stay for inspection; nothing is deleted.
   */
  async abandon(signal?: AbortSignal) {
    // Claimed before waiting: an import pass in flight finishes without completing.
    this.abandonRequested = true;
    try {
      return await this.exclusive(() => this.abandonOnce(signal));
    } finally {
      this.abandonRequested = false;
    }
  }

  private async abandonOnce(signal?: AbortSignal) {
    const row = this.row();
    if (row?.state !== "db-imported" && row?.state !== "abandoned")
      throw new ProjectError(
        row?.state === "complete" || row?.state === "exported"
          ? "The import completed; roll back with bb initiative migrate export instead, which keeps later writes."
          : `Nothing to abandon (state ${row?.state ?? "awaiting-import"}).`,
      );
    if (row.state === "db-imported") {
      this.db.prepare("DELETE FROM _initiatives_migration_threads WHERE direction = 'abandon'").run();
      this.write("abandoned", { ...row.report, abandonStartedAt: this.now() });
    }
    const moved = await this.moveThreads("abandon", signal);
    this.note({ abandon: { at: this.now(), threads: moved.threads, open: moved.open } });
    return { state: "abandoned", ...moved };
  }

  /**
   * Rollback, step one: stop this install, wait until every call and job it
   * already admitted has finished, and hand back what the ledger cannot
   * carry: thread metadata, tabs and settings. The ledger itself goes into
   * the former database with scripts/ledger.ts restore, read from this
   * plugin's data.db after it is disabled (BB has then closed it), so even a
   * write that finished after this command is included.
   */
  exportForRollback(options: { backupDir?: string }, settled: () => Promise<void>, signal?: AbortSignal) {
    return this.exclusive(() => this.exportOnce(options, settled, signal));
  }

  private async exportOnce(options: { backupDir?: string }, settled: () => Promise<void>, signal?: AbortSignal) {
    const row = this.row();
    if (row?.state !== "complete" && row?.state !== "exported")
      throw new ProjectError(`Only a completed import can be handed back (state ${row?.state ?? "awaiting-import"}).`);
    const legacy = await this.refreshLegacy();
    if (legacy.enabled) throw new ProjectError(`Keep the former plugin disabled until its ledger is restored (status ${legacy.status}).`);
    // Restore is authorized only by this hand-back finishing: any earlier
    // export's success is withdrawn before anything else happens.
    const report = { ...row.report, export: { finished: false, startedAt: this.now() } };
    if (row.state === "complete")
      // A new hand-back starts clean; an interrupted one resumes its threads.
      this.db.prepare("DELETE FROM _initiatives_migration_threads WHERE direction = 'export'").run();
    this.write("exported", report);
    // Paused from here: new calls are refused. Wait for admitted ones.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ProjectError("Admitted Initiative work did not finish within a minute; the hand-back is paused. Check running tool calls and retry export.")), SETTLED_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const unsettled = unsettledOperations(this.db, "main");
    if (unsettled.length) {
      this.write(row.state, report);
      throw new ProjectError(unsettledMessage(unsettled));
    }
    const backupDir = this.backupDirOf(options.backupDir);
    mkdirSync(backupDir, { recursive: true });
    const at = stamp(this.now());
    // A snapshot for inspection only; restore reads the closed data.db.
    const snapshot = join(backupDir, `${this.bb.pluginId}-export-${at}.db`);
    await this.db.backup(snapshot);
    const settingsFile = join(backupDir, `${this.bb.pluginId}-settings-${at}.json`);
    writeFileSync(settingsFile, JSON.stringify(await this.settingsExport(), null, 2));
    const threads = await this.moveThreads("export", signal);
    this.note({ export: { snapshot, settings: settingsFile, at: this.now(), threads: threads.threads, open: threads.open, finished: threads.finished } });
    return { state: "exported", snapshot: { path: snapshot, sha256: sha256File(snapshot) }, settings: settingsFile, ...threads };
  }

  /** Current settings in the shape of `bb plugin config <id> --json`, for the former plugin. */
  private async settingsExport() {
    const values = (await this.preferences.handle.get()) as Record<string, unknown>;
    return {
      ok: true,
      schema: Object.fromEntries(Object.entries(settingsDescriptors).map(([key, d]) => [key, { type: d.type, label: d.label, default: d.default }])),
      values: Object.fromEntries(Object.keys(settingsDescriptors).map((key) => [key, values[key]])),
    };
  }

  /**
   * Reopen an install that handed its ledger back, unchanged, and point the
   * tabs forward again. Refused when the former ledger has rows this one
   * lacks: Projects worked after the hand-back, and those writes must come
   * forward with migrate import --again instead of being dropped.
   */
  resume(options: { backupDir?: string; settings: string | null }, signal?: AbortSignal) {
    return this.exclusive(() => this.resumeOnce(options, signal));
  }

  private async resumeOnce(options: { backupDir?: string; settings: string | null }, signal?: AbortSignal) {
    const row = this.row();
    if (row?.state !== "exported") throw new ProjectError(`Nothing to resume (state ${row?.state ?? "awaiting-import"}).`);
    const settings = this.settingsPhase(options.settings);
    const source = await this.requireLegacyClosed("resuming");
    const current = this.copyLegacy(source, this.backupDirOf(options.backupDir), "at-resume");
    const importBackup = (row.report.backup as { path?: string } | undefined)?.path;
    this.db.prepare("ATTACH DATABASE ? AS legacy").run(current.path);
    let unchanged: "restored" | "never-restored" | null = null;
    try {
      if (verifyCopy(this.db, "main", "legacy").ok) unchanged = "restored";
      else if (importBackup && existsSync(importBackup)) {
        this.db.prepare("ATTACH DATABASE ? AS imported").run(importBackup);
        try {
          if (verifyCopy(this.db, "imported", "legacy").ok) unchanged = "never-restored";
        } finally {
          this.db.exec("DETACH DATABASE imported");
        }
      }
    } finally {
      this.db.exec("DETACH DATABASE legacy");
    }
    if (!unchanged)
      throw new ProjectError(
        "The former ledger changed after the hand-back: Projects did work this install does not have. Resuming would drop it. Bring it forward with bb initiative migrate import --again --settings <file> (saved with bb plugin config projects --json) instead.",
      );
    // Settings live outside the ledger: the former plugin's current ones come
    // back too, verified, before anything reopens.
    const applied = await this.writeSettings(settings);
    if (!applied.applied) {
      this.note({ resume: { at: this.now(), settings: applied } });
      throw new ProjectError(`The saved settings could not be applied (${applied.error}); this install stays paused. Fix it and run resume again.`);
    }
    this.db.prepare("DELETE FROM _initiatives_migration_threads WHERE direction = 'resume'").run();
    const moved = await this.moveThreads("resume", signal);
    if (moved.finished) this.write("complete", { ...row.report, resumedAt: this.now(), resumeCheck: unchanged, resumeCopy: current, resumeSettings: applied });
    else this.note({ resume: { at: this.now(), open: moved.open } });
    return { state: this.row()?.state, check: unchanged, ...moved };
  }
}

/**
 * Why a ledger cannot be restored into the former plugin, or null: it must
 * have been handed back with `migrate export`, and that hand-back must have
 * finished (metadata, tabs and settings all moved).
 */
export function handBackProblem(db: Db, schema = "main"): string | null {
  const migrated = db.prepare(`SELECT 1 FROM "${schema}".sqlite_master WHERE type = 'table' AND name = '_initiatives_migration'`).get();
  const row = (migrated
    ? db.prepare(`SELECT state, report FROM "${schema}"._initiatives_migration WHERE id = 1`).get()
    : undefined) as { state: string; report: string } | undefined;
  if (row?.state !== "exported")
    return `the Initiatives ledger is ${row?.state ?? "not migrated"}, not exported: run bb initiative migrate export (and wait for it to finish) before disabling it`;
  const handBack = (JSON.parse(row.report) as { export?: { finished?: boolean; open?: unknown[] } }).export;
  if (handBack?.finished !== true)
    return `the hand-back did not finish (${handBack?.open?.length ?? 0} open item(s)); re-run bb initiative migrate export until it exits 0`;
  return null;
}

/** Assignments still running or queued in a ledger; informational, the sweep reconciles them after the move. */
function activeAssignments(db: Db, schema: string) {
  return db
    .prepare(
      `SELECT project_id AS initiative, 'A' || num AS ref, state, thread_id AS threadId FROM "${schema}".assignments
       WHERE state IN ('dispatching', 'queued', 'running') ORDER BY project_id, num`,
    )
    .all();
}

export function unsettledMessage(unsettled: UnsettledOperation[]) {
  return [
    `${unsettled.length} native operation${unsettled.length === 1 ? " is" : "s are"} unsettled; only the plugin that started ${unsettled.length === 1 ? "it" : "them"} can settle ${unsettled.length === 1 ? "it" : "them"}. Re-enable it, let its sweep or an explicit settle finish, then try again. Nothing was moved.`,
    ...unsettled.map((u) => `- ${u.initiative} ${u.ref}: ${u.detail}`),
  ].join("\n");
}
