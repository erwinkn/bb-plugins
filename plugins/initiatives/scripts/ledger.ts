// Offline tool for the one-time Projects -> Initiatives move. Run from this
// plugin's directory:
//
//   npx vite-node scripts/ledger.ts -- dry-run <copy of projects data.db> [--work <dir>]
//   npx vite-node scripts/ledger.ts -- verify <source.db> <target.db>
//   npx vite-node scripts/ledger.ts -- restore --from <initiatives data.db> --to <projects data.db>
//   npx vite-node scripts/ledger.ts -- apply-settings --plugin projects --from <initiatives-settings-*.json>
//
// dry-run imports a copy into a scratch ledger built like a fresh install and
// prints the full-row verification; it never opens the given file for writing.
// restore is the rollback's database step. With both plugins disabled (BB has
// closed both databases) it copies the Initiatives ledger, which must have
// been handed back with `migrate export`, keeps a copy of the Projects
// data.db beside it, then replaces the Projects rows in one verified
// transaction. apply-settings gives the former plugin the settings the
// export saved (it must be running) and verifies them.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MIGRATIONS } from "../lib/store";
import { applyMigrations } from "../lib/migration/bb-migrations";
import { handBackProblem } from "../lib/migration/legacy";
import { settingsMismatches, settingsSteps, type SavedSettings } from "../lib/migration/settings-transfer";
import {
  copyRows,
  describeVerification,
  integrity,
  rowCounts,
  schemaDifferences,
  unsettledOperations,
  verifyCopy,
} from "../lib/migration/sqlite";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const fail = (message: string): never => {
  console.error(`refused: ${message}`);
  process.exit(1);
};
const option = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const requireQuiet = (path: string) => {
  const wal = `${path}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0)
    fail(`${wal} is not empty: something still has ${basename(path)} open, or it was not closed cleanly.`);
};

function dryRun(args: string[]) {
  const given = args[0] ? resolve(args[0]) : fail("pass the path of a copy of the projects data.db");
  if (!existsSync(given)) fail(`${given} does not exist`);
  requireQuiet(given);
  const work = resolve(option(args, "--work") ?? mkdtempSync(join(tmpdir(), "initiatives-dry-run-")));
  mkdirSync(work, { recursive: true });
  const started = Date.now();
  const source = join(work, "projects-data.db");
  const givenSha = sha256(given);
  copyFileSync(given, source);
  if (sha256(source) !== givenSha) fail("the working copy does not match the given file");

  const target = join(work, "initiatives-data.db");
  if (existsSync(target)) fail(`${target} exists; pass an empty --work directory`);
  const db = new Database(target);
  db.pragma("journal_mode = WAL");
  applyMigrations(db, MIGRATIONS);
  db.prepare("ATTACH DATABASE ? AS legacy").run(source);
  console.log(`source   ${given}`);
  console.log(`sha256   ${givenSha} (${statSync(given).size} bytes)`);
  console.log(`work     ${work}`);
  console.log(`integrity legacy: ${integrity(db, "legacy")}`);
  const differences = schemaDifferences(db, "legacy", "main");
  console.log(`schema   ${differences.length ? differences.join("; ") : `identical (${MIGRATIONS.length} migrations)`}`);
  const unsettled = unsettledOperations(db, "legacy");
  console.log(`unsettled ${unsettled.length}${unsettled.map((u) => `\n  - ${u.initiative} ${u.ref}: ${u.detail}`).join("")}`);
  const active = db
    .prepare("SELECT project_id, 'A' || num AS ref, state FROM legacy.assignments WHERE state IN ('dispatching', 'queued', 'running') ORDER BY project_id, num")
    .all() as { project_id: string; ref: string; state: string }[];
  console.log(`active work ${active.length} (reconciled by the sweep after import)${active.map((a) => `\n  - ${a.project_id} ${a.ref} ${a.state}`).join("")}`);
  if (differences.length) fail("schemas differ");
  let ok = false;
  db.transaction(() => {
    copyRows(db, "legacy", "main", "into-empty");
    const check = verifyCopy(db, "legacy", "main");
    console.log("verification (rows, set difference both ways with rowids, per-table sha256 of every value with its storage class):");
    for (const line of describeVerification(check)) console.log(`  ${line}`);
    ok = check.ok;
    if (!ok) throw new Error("verification failed; the scratch import was rolled back");
  })();
  console.log(`integrity imported: ${integrity(db, "main")}`);
  const counts = rowCounts(db, "main");
  console.log(`rows     ${Object.values(counts).reduce((a, b) => a + b, 0)} in ${Object.keys(counts).length} tables`);
  db.exec("DETACH DATABASE legacy");
  db.close();
  if (sha256(given) !== givenSha) fail("the given file changed during the dry run");
  console.log(`given file unchanged: sha256 ${givenSha.slice(0, 16)}…`);
  console.log(`result   ${ok && !unsettled.length ? "PASS" : unsettled.length ? "PASS for rows; the live import would refuse until the unsettled operations settle" : "FAIL"} in ${Date.now() - started} ms`);
}

function verify(args: string[]) {
  const [a, b] = args.map((p) => resolve(p));
  if (!a || !b) fail("pass <source.db> <target.db>");
  for (const path of [a!, b!]) requireQuiet(path);
  const db = new Database(":memory:");
  db.prepare("ATTACH DATABASE ? AS a").run(a);
  db.prepare("ATTACH DATABASE ? AS b").run(b);
  const differences = schemaDifferences(db, "a", "b");
  if (differences.length) console.log(`schema differences: ${differences.join("; ")}`);
  const check = verifyCopy(db, "a", "b");
  for (const line of describeVerification(check)) console.log(line);
  console.log(check.ok && !differences.length ? "IDENTICAL" : "DIFFERENT");
  process.exit(check.ok && !differences.length ? 0 : 1);
}

function restore(args: string[]) {
  const given = resolve(option(args, "--from") ?? fail("pass --from <initiatives data.db>"));
  const to = resolve(option(args, "--to") ?? fail("pass --to <projects data.db>"));
  for (const path of [given, to]) if (!existsSync(path)) fail(`${path} does not exist`);
  if (!args.includes("--skip-plugin-check")) {
    const plugins = (JSON.parse(execFileSync("bb", ["plugin", "list", "--json"], { encoding: "utf8" })) as {
      plugins: { id: string; enabled: boolean; status: string }[];
    }).plugins;
    for (const id of ["projects", "initiatives"]) {
      const row = plugins.find((p) => p.id === id);
      if (row?.enabled) fail(`${id} is enabled (${row.status}); disable it and wait for disabled first`);
    }
  }
  requireQuiet(to);
  requireQuiet(given);
  // Read a copy of the closed Initiatives ledger, never the file itself.
  const from = join(dirname(to), `initiatives-handed-back-${stamp()}.db`);
  copyFileSync(given, from);
  if (sha256(from) !== sha256(given)) fail("the copy of the Initiatives ledger does not match it");
  const handBack = new Database(from, { readonly: true });
  const problem = handBackProblem(handBack);
  handBack.close();
  if (problem && !args.includes("--force")) fail(problem);
  console.log(`source   ${given} (copied to ${from}, handed back)`);
  const backup = `${to}.pre-rollback-${stamp()}`;
  copyFileSync(to, backup);
  if (sha256(backup) !== sha256(to)) fail("the backup of the target does not match it");
  console.log(`kept     ${backup} (sha256 ${sha256(backup).slice(0, 16)}…)`);
  const db = new Database(to);
  db.prepare("ATTACH DATABASE ? AS src").run(from);
  for (const schema of ["src", "main"]) {
    const health = integrity(db, schema);
    if (health !== "ok") fail(`${schema} fails its integrity check: ${health}`);
  }
  const differences = schemaDifferences(db, "src", "main");
  if (differences.length) fail(`schemas differ: ${differences.join("; ")}`);
  const unsettled = unsettledOperations(db, "src");
  if (unsettled.length) fail(`the export has unsettled operations:\n${unsettled.map((u) => `  - ${u.initiative} ${u.ref}: ${u.detail}`).join("\n")}`);
  db.transaction(() => {
    copyRows(db, "src", "main", "replace");
    const check = verifyCopy(db, "src", "main");
    for (const line of describeVerification(check)) console.log(`  ${line}`);
    if (!check.ok) throw new Error("verification failed; the restore was rolled back and the target is unchanged");
  })();
  db.exec("DETACH DATABASE src");
  db.close();
  console.log(`restored ${to} from ${from}`);
}

function applySettings(args: string[]) {
  const plugin = option(args, "--plugin") ?? fail("pass --plugin <id>");
  const file = resolve(option(args, "--from") ?? fail("pass --from <settings.json>"));
  const saved = JSON.parse(readFileSync(file, "utf8")) as SavedSettings;
  const bb = (...argv: string[]) => execFileSync("bb", argv, { encoding: "utf8" });
  const current = () => (JSON.parse(bb("plugin", "config", plugin, "--json")) as { values: Record<string, unknown> }).values;
  for (const step of settingsSteps(saved, current())) {
    if (step.op === "unset") bb("plugin", "config", plugin, "unset", step.key);
    else bb("plugin", "config", plugin, "set", step.key, step.value);
    console.log(`${step.op.padEnd(8)} ${plugin} ${step.key}`);
  }
  const wrong = settingsMismatches(saved, current());
  if (wrong.length) fail(`${plugin} settings read back differently: ${wrong.join(", ")}`);
  console.log(`settings ${plugin} matches ${basename(file)} (${Object.keys(saved.values).length} fields)`);
}

const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (command === "dry-run") dryRun(rest);
else if (command === "verify") verify(rest);
else if (command === "restore") restore(rest);
else if (command === "apply-settings") applySettings(rest);
else fail("usage: dry-run <copy> [--work <dir>] | verify <a.db> <b.db> | restore --from <initiatives data.db> --to <projects data.db> | apply-settings --plugin <id> --from <settings.json>");
