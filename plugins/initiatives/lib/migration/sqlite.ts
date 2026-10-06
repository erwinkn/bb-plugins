import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

// The one-time move of the Initiative ledger between plugin IDs, in both
// directions: `projects` -> `initiatives` (import) and back (rollback). Both
// databases carry the same schema and the same `_bb_migrations` history, so a
// move is a row-for-row copy that keeps every rowid and AUTOINCREMENT counter,
// and a verifier can compare every row. Pure functions over one connection
// with both databases attached; the caller owns the transaction.

type Db = Database.Database;

/** This plugin's own migration bookkeeping; never copied or compared. */
export const BOOKKEEPING_PREFIX = "_initiatives_";

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const table = (schema: string, name: string) => `${ident(schema)}.${ident(name)}`;

/** Every ledger table: all ordinary tables except SQLite's, BB's and the migration's own. */
export function dataTables(db: Db, schema: string): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM ${ident(schema)}.sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_bb\\_%' ESCAPE '\\'
           AND name NOT LIKE '${BOOKKEEPING_PREFIX.replaceAll("_", "\\_")}%' ESCAPE '\\'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

const columns = (db: Db, schema: string, name: string) =>
  db.prepare(`PRAGMA ${ident(schema)}.table_info(${ident(name)})`).all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];

const migrations = (db: Db, schema: string) =>
  db
    .prepare(`SELECT id, statement_hash AS hash FROM ${table(schema, "_bb_migrations")} ORDER BY id`)
    .all() as { id: number; hash: string | null }[];

/**
 * Why `to` cannot take `from`'s rows verbatim: a table only one side has, any
 * column difference, or a different migration history. Empty means identical.
 */
export function schemaDifferences(db: Db, from: string, to: string): string[] {
  const problems: string[] = [];
  const source = dataTables(db, from);
  const target = dataTables(db, to);
  for (const name of source.filter((t) => !target.includes(t)))
    problems.push(`table ${name} exists only in ${from}`);
  for (const name of target.filter((t) => !source.includes(t)))
    problems.push(`table ${name} exists only in ${to}`);
  for (const name of source.filter((t) => target.includes(t))) {
    const a = JSON.stringify(columns(db, from, name));
    const b = JSON.stringify(columns(db, to, name));
    if (a !== b) problems.push(`table ${name} has different columns in ${from} and ${to}`);
  }
  const a = migrations(db, from);
  const b = migrations(db, to);
  if (a.length !== b.length)
    problems.push(`${from} has ${a.length} migrations, ${to} has ${b.length}`);
  for (const [index, row] of a.entries()) {
    const other = b[index];
    if (other && (other.id !== row.id || other.hash !== row.hash)) {
      problems.push(`migration ${row.id} differs between ${from} and ${to}`);
      break;
    }
  }
  return problems;
}

export interface UnsettledOperation {
  initiative: string;
  ref: string;
  detail: string;
}

/**
 * Native operations whose outcome the ledger does not know yet: a spawn,
 * send or notice that may have reached BB without its receipt being recorded.
 * Only the plugin that started one can settle it — its receipt scans and
 * pending-member checks look for its own origin and metadata — so a move
 * between plugin IDs refuses while any is open. Retired history tables
 * (inbox, batches, worker_messages, leases) are never replayed and not listed.
 */
export function unsettledOperations(db: Db, schema: string): UnsettledOperation[] {
  const t = (name: string) => table(schema, name);
  const rows = (sql: string) => db.prepare(sql).all() as UnsettledOperation[];
  return [
    ...rows(`SELECT project_id AS initiative, 'A' || num AS ref,
        'operation ' || op_id || ' is ' || op_state || ' (assignment ' || state || ')' AS detail
      FROM ${t("assignments")} WHERE op_state IN ('pending', 'uncertain') ORDER BY project_id, num`),
    ...rows(`SELECT project_id AS initiative, 'A' || num AS ref,
        'staged identity change awaits brief delivery' AS detail
      FROM ${t("assignments")} WHERE pending_identity IS NOT NULL ORDER BY project_id, num`),
    ...rows(`SELECT project_id AS initiative, 'A' || num AS ref,
        'report notice to the coordinator is ' || json_extract(report_notice, '$.state') AS detail
      FROM ${t("assignments")} WHERE json_extract(report_notice, '$.state') IN ('pending', 'uncertain') ORDER BY project_id, num`),
    ...rows(`SELECT project_id AS initiative, 'D' || num AS ref,
        'decision notice to the coordinator is ' || json_extract(decision_notification, '$.state') AS detail
      FROM ${t("knowledge")} WHERE json_extract(decision_notification, '$.state') IN ('pending', 'uncertain') ORDER BY project_id, num`),
    ...rows(`SELECT project_id AS initiative, 'coordinator start' AS ref,
        'operation ' || op_id || ' is ' || state AS detail
      FROM ${t("coordinator_starts")} WHERE state IN ('pending', 'uncertain') ORDER BY project_id`),
    ...rows(`SELECT project_id AS initiative, 'coordinator handover' AS ref,
        'replacement is pending' AS detail
      FROM ${t("coordinator_handovers")} WHERE state = 'pending' ORDER BY project_id`),
    ...rows(`SELECT project_id AS initiative, 'user thread ' || label AS ref,
        'operation ' || op_id || ' is ' || state AS detail
      FROM ${t("project_threads")} WHERE state IN ('pending', 'uncertain') ORDER BY project_id, created_at`),
  ];
}

/** Rows per ledger table. */
export function rowCounts(db: Db, schema: string): Record<string, number> {
  return Object.fromEntries(
    dataTables(db, schema).map((name) => [
      name,
      (db.prepare(`SELECT count(*) AS n FROM ${table(schema, name)}`).get() as { n: number }).n,
    ]),
  );
}

const hasSequence = (db: Db, schema: string) =>
  db
    .prepare(`SELECT 1 FROM ${ident(schema)}.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)
    .get() !== undefined;

const sequence = (db: Db, schema: string) =>
  hasSequence(db, schema)
    ? (db.prepare(`SELECT name, seq FROM ${table(schema, "sqlite_sequence")} ORDER BY name`).all() as {
        name: string;
        seq: number;
      }[])
    : [];

/**
 * Copy every ledger row from `from` into `to`, keeping rowids, then make the
 * AUTOINCREMENT counters equal. `into-empty` refuses a target holding any
 * row; `replace` first empties the target (rollback onto the old copy). The
 * caller runs this inside one transaction with the schemas already compared.
 */
export function copyRows(db: Db, from: string, to: string, mode: "into-empty" | "replace") {
  const tables = dataTables(db, from);
  if (mode === "into-empty") {
    const occupied = Object.entries(rowCounts(db, to)).filter(([, n]) => n > 0);
    if (occupied.length)
      throw new Error(
        `The target ledger is not empty (${occupied.map(([name, n]) => `${name}: ${n}`).join(", ")}).`,
      );
  } else for (const name of tables) db.prepare(`DELETE FROM ${table(to, name)}`).run();
  for (const name of tables) {
    const list = columns(db, from, name).map((c) => ident(c.name)).join(", ");
    db.prepare(
      `INSERT INTO ${table(to, name)} (rowid, ${list}) SELECT rowid, ${list} FROM ${table(from, name)} ORDER BY rowid`,
    ).run();
  }
  if (hasSequence(db, to)) {
    db.prepare(`DELETE FROM ${table(to, "sqlite_sequence")}`).run();
    if (hasSequence(db, from))
      db.prepare(
        `INSERT INTO ${table(to, "sqlite_sequence")} (name, seq) SELECT name, seq FROM ${table(from, "sqlite_sequence")}`,
      ).run();
  }
}

export interface TableCheck {
  table: string;
  sourceRows: number;
  targetRows: number;
  /** Source rows (by rowid and every value) the target lacks. */
  missing: number;
  /** Target rows the source lacks. */
  extra: number;
  sourceSha256: string;
  targetSha256: string;
  ok: boolean;
}

export interface CopyVerification {
  ok: boolean;
  tables: TableCheck[];
  sequence: { ok: boolean; source: { name: string; seq: number }[]; target: { name: string; seq: number }[] };
}

/**
 * A digest of every row in rowid order: the rowid, then each column's storage
 * class and value, so integer 1 and real 1.0 or text and blob never collide.
 */
export function tableDigest(db: Db, schema: string, name: string): string {
  const cols = columns(db, schema, name);
  const select = cols.map((c) => `typeof(${ident(c.name)}), ${ident(c.name)}`).join(", ");
  const hash = createHash("sha256");
  const rows = db
    .prepare(`SELECT rowid${select ? `, ${select}` : ""} FROM ${table(schema, name)} ORDER BY rowid`)
    .raw(true)
    .iterate() as IterableIterator<unknown[]>;
  for (const row of rows)
    hash.update(
      JSON.stringify(row, (_key, value: unknown) =>
        Buffer.isBuffer(value) ? { blob: value.toString("hex") } : value,
      ) + "\n",
    );
  return hash.digest("hex");
}

/**
 * Independent of `copyRows`: a set comparison in SQL (both directions, with
 * rowids) plus a per-table digest computed row by row in JavaScript, and the
 * AUTOINCREMENT counters. Any difference fails the whole check.
 */
export function verifyCopy(db: Db, from: string, to: string): CopyVerification {
  const names = [...new Set([...dataTables(db, from), ...dataTables(db, to)])].sort();
  const tables = names.map((name): TableCheck => {
    const inFrom = dataTables(db, from).includes(name);
    const inTo = dataTables(db, to).includes(name);
    const count = (schema: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table(schema, name)}`).get() as { n: number }).n;
    if (!inFrom || !inTo)
      return {
        table: name,
        sourceRows: inFrom ? count(from) : 0,
        targetRows: inTo ? count(to) : 0,
        missing: inFrom ? count(from) : 0,
        extra: inTo ? count(to) : 0,
        sourceSha256: inFrom ? tableDigest(db, from, name) : "",
        targetSha256: inTo ? tableDigest(db, to, name) : "",
        ok: false,
      };
    const difference = (a: string, b: string) =>
      (
        db
          .prepare(
            `SELECT count(*) AS n FROM (SELECT rowid, * FROM ${table(a, name)} EXCEPT SELECT rowid, * FROM ${table(b, name)})`,
          )
          .get() as { n: number }
      ).n;
    const check = {
      table: name,
      sourceRows: count(from),
      targetRows: count(to),
      missing: difference(from, to),
      extra: difference(to, from),
      sourceSha256: tableDigest(db, from, name),
      targetSha256: tableDigest(db, to, name),
    };
    return {
      ...check,
      ok:
        check.sourceRows === check.targetRows &&
        check.missing === 0 &&
        check.extra === 0 &&
        check.sourceSha256 === check.targetSha256,
    };
  });
  const source = sequence(db, from);
  const target = sequence(db, to);
  const sequenceOk = JSON.stringify(source) === JSON.stringify(target);
  return {
    ok: sequenceOk && tables.every((t) => t.ok),
    tables,
    sequence: { ok: sequenceOk, source, target },
  };
}

/** `PRAGMA integrity_check` of one attached database; "ok" or the problems. */
export function integrity(db: Db, schema: string): string {
  return (db.prepare(`PRAGMA ${ident(schema)}.integrity_check`).all() as { integrity_check: string }[])
    .map((row) => row.integrity_check)
    .join("; ");
}

/** A compact, printable line per table for reports. */
export function describeVerification(check: CopyVerification): string[] {
  return [
    ...check.tables.map(
      (t) =>
        `${t.ok ? "ok  " : "FAIL"} ${t.table}: ${t.sourceRows} -> ${t.targetRows} rows, missing ${t.missing}, extra ${t.extra}, sha256 ${t.sourceSha256.slice(0, 12)}${t.sourceSha256 === t.targetSha256 ? " =" : ` != ${t.targetSha256.slice(0, 12)}`}`,
    ),
    `${check.sequence.ok ? "ok  " : "FAIL"} sqlite_sequence: ${check.sequence.source.map((s) => `${s.name}=${s.seq}`).join(", ") || "(none)"}`,
  ];
}
