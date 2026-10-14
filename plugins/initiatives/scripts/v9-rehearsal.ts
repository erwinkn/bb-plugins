// v9 decoding rehearsal (design §11.3 "Decoding") and the task-diff preview (§12 step 1), on a
// COPY of the plugin's database. Never point it at the live file: it migrates and writes.
//
//   dest=~/scratch/<W#>/data-copy.db
//   sqlite3 -readonly ~/.bb/plugins/initiatives/data.db ".backup '$dest'"
//   npx tsx scripts/v9-rehearsal.ts "$dest" --old <previous build's plugins/initiatives> [--bb-db ~/.bb/bb.db] [--task-diff <dir>]
//
// --old is a checkout (or `git archive`) of the previous build with node_modules reachable.
// --bb-db is read-only: it reports whether either saved instruction field holds text that isn't
// a known default. --task-diff writes task-diff-<initiative>.md files there.
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, Store } from "../lib/store";
import { CUTOVER_FLAG } from "../lib/cutover";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, PREVIOUS_DEFAULTS } from "../lib/guidance";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args[0];
if (!file || file.startsWith("--")) throw new Error("Pass the database copy first.");
if (resolve(file).endsWith("/.bb/plugins/initiatives/data.db")) throw new Error("That is the live database. Pass a copy.");
const oldDir = option("--old");
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? `: ${detail}` : ""}`);
};

// 1. The v9 store: migrations run through the SDK's runner, which also checks that every
//    migration the database already applied is unchanged.
const db = new Database(file);
createFakePluginHost().bb.storage.migrate(db, MIGRATIONS);
const store = new Store(db);
const before = new Map(store.projects(true).flatMap((p) => (db.prepare("SELECT num, status FROM tasks WHERE project_id = ?").all(p.id) as { num: number; status: string }[]).map((t) => [`${p.id}:${t.num}`, t.status] as const)));
const closed = store.reconcileTaskOverrides();
check("v9 migrations and load-time task statements", true, `${MIGRATIONS.length} migrations; ${closed.length} done/cancelled tasks kept as set by hand`);
check("a second load changes nothing", store.reconcileTaskOverrides().length === 0);

// 2. The task-diff preview: every task whose shown status changes at the first load.
const diffDir = option("--task-diff");
for (const p of store.projects(true)) {
  const changed = store.tasks(p.id).filter((t) => before.get(`${p.id}:${t.num}`) !== t.status);
  const lines = changed.map((t) => `- ${t.ref} ${t.title}: ${before.get(`${p.id}:${t.num}`)} → ${t.status}${t.statusReason ? ` (${t.statusReason})` : ""}`);
  console.log(`  ${p.name}: ${store.tasks(p.id).length} tasks, ${changed.length} change their shown status`);
  if (diffDir) {
    mkdirSync(diffDir, { recursive: true });
    writeFileSync(join(diffDir, `task-diff-${p.id}.md`), [`# Task status at the first v9 load · ${p.name}`, "", ...(lines.length ? lines : ["No task changes its shown status."]), ""].join("\n"));
  }
}

// 3. Write each v9 shape: a reply_to, a hand-set status, a rule, a PR state and the flag.
const project = store.projects().find((p) => store.tasks(p.id).length >= 3 && store.assignments(p.id).length) ?? store.projects()[0];
if (!project) throw new Error("The copy has no live Initiative to rehearse on.");
const a = store.assignments(project.id).at(-1)!;
db.prepare("UPDATE assignments SET reply_to = ? WHERE project_id = ? AND num = ?").run(project.coordinatorThreadId ?? "coordinator", project.id, a.num);
const computed = store.tasks(project.id).filter((t) => t.statusSetAt === null && !["done", "cancelled"].includes(t.status));
if (computed.length < 3) throw new Error(`${project.name} needs three computed, open tasks for the round trip.`);
const [handSet, toCancel, toClose] = computed;
const untouched = computed[3] ?? null;
store.setTaskStatus(project.id, handSet!.num, "cancelled");
store.addRule(project.id, "Rehearsal rule: every PR targets dev.");
store.markPrsOpen(["https://github.com/example/rehearsal/pull/1"], Date.now());
store.upsertFlag(CUTOVER_FLAG, Date.now());
check("v9 writes", true, `${project.name}: reply_to on ${a.ref}, ${handSet!.ref} cancelled by hand, a rule, a PR state, ${CUTOVER_FLAG}`);
db.close();

// 4. The previous build reads every record of the migrated copy, then closes two computed tasks.
if (oldDir) {
  const old = (await import(pathToFileURL(join(resolve(oldDir), "lib/store.ts")).href)) as { Store: new (db: Database.Database) => any };
  const odb = new Database(file);
  const ostore = new old.Store(odb);
  try {
    let records = 0;
    for (const p of ostore.projects(true)) {
      records += ostore.workers(p.id).length + ostore.assignments(p.id).length + ostore.tasks(p.id).length + ostore.prRecords(p.id).size;
      for (const t of ostore.tasks(p.id)) ostore.task(p.id, t.num);
    }
    check("the previous build reads every record", true, `${records} records`);
    const oldHandSet = ostore.task(project.id, handSet!.num);
    check("the hand-set status reads back under the previous build", oldHandSet.status === "cancelled", `${handSet!.ref}: ${oldHandSet.status}`);
    ostore.updateTask(project.id, toCancel!.num, { status: "cancelled", result: "Rehearsal: cancelled under the previous build" });
    ostore.updateTask(project.id, toClose!.num, { status: "done", result: "Rehearsal: closed under the previous build" });
  } catch (error) {
    check("the previous build reads every record", false, String(error));
  }
  odb.close();

  // 5. Back on v9: the two old-build closes are hand-set, an untouched computed task is still computed.
  const vdb = new Database(file);
  createFakePluginHost().bb.storage.migrate(vdb, MIGRATIONS);
  const v = new Store(vdb);
  const kept = v.reconcileTaskOverrides();
  const back = (num: number) => v.task(project.id, num)!;
  check("old-build closes come back as set by hand", back(toCancel!.num).statusSetAt !== null && back(toCancel!.num).status === "cancelled" && back(toClose!.num).statusSetAt !== null && back(toClose!.num).status === "done",
    `${toCancel!.ref} ${back(toCancel!.num).status}, ${toClose!.ref} ${back(toClose!.num).status}; ${kept.length} kept`);
  if (untouched) check("an untouched computed task stays computed", back(untouched.num).statusSetAt === null, `${untouched.ref} ${back(untouched.num).status} (${back(untouched.num).statusReason})`);
  vdb.close();
}

// 6. Saved guidance: does either field hold text that isn't a known default (§8.4)?
const bbDb = option("--bb-db");
if (bbDb) {
  const bb = new Database(bbDb, { readonly: true, fileMustExist: true });
  const rows = bb.prepare("SELECT key, value FROM plugin_settings WHERE plugin_id = 'initiatives' AND key IN ('coordinatorInstructions', 'workerInstructions')").all() as { key: string; value: string }[];
  for (const key of ["coordinatorInstructions", "workerInstructions"] as const) {
    const row = rows.find((r) => r.key === key);
    const text = row ? (JSON.parse(row.value) as string) : null;
    const known = text === null || [key === "coordinatorInstructions" ? DEFAULT_COORDINATOR_INSTRUCTIONS : DEFAULT_WORKER_INSTRUCTIONS, ...PREVIOUS_DEFAULTS[key === "coordinatorInstructions" ? "coordinator" : "worker"]].includes(text);
    console.log(`  ${key}: ${text === null ? "nothing stored" : known ? "a known default (v9 unsets it)" : "a real edit: compare it with v9's default before the switch"}`);
  }
  bb.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} step(s) failed.` : "All steps passed.");
process.exitCode = failed.length ? 1 : 0;
