import type Database from "better-sqlite3";
import { z } from "zod";
import type {
  AssignmentState,
  AssignmentAccess,
  Brief,
  Decision,
  EnvironmentChoice,
  Handoff,
  HumanAttention,
  Policy,
  Profile,
  ProjectContext,
  Report,
  Retention,
  Role,
  Route,
  TaskStatus,
  WorkKind,
  WorkerKind,
  WorkerState,
} from "./schema";
import {
  DEFAULT_POLICY,
  canonicalWorkerKind,
  briefSchema,
  decisionFieldsSchema,
  environmentSchema,
  handoffSchema,
  policySchema,
  storedPolicySchema,
  profileSchema,
  projectContextSchema,
  retentionSchema,
} from "./schema";

import { isLegacyReport, storedReportSchema } from "./legacy";
import { PROJECT_COLORS, PROJECT_ICONS, type ProjectAppearance } from "./tree-schema";
import { PR_STAGE_IDS, type PrRecord, type PrStage, type PrStageChange } from "./pr-stages";
import { PR_NOTE_MIGRATIONS } from "./pr-notes";
import { PR_OWNER_MIGRATIONS } from "./pr-owners";
import { WRITE_RECEIPT_MIGRATIONS } from "./write-receipt-migrations";
import { ownBriefText } from "./brief";
import { computeTaskStatus, reportPrs, type HandStatus, type PrState } from "./task-status";


// The plugin server is the only writer. Every multi-row change runs in one
// transaction; BB threads, transcripts, and queues are referenced by id only.

export const MIGRATIONS = [
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    member_project_ids TEXT NOT NULL,
    coordinator_thread_id TEXT,
    coordinator_generation INTEGER NOT NULL DEFAULT 0,
    checkpoint TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    policy TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  )`,
  `CREATE TABLE tasks (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    brief TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    depends_on TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    profile_override TEXT,
    profile_source TEXT,
    progress TEXT,
    next_checkpoint TEXT,
    result TEXT,
    accepted_assignment INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, num)
  )`,
  `CREATE TABLE workers (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    role TEXT NOT NULL,
    label TEXT NOT NULL,
    area TEXT NOT NULL,
    thread_id TEXT,
    generation INTEGER NOT NULL,
    bb_project_id TEXT NOT NULL,
    environment_id TEXT,
    provider_id TEXT,
    model TEXT,
    reasoning_level TEXT,
    state TEXT NOT NULL,
    retention TEXT,
    handoff TEXT,
    forked_from INTEGER,
    native_parent INTEGER NOT NULL DEFAULT 0,
    user_stopped INTEGER NOT NULL DEFAULT 0,
    intervention_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, num)
  )`,
  `CREATE INDEX workers_thread ON workers(thread_id)`,
  `CREATE TABLE generations (
    project_id TEXT NOT NULL,
    worker_num INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    provider_thread_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    PRIMARY KEY (project_id, worker_num, generation)
  )`,
  `CREATE INDEX generations_thread ON generations(thread_id)`,
  `CREATE TABLE assignments (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    worker_num INTEGER NOT NULL,
    task_nums TEXT NOT NULL,
    route TEXT NOT NULL,
    role TEXT NOT NULL,
    work_kind TEXT,
    thread_id TEXT,
    generation INTEGER NOT NULL,
    profile TEXT NOT NULL,
    actual_profile TEXT,
    fingerprint TEXT,
    bb_project_id TEXT NOT NULL,
    environment_id TEXT,
    state TEXT NOT NULL,
    op_id TEXT NOT NULL UNIQUE,
    op_state TEXT NOT NULL,
    queued_message_id TEXT,
    brief_text TEXT NOT NULL,
    review_of TEXT,
    rationale TEXT,
    report TEXT,
    reported_at INTEGER,
    stop_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, num)
  )`,
  `CREATE INDEX assignments_thread ON assignments(thread_id)`,
  `CREATE INDEX assignments_queued ON assignments(queued_message_id)`,
  `CREATE TABLE knowledge (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    topic TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    human_attention TEXT NOT NULL,
    blocks TEXT NOT NULL,
    deadline TEXT,
    provenance TEXT NOT NULL,
    supersedes INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, num)
  )`,
  `CREATE TABLE updates (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    thread_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, num)
  )`,
  `CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    priority TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL,
    batch_id INTEGER,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  )`,
  `CREATE INDEX inbox_pending ON inbox(project_id, state)`,
  `CREATE TABLE batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    coordinator_thread_id TEXT NOT NULL,
    marker TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  )`,
  `CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    ref TEXT
  )`,
  `CREATE INDEX activity_project ON activity(project_id, id)`,
  `CREATE TABLE usage (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worker_num INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    provider_thread_id TEXT,
    session_totals TEXT,
    closed_totals TEXT NOT NULL,
    resets INTEGER NOT NULL DEFAULT 0,
    last_report_at INTEGER,
    context_used INTEGER,
    context_window INTEGER,
    model TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    worker_num INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    fingerprint TEXT,
    state TEXT NOT NULL,
    reason TEXT NOT NULL,
    max_refreshes INTEGER NOT NULL,
    refreshes INTEGER NOT NULL DEFAULT 0,
    deadline INTEGER NOT NULL,
    capability TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT
  )`,
  `CREATE TABLE coordinator_starts (
    project_id TEXT PRIMARY KEY, op_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, thread_id TEXT, reason TEXT, created_at INTEGER NOT NULL
  )`,
  `ALTER TABLE assignments ADD COLUMN review_key TEXT`,
  `ALTER TABLE usage ADD COLUMN context_estimated INTEGER`,
  `ALTER TABLE usage ADD COLUMN context_changed_at INTEGER`,
  `CREATE TABLE worker_messages (op_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worker_num INTEGER NOT NULL, generation INTEGER NOT NULL, thread_id TEXT NOT NULL, assignment_num INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, queued_id TEXT, created_at INTEGER NOT NULL)`,
  `ALTER TABLE assignments ADD COLUMN brief_delivered INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE assignments ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0`,
  `UPDATE assignments SET brief_delivered=1 WHERE state IN ('running','idle_no_report','reported','accepted') AND op_state='done'`,
  `ALTER TABLE projects ADD COLUMN context TEXT NOT NULL DEFAULT '{}'`,
  `CREATE TABLE coordinator_handovers (
    project_id TEXT PRIMARY KEY,
    thread_id TEXT,
    reason TEXT NOT NULL,
    profile TEXT,
    requested_by TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `ALTER TABLE coordinator_handovers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
  // Revision identity must survive delete-and-recreate: a row keyed by project
  // alone would restart at 1 after a cancel, letting an in-flight drain settle
  // the newer request. The counter never shrinks.
  `CREATE TABLE handover_counters (
    project_id TEXT PRIMARY KEY,
    next_revision INTEGER NOT NULL
  )`,
  // A user Stop on the coordinator is an intervention, not a project pause:
  // stop evidence carries the interrupted turn's own timestamp and only a
  // newer app-origin message releases the hold.
  `ALTER TABLE projects ADD COLUMN coordinator_stopped_at INTEGER`,
  `ALTER TABLE projects ADD COLUMN coordinator_continued_at INTEGER`,
  // User-owned ad-hoc threads: durable association plus the op receipt that
  // settles an uncertain create without ever duplicating a thread.
  `CREATE TABLE project_threads (
    project_id TEXT NOT NULL,
    op_id TEXT PRIMARY KEY,
    thread_id TEXT UNIQUE,
    label TEXT NOT NULL,
    bb_project_id TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER
  )`,
  `CREATE INDEX project_threads_project ON project_threads(project_id)`,
  // A handover may name its own environment (e.g. move the coordinator off an
  // incumbent's registered host) while still inheriting its execution settings.
  `ALTER TABLE coordinator_handovers ADD COLUMN environment TEXT`,
  // Descendants of a project's threads below the coordinator's direct
  // children: a nested child gets no project_threads row (it is not a user
  // project thread) but still needs lightweight membership so project
  // selection and read tools resolve the right durable project. The row is
  // purely a claim — no task, assignment, or lifecycle is implied.
  `CREATE TABLE project_nested_threads (
    project_id TEXT NOT NULL,
    thread_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    bb_project_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX project_nested_threads_project ON project_nested_threads(project_id)`,
  // A continue-route rename is staged here, not committed: the worker's
  // ledger identity changes only once positive brief delivery is recorded —
  // a refused send leaves the old identity standing and an uncertain one
  // keeps the staged rename for the settlement that proves delivery.
  `ALTER TABLE assignments ADD COLUMN pending_identity TEXT`,
  // Observations are additive; legacy model values remain unproven history.
  `ALTER TABLE usage ADD COLUMN context_observed_at INTEGER`,
  `ALTER TABLE usage ADD COLUMN first_observed_at INTEGER`,
  `ALTER TABLE usage ADD COLUMN last_observed_at INTEGER`,
  `ALTER TABLE usage ADD COLUMN profile_observation TEXT`,
  `CREATE TABLE usage_turn_cursors (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL, first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE usage_turns (
    thread_id TEXT NOT NULL, turn_key TEXT NOT NULL, turn_id TEXT,
    started_at INTEGER, completed_at INTEGER, status TEXT,
    start_seq INTEGER, completion_seq INTEGER,
    PRIMARY KEY(thread_id, turn_key)
  )`,
  `ALTER TABLE knowledge ADD COLUMN decision_owner TEXT`,
  `ALTER TABLE knowledge ADD COLUMN decision_review TEXT`,
  `ALTER TABLE knowledge ADD COLUMN decision_review_message TEXT`,
  `ALTER TABLE knowledge ADD COLUMN decision_notification TEXT`,
  `UPDATE knowledge SET decision_owner = CASE
    WHEN json_type(body, '$.answer')='object' THEN 'user'
    WHEN json_extract(provenance, '$.author')='user' THEN 'user' ELSE 'agent' END,
    decision_review = CASE WHEN json_type(body, '$.answer')='object' OR json_extract(provenance, '$.author')='user'
      THEN NULL ELSE 'pending' END
    WHERE kind='decision' AND status IN ('active','answered','superseded') AND json_valid(body) AND json_valid(provenance)
      AND (length(trim(COALESCE(json_extract(body, '$.outcome'), ''))) > 0
        OR (json_type(body, '$.answer')='object' AND
          (length(trim(COALESCE(json_extract(body, '$.answer.choice'), ''))) > 0
            OR length(trim(COALESCE(json_extract(body, '$.answer.note'), ''))) > 0)))`,
  // Preserve prior human acknowledgments only where the old activity log proves them.
  `UPDATE knowledge SET decision_review='okay'
    WHERE decision_owner='agent' AND EXISTS (SELECT 1 FROM activity a
      WHERE a.project_id=knowledge.project_id AND a.kind='decision' AND
      (a.summary=('You reviewed K' || knowledge.num) OR
       substr(a.summary, 1, length('You reviewed K' || knowledge.num || ': '))=('You reviewed K' || knowledge.num || ': ')))`,
  `CREATE TABLE legacy_session_payloads (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // The ownership pass above read a tentative outcome on an unanswered
  // question as a made choice. A question nobody answered has no owner:
  // return it to the user unless a later explicit review (always logged as
  // "You marked D<n> …") has since been recorded. Body and provenance stay.
  `UPDATE knowledge SET decision_owner=NULL, decision_review=NULL
    WHERE kind='decision' AND human_attention='needs-opinion' AND decision_owner='agent'
      AND json_valid(body) AND COALESCE(json_type(body, '$.answer'), 'null')<>'object'
      AND decision_review_message IS NULL AND decision_notification IS NULL
      AND NOT EXISTS (SELECT 1 FROM activity a
        WHERE a.project_id=knowledge.project_id AND a.kind='decision' AND
        substr(a.summary, 1, length('You marked D' || knowledge.num || ' '))=('You marked D' || knowledge.num || ' '))`,
  // Legacy work may write; reviewers have always been read-only.
  `ALTER TABLE assignments ADD COLUMN access TEXT NOT NULL DEFAULT 'write' CHECK (access IN ('read-only','write'))`,
  `UPDATE assignments SET access='read-only' WHERE role='review'`,
  // Append-only provenance for external checkpoints and exact review scope.
  `ALTER TABLE assignments ADD COLUMN checkpoint TEXT`,
  `ALTER TABLE assignments ADD COLUMN review_targets TEXT`,
  `ALTER TABLE assignments ADD COLUMN report_notice TEXT`,
  // T91: the declared write paths snapshotted at dispatch/checkpoint (never updated),
  // and an explicit, reasoned release of a hold kept by listed background work.
  `ALTER TABLE assignments ADD COLUMN write_scope TEXT`,
  `ALTER TABLE assignments ADD COLUMN scope_release TEXT`,
  `ALTER TABLE assignments ADD COLUMN report_seq INTEGER NOT NULL DEFAULT 0`,
  // T96: which prior report filings a fresh brief embedded, written once at dispatch.
  `ALTER TABLE assignments ADD COLUMN handoff_sources TEXT`,
  // T16: the user's optional icon and color for an Initiative ({icon,color} JSON; NULL is the default look).
  `ALTER TABLE projects ADD COLUMN appearance TEXT`,
  // T110: why a former coordinator generation still stays live, so an
  // unchanged refusal is logged once and the dashboard can show it.
  `ALTER TABLE generations ADD COLUMN hold_reason TEXT`,
  // T136: the handover a replacement coordinator receives as its first message, written by
  // a short-lived GPT-6 Luna thread from recent activity. One row per Initiative, consumed
  // when the replacement starts; nothing else keeps it.
  `CREATE TABLE plugin_flags (key TEXT PRIMARY KEY, set_at INTEGER NOT NULL)`,
  `CREATE TABLE handover_drafts (
    project_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('requested','generating','ready')),
    note TEXT,
    text TEXT,
    source TEXT CHECK (source IN ('luna','fallback','user')),
    thread_id TEXT,
    detail TEXT,
    then_replace TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // A296: the plain-listing handover, built from the same messages as the writer's packet.
  `ALTER TABLE handover_drafts ADD COLUMN fallback TEXT`,
  // A296: every handover writer thread until BB confirms it archived.
  `CREATE TABLE handover_writers (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // W188 (F1): what a draft was written from, so a replacement can tell a stale preview.
  `ALTER TABLE handover_drafts ADD COLUMN fingerprint TEXT`,
  `ALTER TABLE handover_drafts ADD COLUMN captured_at INTEGER`,
  `ALTER TABLE handover_drafts ADD COLUMN purpose TEXT`,
  // W198: the coordinator's workflow stage per pull request (canonical URL).
  `CREATE TABLE pr_stages (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    stage TEXT NOT NULL,
    note TEXT,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, url)
  )`,
  // W206: the role a coordinator asked for on spawn (worker, experimenter, fast, very-fast, explorer); null for reviewers and older workers.
  `ALTER TABLE workers ADD COLUMN kind TEXT`,
  // W220 (D431): coordinator memory: mode, log, cursors, tree nodes and saved views. T145 moved
  // memory to the Chat memory plugin, which copies these tables once; they stay, unwritten, as its
  // rollback, and so that every later migration keeps its index.
  `CREATE TABLE memory_settings (project_id TEXT PRIMARY KEY, mode TEXT NOT NULL, compact_tokens INTEGER, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE memory_log (project_id TEXT NOT NULL, i INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, thread_id TEXT, seq INTEGER, PRIMARY KEY (project_id, i))`,
  `CREATE TABLE memory_cursors (project_id TEXT NOT NULL, thread_id TEXT NOT NULL, last_seq INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, thread_id))`,
  `CREATE TABLE memory_nodes (project_id TEXT NOT NULL, l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, how TEXT NOT NULL, tries INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, l, i))`,
  `CREATE TABLE memory_trees (project_id TEXT PRIMARY KEY, views TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, call_ms INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, nodes INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  // W224 (D437, D438): one record per pull request (canonical URL): the stage of pr_stages,
  // plus category and where it stands. JSON columns: changes [text], decision {text,link,at}.
  // discussion_thread_id was the D439 hook, dropped by T149. Questions live in pr_notes (D442).
  `CREATE TABLE pr_records (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    stage TEXT,
    note TEXT,
    stage_set_at INTEGER,
    category TEXT,
    waiting_on TEXT,
    changes TEXT,
    decision TEXT,
    worker TEXT,
    assignment TEXT,
    discussion_thread_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, url)
  )`,
  // W224: carry the recorded stages over; pr_stages stays, unread, so an older build still works.
  `INSERT INTO pr_records (project_id, url, stage, note, stage_set_at, updated_at)
    SELECT project_id, url, stage, note, set_at, set_at FROM pr_stages`,
  // W232 (D442): each PR's notes log.
  ...PR_NOTE_MIGRATIONS,
  // W233 (D440): Store.openReviewOf, run on every thread-context read. Partial, so it holds only
  // live reviews; the query repeats these expressions and this predicate to use it.
  `CREATE INDEX assignments_open_review ON assignments(project_id, json_extract(handoff_sources, '$[0].assignment'),
    json_extract(handoff_sources, '$[0].reportVersion'), num) WHERE role = 'review' AND state IN ('dispatching', 'queued', 'running')`,
  // W248: dashboard writes' receipts by key, so a write sent again runs once, across reloads.
  ...WRITE_RECEIPT_MIGRATIONS,
  // T143: the worker label this assignment was created under. A later continue rename must not
  // relabel an earlier assignment still listed; null on older rows, which fall back to the worker's.
  `ALTER TABLE assignments ADD COLUMN label TEXT`,
  // T157: each PR's stage changes, appended by initiative_pr (recordPrs), never edited. Its key
  // indexes the detail panel's read of a PR's newest changes.
  `CREATE TABLE pr_stage_changes (
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    author TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT,
    note TEXT,
    PRIMARY KEY (project_id, url, n)
  )`,
  // T149 (D446): a discussion is a user project thread that shares the Initiative's memory.
  `ALTER TABLE project_threads ADD COLUMN discussion INTEGER NOT NULL DEFAULT 0`,
  // T149 (D448): no per-PR "Discuss" thread; nothing ever wrote this column.
  `ALTER TABLE pr_records DROP COLUMN discussion_thread_id`,
  // v9 (worker-owned reviews). Additive only: the previous build ignores every column and table
  // below, and its own inserts leave reply_to NULL, which is what marks work it gave out.
  // reply_to: the lead tab that gave the work out (the coordinator tab for anything else).
  `ALTER TABLE assignments ADD COLUMN reply_to TEXT`,
  // status_set_at: when someone set the task's status by hand; NULL means it is computed.
  `ALTER TABLE tasks ADD COLUMN status_set_at INTEGER`,
  // Standing rules (D523). A removed rule keeps its row (removed_at), so its number is never reused.
  `CREATE TABLE rules (
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    text TEXT NOT NULL,
    position INTEGER NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (project_id, num)
  )`,
  // The last known GitHub state of each tracked PR (canonical URL); MERGED is final.
  `CREATE TABLE pr_states (
    url TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    merged_at INTEGER,
    closed_at INTEGER,
    checked_at INTEGER NOT NULL,
    error TEXT
  )`,
  // R2 (W464): each PR's owner Initiative, by canonical URL.
  ...PR_OWNER_MIGRATIONS,
  // W468: a filed report's notice to its lead, checked against BB's event log until accepted.
  // One row per assignment; a filing of a different report starts it over under a new cycle id.
  // hash is the report's content, queued_id the BB queue row that still holds the latest send.
  `CREATE TABLE report_notices (
    project_id TEXT NOT NULL,
    assignment_num INTEGER NOT NULL,
    cycle TEXT NOT NULL,
    hash TEXT NOT NULL,
    lead_thread_id TEXT NOT NULL,
    queued_id TEXT,
    attempts INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    open INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (project_id, assignment_num)
  )`,
];

/** Store.openReviewOf: the same expressions and predicate as the assignments_open_review index. */
export const OPEN_REVIEW_QUERY = `SELECT * FROM assignments WHERE project_id = ? AND role = 'review'
  AND state IN ('dispatching', 'queued', 'running') AND json_extract(handoff_sources, '$[0].assignment') = ?
  AND json_extract(handoff_sources, '$[0].reportVersion') = ? ORDER BY num DESC LIMIT 1`;

export const ACTIVITY_LIMIT = 300;

export interface ProjectRecord {
  id: string;
  name: string;
  objective: string;
  memberProjectIds: string[];
  coordinatorThreadId: string | null;
  coordinatorGeneration: number;
  checkpoint: string | null;
  paused: boolean;
  /** Interrupted turn's timestamp while the coordinator hold is engaged. */
  coordinatorStoppedAt: number | null;
  /** Latest app-origin message to the coordinator; releases the hold. */
  coordinatorContinuedAt: number | null;
  policy: Policy;
  context: ProjectContext;
  /** The user's icon and color; null fields (or unknown stored values) mean the default look. */
  appearance: ProjectAppearance;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface TaskRecord {
  projectId: string;
  num: number;
  ref: string;
  title: string;
  summary: string;
  brief: Brief | null;
  /**
   * v9: the status shown and acted on: the hand-set one, else computed from the task's work and
   * its PRs (task-status.ts). The stored column holds only hand-set statuses (and planned).
   */
  status: TaskStatus;
  /** Why it has that status: "set by hand", "W1420 on A1641", "#2631 merged". */
  statusReason: string;
  /** When someone set the status by hand; null when it is computed. */
  statusSetAt: number | null;
  priority: number;
  dependsOn: number[];
  workKind: WorkKind;
  profileOverride: Profile | null;
  profileSource: "user" | "coordinator" | null;
  progress: string | null;
  nextCheckpoint: string | null;
  result: string | null;
  acceptedAssignment: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkerRecord {
  projectId: string;
  num: number;
  ref: string;
  role: Role;
  /** What the coordinator asked for on spawn; null for reviewers and workers from before kinds. */
  kind: WorkerKind | null;
  label: string;
  area: string;
  threadId: string | null;
  generation: number;
  bbProjectId: string;
  environmentId: string | null;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  state: WorkerState;
  retention: Retention | null;
  handoff: Handoff | null;
  forkedFrom: number | null;
  nativeParent: boolean;
  userStopped: boolean;
  interventionAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewTargetRecord { task: string; assignment: string; revision: string; worker: string; profile: Profile }
/** T150: the flag recording that the coordinator was told this assignment's thread failed. */
export const threadFailureKey = (projectId: string, num: number) => `failed:${projectId}:${num}`;
/** W468: one report notice's delivery: what was sent, to which lead, how often, and whether it is still being checked. */
export interface ReportNoticeCycle { projectId: string; num: number; cycle: string; hash: string; leadThreadId: string; queuedId: string | null; attempts: number; startedAt: number; sentAt: number }
/** T150: how the stop reason of work closed on a thread failure starts; a failed dispatch's never does. */
export const THREAD_FAILED = "Native thread failed, not retried: ";
/** T150: closed because its thread failed, so a report from that thread still reopens it. */
export const closedOnThreadFailure = (a: AssignmentRecord) => a.state === "failed" && !!a.stopReason?.startsWith(THREAD_FAILED);
export interface NativeNotice { state: "pending" | "sent" | "queued" | "failed" | "uncertain"; coordinatorThreadId: string; queuedId?: string; detail?: string }
const noticeSchema = z.object({ state: z.enum(["pending", "sent", "queued", "failed", "uncertain"]), coordinatorThreadId: z.string(), queuedId: z.string().optional(), detail: z.string().optional() }).strict();
export interface CheckpointRecord { recordedBy: string; recordedAt: number; sourceThreadId: string }
const reviewTargetsSchema = z.array(z.object({ task: z.string(), assignment: z.string(), revision: z.string(), worker: z.string(), profile: profileSchema }).strict());
const checkpointRecordSchema = z.object({ recordedBy: z.string(), recordedAt: z.number(), sourceThreadId: z.string() }).strict();
/**
 * Who released a listed-background hold, why, against which report version, and the
 * native evidence seen. Not evidence that the listed jobs finished.
 */
export interface ScopeRelease {
  by: "coordinator" | "user";
  recordedBy: string | null;
  reason: string;
  at: number;
  reportVersion: string;
  evidence: string;
}
// Pure: the dashboard bundle imports this module but never decodes assignments.
const scopeReleaseSchema = /* @__PURE__ */ z.object({
  by: z.enum(["coordinator", "user"]),
  recordedBy: z.string().nullable(),
  reason: z.string(),
  at: z.number(),
  reportVersion: z.string(),
  evidence: z.string(),
}).strict();

/** A prior report filing embedded in a brief as its standard handoff (T96). Provenance only. */
export interface HandoffSource {
  assignment: string;
  worker: string;
  generation: number;
  tasks: string[];
  state: string;
  reportVersion: string;
  revision: string;
}
const handoffSourcesSchema = /* @__PURE__ */ z.array(z.object({
  assignment: z.string(),
  worker: z.string(),
  generation: z.number(),
  tasks: z.array(z.string()),
  state: z.string(),
  reportVersion: z.string(),
  revision: z.string(),
}).strict());

export interface AssignmentRecord {
  projectId: string;
  num: number;
  ref: string;
  workerNum: number;
  taskNums: number[];
  route: Route;
  role: Role;
  access: AssignmentAccess;
  workKind: WorkKind | null;
  threadId: string | null;
  generation: number;
  profile: Profile;
  actualProfile: Profile | null;
  fingerprint: string | null;
  bbProjectId: string;
  environmentId: string | null;
  state: AssignmentState;
  opId: string;
  opState: "pending" | "done" | "uncertain" | "failed";
  queuedMessageId: string | null;
  briefText: string;
  briefDelivered: boolean;
  cancelRequested: boolean;
  reviewOf: number[] | null;
  reviewTargets: ReviewTargetRecord[] | null;
  checkpoint: CheckpointRecord | null;
  reportNotice: NativeNotice | null;
  rationale: string | null;
  reviewKey: "reviewOfClaude" | "reviewOfGpt" | null;
  /** A continue rename staged until its brief is proven delivered. */
  pendingIdentity: { label?: string; area?: string } | null;
  /** The label this assignment's brief named, fixed at creation; null on rows from before T143. */
  label: string | null;
  /**
   * v9: the lead tab that gave this work out (the coordinator tab for anything else). The
   * previous build never writes it, so NULL marks work given out under the old protocol.
   */
  replyTo: string | null;
  /**
   * Declared write paths in bbProjectId, snapshotted when the assignment was
   * dispatched or checkpointed; later brief edits never change it. null for
   * records made before T91: their scope is unknown and treated as the whole project.
   */
  writeScope: string[] | null;
  /** An explicit release of the hold kept by this report's listed background work. */
  scopeRelease: ScopeRelease | null;
  /** Prior handoffs embedded in this brief at dispatch; null when none. */
  handoffSources: HandoffSource[] | null;
  report: Report | null;
  /**
   * How many times a report was stored for this assignment, identical re-files
   * included. Part of the report version a scope release binds to; 0 for
   * reports stored before it was counted.
   */
  reportSeq: number;
  reportedAt: number | null;
  stopReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** T136: a generated (or user-edited) handover waiting to become a new coordinator's first message. */
export interface HandoverDraft {
  projectId: string;
  /** requested: waits for its writer to start (a note may be saved); generating: Luna is writing; ready: text is final. */
  state: "requested" | "generating" | "ready";
  /** Optional note from the outgoing coordinator or user, given to the writer. */
  note: string | null;
  text: string | null;
  source: "luna" | "fallback" | "user" | null;
  /** The short-lived writer thread while generating. */
  threadId: string | null;
  /** Why a fallback was used, or the writer's state. */
  detail: string | null;
  /** The plain listing to use when the writer fails, built when the writer started. */
  fallback?: string | null;
  /** What the text was written from (incumbent, message high-water marks, ledger activity); a change means it is stale. */
  fingerprint?: string | null;
  /** When its snapshot was captured. */
  capturedAt?: number | null;
  /**
   * preview: captured before a replacement could run; replacement: captured once it could;
   * final: a replacement draft written again (lib/handover-snapshot.ts fingerprintHolds).
   */
  purpose?: "preview" | "replacement" | "final" | null;
  /** A replacement to start as soon as the text is ready. */
  thenReplace: { reason: string; profile?: Profile; environment?: EnvironmentChoice; expectedCoordinator?: string | null } | null;
  createdAt: number;
  updatedAt: number;
}

function toDraft(row: Row): HandoverDraft {
  return {
    projectId: String(row.project_id),
    state: row.state as HandoverDraft["state"],
    note: (row.note as string | null) ?? null,
    text: (row.text as string | null) ?? null,
    source: (row.source as HandoverDraft["source"]) ?? null,
    threadId: (row.thread_id as string | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    thenReplace: row.then_replace ? JSON.parse(String(row.then_replace)) : null,
    fallback: (row.fallback as string | null | undefined) ?? null,
    fingerprint: (row.fingerprint as string | null | undefined) ?? null,
    capturedAt: (row.captured_at as number | null | undefined) ?? null,
    purpose: (row.purpose as HandoverDraft["purpose"] | undefined) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * A durable request to replace the coordinator once its turn ends. One row per
 * project: a repeat request updates it, and the recorded predecessor decides
 * whether it is still current.
 */
export interface HandoverRecord {
  projectId: string;
  /** The coordinator this request supersedes; a change here drops the request. */
  threadId: string | null;
  reason: string;
  /** Explicit replacement profile; null preserves the predecessor's effective one. */
  profile: Profile | null;
  /** Explicit replacement environment; null inherits the incumbent's. */
  environment: EnvironmentChoice | null;
  requestedBy: "coordinator" | "user";
  state: "pending" | "failed";
  /** While pending: why the drain is currently holding. Terminal: why it failed. */
  detail: string | null;
  /** Bumps on every upsert; the drain only settles the revision it re-read last. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type DecisionStatus =
  "active" | "superseded" | "answered" | "closed" | "withdrawn" | "removed";

export interface Provenance {
  author: "coordinator" | "worker" | "user";
  threadId: string | null;
  assignment: number | null;
}

export interface DecisionRecord {
  projectId: string;
  num: number;
  ref: string;
  topic: string;
  version: number;
  status: DecisionStatus;
  scope: string;
  title: string;
  /** User choices, agent choices, and unanswered requests retain their author. */
  body: DecisionBody;
  humanAttention: HumanAttention;
  blocks: number[];
  deadline: string | null;
  provenance: Provenance;
  madeBy: "user" | "agent" | null;
  review: "pending" | "okay" | "not-okay" | null;
  description: string;
  reviewMessage: string | null;
  notification: { state: "pending" | "sent" | "queued" | "uncertain" | "failed"; op: string; coordinatorThreadId: string | null; queuedId?: string; detail?: string } | null;
  supersedes: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RefStatus { num: number; kind: string; status: string; question: boolean; madeBy: "user" | "agent" | null; review: string | null; supersededBy: number | null }

/** T132: one native delivery to a thread other than the coordinator (a worker), with its receipt. */
export type Delivery = { op: string; state: "pending" | "sent" | "queued" | "uncertain" | "failed"; threadId: string; queuedId?: string; detail?: string };

export type DecisionBody = (Decision | { description: string }) & {
  /** recordedBy: the agent that recorded the user's explicit chat answer. to: a blocker answer sent straight to the worker (T130). */
  answer?: { choice: string | null; note: string; at: number; recordedBy?: Provenance; to?: "worker"; delivery?: Delivery };
  /** D386: the user's answer to this assignment's blocked report, keyed by its blocker question. */
  blocker?: { assignment: number; question: string; context: string };
  /** T128: the user dismissed that blocker instead of answering; notify sent a note to the coordinator. undoneAt: the user took it back. */
  dismissal?: { note: string; notify: boolean; at: number; undoneAt?: number };
  /** User closure, or with withdrawnBy the coordinator's own withdrawal (D340); note is the reason. Never an answer. */
  resolution?: { note: string; at: number; withdrawnBy?: Provenance };
  cleanupHistory?: { operation: "accept" | "veto" | "remove"; reason: string; recordedBy: string; at: number }[];
};

export interface UpdateRecord {
  projectId: string;
  num: number;
  ref: string;
  summary: string;
  body: string;
  threadId: string | null;
  createdAt: number;
}

export type InboxPriority = "routine" | "normal" | "urgent";
export interface InboxRecord {
  id: number;
  projectId: string;
  eventKey: string;
  kind: string;
  priority: InboxPriority;
  summary: string;
  payload: Record<string, unknown>;
  state: "pending" | "sending" | "delivered" | "dropped";
  batchId: number | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface BatchRecord {
  id: number;
  projectId: string;
  coordinatorThreadId: string;
  marker: string;
  text: string;
  mode: string;
  state: "sending" | "sent" | "uncertain" | "failed";
  createdAt: number;
  sentAt: number | null;
}

export interface ActivityRecord {
  id: number;
  projectId: string;
  at: number;
  kind: string;
  summary: string;
  ref: Record<string, unknown> | null;
}

export interface TokenTotals {
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
}

export interface ObservedProfile {
  providerId: string | null;
  model: string | null;
  at: number;
}
export interface ProfileObservation {
  first: ObservedProfile;
  last: ObservedProfile;
  mixed: boolean;
}
export interface UsageTurn {
  turnId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  status: string | null;
}

export interface UsageRecord {
  threadId: string;
  projectId: string;
  workerNum: number;
  lastSeq: number;
  providerThreadId: string | null;
  sessionTotals: TokenTotals | null;
  closedTotals: TokenTotals;
  resets: number;
  lastReportAt: number | null;
  contextUsed: number | null;
  contextWindow: number | null;
  contextEstimated?: boolean | null;
  contextChangedAt?: number | null;
  model: string | null;
  contextObservedAt?: number | null;
  firstObservedAt?: number | null;
  lastObservedAt?: number | null;
  profileObservation?: ProfileObservation | null;
  updatedAt: number;
}

export interface LeaseRecord {
  id: number;
  projectId: string;
  workerNum: number;
  threadId: string;
  generation: number;
  fingerprint: string | null;
  state: "active" | "unsupported" | "ended";
  reason: string;
  maxRefreshes: number;
  refreshes: number;
  deadline: number;
  capability: string;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
}

export const taskRef = (num: number) => `T${num}`;
export const ruleRef = (num: number) => `R${num}`;

/** A standing rule (D523): one or two sentences every lead and worker follows. */
export interface RuleRecord {
  projectId: string;
  num: number;
  ref: string;
  text: string;
  position: number;
  /** Where it came from, e.g. the decisions it replaces (D12). */
  sources: string[];
  createdAt: number;
  updatedAt: number;
  removedAt: number | null;
}

/** A tracked PR's last known GitHub state. */
export interface PrStateRecord {
  url: string;
  state: Exclude<PrState, null>;
  mergedAt: number | null;
  closedAt: number | null;
  checkedAt: number;
  error: string | null;
}
export const workerRef = (num: number) =>
  num === 0 ? "coordinator" : `W${num}`;
export const assignmentRef = (num: number) => `A${num}`;
export const decisionRef = (num: number) => `D${num}`;
export const updateRef = (num: number) => `U${num}`;

/** Stored JSON for a best-effort scan; malformed text reads as nothing. */
function parseStored(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** Parse a user- or model-supplied ref such as "T12", "t12", or "12". */
export function parseRef(
  prefix: "T" | "W" | "A" | "K" | "D" | "U",
  value: string | number,
): number | null {
  if (typeof value === "number")
    return Number.isInteger(value) && value > 0 ? value : null;
  const match = new RegExp(`^${prefix}?(\\d+)$`, "i").exec(value.trim());
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/** Plugin-owned data that fails to decode is a bug or corruption, never a default. */
export class StoreCorruptionError extends Error {
  override name = "StoreCorruptionError";
}

/** The knowledge rows that are decisions, removed ones included. */
const DECISION = "kind='decision' AND status IN ('active','answered','superseded','closed','withdrawn','removed') AND (decision_owner IS NOT NULL OR (human_attention='needs-opinion' AND status IN ('active','closed','withdrawn')))";

const rowKey = (row: Row) =>
  row.project_id !== undefined && row.num !== undefined
    ? `${String(row.project_id)}/${String(row.num)}`
    : String(row.id ?? row.thread_id ?? "?");

function decode<S extends z.ZodType>(
  table: string,
  row: Row,
  column: string,
  schema: S,
): z.output<S> {
  const where = `${table}[${rowKey(row)}].${column}`;
  const value = row[column];
  if (typeof value !== "string")
    throw new StoreCorruptionError(
      `${where}: expected JSON text, found ${value === null ? "NULL" : typeof value}`,
    );
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch (error) {
    throw new StoreCorruptionError(
      `${where}: malformed JSON (${(error as Error).message})`,
    );
  }
  const result = schema.safeParse(data);
  if (!result.success)
    throw new StoreCorruptionError(
      `${where}: ${result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`,
    );
  return result.data;
}

function decodeNullable<S extends z.ZodType>(
  table: string,
  row: Row,
  column: string,
  schema: S,
): z.output<S> | null {
  return row[column] === null || row[column] === undefined
    ? null
    : decode(table, row, column, schema);
}

const idsSchema = z.array(z.string().min(1));
const numsSchema = z.array(z.number().int().positive());
const pendingIdentitySchema = z
  .object({ label: z.string(), area: z.string() })
  .partial()
  .strict();
const totalsSchema = z
  .object({
    input: z.number().nullable(),
    cachedInput: z.number().nullable(),
    output: z.number().nullable(),
    reasoningOutput: z.number().nullable(),
    total: z.number().nullable(),
  })
  .strict();
const observedProfileSchema = z.object({
  providerId: z.string().nullable(), model: z.string().nullable(), at: z.number(),
}).strict();
const profileObservationSchema = z.object({
  first: observedProfileSchema, last: observedProfileSchema, mixed: z.boolean(),
}).strict();
const provenanceSchema = z
  .object({
    author: z.enum(["coordinator", "worker", "user"]),
    threadId: z.string().nullable(),
    assignment: z.number().int().nullable(),
  })
  .strict();
const cleanupHistorySchema = z.array(z.object({ operation: z.enum(["accept", "veto", "remove"]), reason: z.string(), recordedBy: z.string(), at: z.number() }).strict()).optional();
const legacyDecisionBodySchema = decisionFieldsSchema.extend({
  cleanupHistory: cleanupHistorySchema,
  answer: z.object({ choice: z.string().nullable(), note: z.string(), at: z.number(), recordedBy: provenanceSchema.optional() }).strict().optional(),
  resolution: z.object({ note: z.string(), at: z.number(), withdrawnBy: provenanceSchema.optional() }).strict().optional(),
});
/** D386: the user's Inbox answer to a blocked report. */
const blockerAnswerBodySchema = z.object({
  description: z.string(), cleanupHistory: cleanupHistorySchema,
  blocker: z.object({ assignment: z.number().int(), question: z.string(), context: z.string() }).strict(),
  answer: z.object({
    choice: z.null(), note: z.string(), at: z.number(), to: z.literal("worker").optional(),
    /** T132: the worker's own receipt; the decision's notification is then the coordinator FYI. */
    delivery: z.object({ op: z.string(), state: z.enum(["pending", "sent", "queued", "uncertain", "failed"]), threadId: z.string(), queuedId: z.string().optional(), detail: z.string().optional() }).strict().optional(),
  }).strict(),
}).strict();
/** T128: the user's Inbox dismissal of a blocked report, keyed like an answer. */
const blockerDismissalBodySchema = z.object({
  description: z.string(), cleanupHistory: cleanupHistorySchema,
  blocker: z.object({ assignment: z.number().int(), question: z.string(), context: z.string() }).strict(),
  dismissal: z.object({ note: z.string(), notify: z.boolean(), at: z.number(), undoneAt: z.number().optional() }).strict(),
}).strict();
const decisionBodySchema = z.union([z.object({ description: z.string(), cleanupHistory: cleanupHistorySchema }).strict(), blockerAnswerBodySchema, blockerDismissalBodySchema, legacyDecisionBodySchema]);
const objectSchema = z.record(z.string(), z.unknown());

const json = (value: unknown) =>
  value === null || value === undefined ? null : JSON.stringify(value);

type Row = Record<string, unknown>;

function toProject(row: Row): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    objective: String(row.objective),
    memberProjectIds: decode("projects", row, "member_project_ids", idsSchema),
    coordinatorThreadId: (row.coordinator_thread_id as string | null) ?? null,
    coordinatorGeneration: Number(row.coordinator_generation),
    checkpoint: (row.checkpoint as string | null) ?? null,
    paused: row.paused === 1,
    coordinatorStoppedAt:
      (row.coordinator_stopped_at as number | null) ?? null,
    coordinatorContinuedAt:
      (row.coordinator_continued_at as number | null) ?? null,
    policy: decode("projects", row, "policy", storedPolicySchema),
    context: decode("projects", row, "context", projectContextSchema),
    appearance: readAppearance(row.appearance),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: (row.archived_at as number | null) ?? null,
  };
}

/** Lenient by design: appearance is cosmetic, so a legacy or unknown stored value reads as the default instead of failing the record. */
function readAppearance(raw: unknown): ProjectAppearance {
  if (typeof raw !== "string") return { icon: null, color: null };
  try {
    const v = JSON.parse(raw) as { icon?: unknown; color?: unknown };
    return {
      icon: (PROJECT_ICONS as readonly unknown[]).includes(v?.icon) ? (v.icon as string) : null,
      color: (PROJECT_COLORS as readonly unknown[]).includes(v?.color) ? (v.color as string) : null,
    };
  } catch {
    return { icon: null, color: null };
  }
}

function toProjectThread(row: Row): ProjectThreadRecord {
  return {
    projectId: String(row.project_id),
    opId: String(row.op_id),
    threadId: (row.thread_id as string | null) ?? null,
    label: String(row.label),
    bbProjectId: (row.bb_project_id as string | null) ?? null,
    state: row.state as ProjectThreadRecord["state"],
    discussion: Number(row.discussion ?? 0) === 1,
    createdAt: Number(row.created_at),
    confirmedAt: (row.confirmed_at as number | null) ?? null,
  };
}

function toRule(row: Row): RuleRecord {
  const num = Number(row.num);
  return {
    projectId: String(row.project_id),
    num,
    ref: ruleRef(num),
    text: String(row.text),
    position: Number(row.position),
    sources: decode("rules", row, "sources", z.array(z.string())),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    removedAt: row.removed_at == null ? null : Number(row.removed_at),
  };
}

function toTask(row: Row): TaskRecord {
  const num = Number(row.num);
  return {
    projectId: String(row.project_id),
    num,
    ref: taskRef(num),
    title: String(row.title),
    summary: String(row.summary),
    brief: decodeNullable("tasks", row, "brief", briefSchema),
    status: row.status as TaskStatus,
    statusReason: row.status_set_at == null ? "" : "set by hand",
    statusSetAt: row.status_set_at == null ? null : Number(row.status_set_at),
    priority: Number(row.priority),
    dependsOn: decode("tasks", row, "depends_on", numsSchema),
    workKind: row.work_kind as WorkKind,
    profileOverride: decodeNullable(
      "tasks",
      row,
      "profile_override",
      profileSchema,
    ),
    profileSource: (row.profile_source as TaskRecord["profileSource"]) ?? null,
    progress: (row.progress as string | null) ?? null,
    nextCheckpoint: (row.next_checkpoint as string | null) ?? null,
    result: (row.result as string | null) ?? null,
    acceptedAssignment: (row.accepted_assignment as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toWorker(row: Row): WorkerRecord {
  const num = Number(row.num);
  return {
    projectId: String(row.project_id),
    num,
    ref: workerRef(num),
    role: row.role as Role,
    kind: row.kind ? canonicalWorkerKind(row.kind as string) : null,
    label: String(row.label),
    area: String(row.area),
    threadId: (row.thread_id as string | null) ?? null,
    generation: Number(row.generation),
    bbProjectId: String(row.bb_project_id),
    environmentId: (row.environment_id as string | null) ?? null,
    providerId: (row.provider_id as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    reasoningLevel: (row.reasoning_level as string | null) ?? null,
    state: row.state as WorkerState,
    retention: decodeNullable("workers", row, "retention", retentionSchema),
    handoff: decodeNullable("workers", row, "handoff", handoffSchema),
    forkedFrom: (row.forked_from as number | null) ?? null,
    nativeParent: row.native_parent === 1,
    userStopped: row.user_stopped === 1,
    interventionAt: (row.intervention_at as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toAssignment(row: Row): AssignmentRecord {
  const num = Number(row.num);
  return {
    projectId: String(row.project_id),
    num,
    ref: assignmentRef(num),
    workerNum: Number(row.worker_num),
    taskNums: decode("assignments", row, "task_nums", numsSchema),
    route: row.route as Route,
    role: row.role as Role,
    access: row.role === "review" || row.access === "read-only" ? "read-only" : "write",
    workKind: (row.work_kind as WorkKind | null) ?? null,
    threadId: (row.thread_id as string | null) ?? null,
    generation: Number(row.generation),
    profile: decode("assignments", row, "profile", profileSchema),
    actualProfile: decodeNullable(
      "assignments",
      row,
      "actual_profile",
      profileSchema,
    ),
    fingerprint: (row.fingerprint as string | null) ?? null,
    bbProjectId: String(row.bb_project_id),
    environmentId: (row.environment_id as string | null) ?? null,
    state: row.state as AssignmentState,
    opId: String(row.op_id),
    opState: row.op_state as AssignmentRecord["opState"],
    queuedMessageId: (row.queued_message_id as string | null) ?? null,
    briefText: String(row.brief_text),
    briefDelivered: Boolean(row.brief_delivered),
    cancelRequested: Boolean(row.cancel_requested),
    reviewOf: decodeNullable("assignments", row, "review_of", numsSchema),
    reviewTargets: decodeNullable("assignments", row, "review_targets", reviewTargetsSchema),
    checkpoint: decodeNullable("assignments", row, "checkpoint", checkpointRecordSchema),
    reportNotice: decodeNullable("assignments", row, "report_notice", noticeSchema),
    rationale: (row.rationale as string | null) ?? null,
    reviewKey: (row.review_key as AssignmentRecord["reviewKey"]) ?? null,
    pendingIdentity: decodeNullable(
      "assignments",
      row,
      "pending_identity",
      pendingIdentitySchema,
    ),
    label: (row.label as string | null) ?? null,
    replyTo: (row.reply_to as string | null) ?? null,
    writeScope: decodeNullable("assignments", row, "write_scope", z.array(z.string())),
    scopeRelease: decodeNullable("assignments", row, "scope_release", scopeReleaseSchema),
    handoffSources: decodeNullable("assignments", row, "handoff_sources", handoffSourcesSchema),
    reportSeq: Number(row.report_seq ?? 0),
    report: decodeNullable("assignments", row, "report", storedReportSchema),
    reportedAt: (row.reported_at as number | null) ?? null,
    stopReason: (row.stop_reason as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function decisionDescription(body: DecisionBody, humanAttention?: HumanAttention): string {
  if (body.answer) return [body.answer.choice, body.answer.note].filter(Boolean).join(" · ");
  if ("description" in body) return body.description;
  // A question reads as its question; a legacy proposed outcome is not the user's choice.
  return humanAttention === "needs-opinion" ? body.question ?? body.outcome ?? body.title : body.outcome ?? body.question ?? body.title;
}

function toDecision(row: Row): DecisionRecord {
  const num = Number(row.num);
  return {
    projectId: String(row.project_id),
    num,
    ref: decisionRef(num),
    topic: String(row.topic),
    version: Number(row.version),
    status: row.status as DecisionStatus,
    scope: String(row.scope),
    title: String(row.title),
    body: decode("knowledge", row, "body", decisionBodySchema),
    humanAttention: row.human_attention as HumanAttention,
    blocks: decode("knowledge", row, "blocks", numsSchema),
    deadline: (row.deadline as string | null) ?? null,
    provenance: decode("knowledge", row, "provenance", provenanceSchema),
    madeBy: row.decision_owner as DecisionRecord["madeBy"],
    review: row.decision_review as DecisionRecord["review"],
    reviewMessage: row.decision_review_message as string | null,
    notification: decodeNullable("knowledge", row, "decision_notification", z.object({
      state: z.enum(["pending", "sent", "queued", "uncertain", "failed"]), op: z.string(), coordinatorThreadId: z.string().nullable(), queuedId: z.string().optional(), detail: z.string().optional(),
    }).strict()),
    description: decisionDescription(decode("knowledge", row, "body", decisionBodySchema), row.human_attention as HumanAttention),
    supersedes: (row.supersedes as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toInbox(row: Row): InboxRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    eventKey: String(row.event_key),
    kind: String(row.kind),
    priority: row.priority as InboxPriority,
    summary: String(row.summary),
    payload: decode("inbox", row, "payload", objectSchema),
    state: row.state as InboxRecord["state"],
    batchId: (row.batch_id as number | null) ?? null,
    createdAt: Number(row.created_at),
    deliveredAt: (row.delivered_at as number | null) ?? null,
  };
}

function toUsage(row: Row): UsageRecord {
  return {
    threadId: String(row.thread_id),
    projectId: String(row.project_id),
    workerNum: Number(row.worker_num),
    lastSeq: Number(row.last_seq),
    providerThreadId: (row.provider_thread_id as string | null) ?? null,
    sessionTotals: decodeNullable("usage", row, "session_totals", totalsSchema),
    closedTotals: decode("usage", row, "closed_totals", totalsSchema),
    resets: Number(row.resets),
    lastReportAt: (row.last_report_at as number | null) ?? null,
    contextUsed: (row.context_used as number | null) ?? null,
    contextWindow: (row.context_window as number | null) ?? null,
    contextEstimated:
      row.context_estimated === null || row.context_estimated === undefined
        ? null
        : Boolean(row.context_estimated),
    contextChangedAt: (row.context_changed_at as number | null) ?? null,
    model: (row.model as string | null) ?? null,
    contextObservedAt: (row.context_observed_at as number | null) ?? null,
    firstObservedAt: (row.first_observed_at as number | null) ?? null,
    lastObservedAt: (row.last_observed_at as number | null) ?? null,
    profileObservation: decodeNullable("usage", row, "profile_observation", profileObservationSchema),
    updatedAt: Number(row.updated_at),
  };
}

function toHandover(row: Row): HandoverRecord {
  return {
    projectId: String(row.project_id),
    threadId: (row.thread_id as string | null) ?? null,
    reason: String(row.reason),
    profile: decodeNullable("coordinator_handovers", row, "profile", profileSchema),
    environment: decodeNullable(
      "coordinator_handovers",
      row,
      "environment",
      environmentSchema,
    ),
    requestedBy: row.requested_by as HandoverRecord["requestedBy"],
    state: row.state as HandoverRecord["state"],
    detail: (row.detail as string | null) ?? null,
    revision: Number(row.revision ?? 1),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toLease(row: Row): LeaseRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    workerNum: Number(row.worker_num),
    threadId: String(row.thread_id),
    generation: Number(row.generation),
    fingerprint: (row.fingerprint as string | null) ?? null,
    state: row.state as LeaseRecord["state"],
    reason: String(row.reason),
    maxRefreshes: Number(row.max_refreshes),
    refreshes: Number(row.refreshes),
    deadline: Number(row.deadline),
    capability: String(row.capability),
    createdAt: Number(row.created_at),
    endedAt: (row.ended_at as number | null) ?? null,
    endReason: (row.end_reason as string | null) ?? null,
  };
}

export const zeroTotals = (): TokenTotals => ({
  input: 0,
  cachedInput: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
});

/** Who a thread is to a project: its coordinator (worker 0) or a worker. */
export interface Membership {
  project: ProjectRecord;
  /**
   * 0 = coordinator, >0 = managed worker, -1 = a user-owned project thread.
   * `kind` is the readable discriminator; workerNum stays for callers that
   * only need to distinguish coordinator (0) from managed workers (>0).
   */
  workerNum: number;
  kind: "coordinator" | "worker" | "adhoc";
  /** T149 (D446): a user thread (adhoc) started as a discussion of the Initiative. */
  discussion?: boolean;
  worker: WorkerRecord | null;
  /** True for a superseded coordinator or a superseded worker generation. */
  former: boolean;
}

export interface ProjectThreadRecord {
  projectId: string;
  opId: string;
  threadId: string | null;
  label: string;
  bbProjectId: string | null;
  state: "pending" | "active" | "uncertain" | "failed";
  /** T149 (D446): started as a discussion, which shares the Initiative's memory. */
  discussion: boolean;
  createdAt: number;
  confirmedAt: number | null;
}

const toNoticeCycle = (row: Row): ReportNoticeCycle => ({ projectId: String(row.project_id), num: Number(row.assignment_num), cycle: String(row.cycle), hash: String(row.hash), leadThreadId: String(row.lead_thread_id), queuedId: row.queued_id === null ? null : String(row.queued_id), attempts: Number(row.attempts), startedAt: Number(row.started_at), sentAt: Number(row.sent_at) });

export class Store {
  constructor(
    readonly db: Database.Database,
    private readonly clock: () => number = Date.now,
  ) {}

  now() {
    return this.clock();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private nextNum(table: string, projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(num), 0) + 1 AS next FROM ${table} WHERE project_id = ?`,
      )
      .get(projectId) as { next: number };
    return row.next;
  }

  // Initiatives ---------------------------------------------------------------

  createProject(input: {
    id: string;
    name: string;
    objective: string;
    memberProjectIds: string[];
    coordinatorThreadId: string | null;
    policy?: Policy;
  }): ProjectRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, objective, member_project_ids, coordinator_thread_id, coordinator_generation, paused, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.objective,
        JSON.stringify(input.memberProjectIds),
        input.coordinatorThreadId,
        input.coordinatorThreadId ? 1 : 0,
        JSON.stringify(input.policy ?? DEFAULT_POLICY),
        now,
        now,
      );
    if (input.coordinatorThreadId)
      this.openGeneration(input.id, 0, 1, input.coordinatorThreadId);
    return this.project(input.id)!;
  }

  project(id: string): ProjectRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toProject(row) : null;
  }

  projects(includeArchived = false): ProjectRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM projects ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY updated_at DESC`,
        )
        .all() as Row[]
    ).map(toProject);
  }

  updateProject(
    id: string,
    patch: Partial<
      Pick<
        ProjectRecord,
        | "name"
        | "objective"
        | "memberProjectIds"
        | "checkpoint"
        | "paused"
        | "coordinatorStoppedAt"
        | "coordinatorContinuedAt"
        | "policy"
        | "context"
        | "archivedAt"
      >
    >,
  ) {
    const current = this.project(id);
    if (!current) throw new Error(`Unknown Initiative ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, objective = ?, member_project_ids = ?, checkpoint = ?, paused = ?, coordinator_stopped_at = ?, coordinator_continued_at = ?, policy = ?, context = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.objective,
        JSON.stringify(next.memberProjectIds),
        next.checkpoint,
        next.paused ? 1 : 0,
        next.coordinatorStoppedAt,
        next.coordinatorContinuedAt,
        JSON.stringify(next.policy),
        JSON.stringify(next.context),
        next.archivedAt,
        this.now(),
        id,
      );
    return this.project(id)!;
  }

  /** Cosmetic only: no updated_at bump, so list order and identity stay where they were. */
  setAppearance(id: string, appearance: ProjectAppearance) {
    const stored = appearance.icon === null && appearance.color === null ? null : JSON.stringify(appearance);
    this.db.prepare(`UPDATE projects SET appearance = ? WHERE id = ?`).run(stored, id);
    return this.project(id)!;
  }

  // User-owned project threads -------------------------------------------------

  openProjectThread(record: {
    projectId: string;
    opId: string;
    label: string;
    bbProjectId: string | null;
    discussion?: boolean;
  }) {
    this.db
      .prepare(
        `INSERT INTO project_threads (project_id, op_id, label, bb_project_id, state, discussion, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        record.projectId,
        record.opId,
        record.label,
        record.bbProjectId,
        Number(record.discussion ?? false),
        this.now(),
      );
  }

  /**
   * Associate an existing native thread with the project: no create op, no
   * first-message requirement — the row only names the association for
   * membership and navigation. False when the thread is already claimed
   * (thread_id is UNIQUE across projects, so first association wins).
   */
  associateProjectThread(record: {
    projectId: string;
    opId: string;
    threadId: string;
    label: string;
    bbProjectId: string | null;
  }): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO project_threads (project_id, op_id, thread_id, label, bb_project_id, state, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          record.projectId,
          record.opId,
          record.threadId,
          record.label,
          record.bbProjectId,
          this.now(),
          this.now(),
        ).changes > 0
    );
  }

  projectThreadByThreadId(threadId: string): ProjectThreadRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM project_threads WHERE thread_id = ?`)
      .get(threadId) as Row | undefined;
    return row ? toProjectThread(row) : null;
  }

  /** Follow a native thread's current title when it changes. */
  refreshProjectThreadLabel(threadId: string, label: string) {
    this.db
      .prepare(
        `UPDATE project_threads SET label = ? WHERE thread_id = ? AND label != ?`,
      )
      .run(label, threadId, label);
  }

  // Nested descendants ------------------------------------------------------

  /**
   * Claim a deeper native descendant for project selection and tool
   * membership. Nested children get no project_threads row — they are not
   * user project threads — but selection must resolve their durable project
   * when BB repositories overlap. thread_id is UNIQUE, so first claim wins.
   */
  associateNestedThread(record: {
    projectId: string;
    threadId: string;
    label: string;
    bbProjectId: string | null;
  }): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO project_nested_threads (project_id, thread_id, label, bb_project_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          record.projectId,
          record.threadId,
          record.label,
          record.bbProjectId,
          this.now(),
        ).changes > 0
    );
  }

  nestedProjectThreads(
    projectId: string,
  ): { threadId: string; label: string; bbProjectId: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM project_nested_threads WHERE project_id = ? ORDER BY created_at`,
      )
      .all(projectId) as Row[];
    return rows.map((row) => ({
      threadId: String(row.thread_id),
      label: String(row.label),
      bbProjectId: (row.bb_project_id as string | null) ?? null,
    }));
  }

  nestedThreadByThreadId(threadId: string): {
    projectId: string;
    threadId: string;
    label: string;
    bbProjectId: string | null;
  } | null {
    const row = this.db
      .prepare(`SELECT * FROM project_nested_threads WHERE thread_id = ?`)
      .get(threadId) as Row | undefined;
    return row
      ? {
          projectId: String(row.project_id),
          threadId: String(row.thread_id),
          label: String(row.label),
          bbProjectId: (row.bb_project_id as string | null) ?? null,
        }
      : null;
  }

  refreshNestedThreadLabel(threadId: string, label: string) {
    this.db
      .prepare(
        `UPDATE project_nested_threads SET label = ? WHERE thread_id = ? AND label != ?`,
      )
      .run(label, threadId, label);
  }

  /** Binds a created thread to its journaled op; false if already settled. */
  confirmProjectThread(opId: string, threadId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE project_threads SET thread_id = ?, state = 'active', confirmed_at = ? WHERE op_id = ? AND state IN ('pending', 'uncertain')`,
        )
        .run(threadId, this.now(), opId).changes > 0
    );
  }

  markProjectThread(opId: string, state: "uncertain" | "failed") {
    this.db
      .prepare(
        `UPDATE project_threads SET state = ? WHERE op_id = ? AND state IN ('pending', 'uncertain')`,
      )
      .run(state, opId);
  }

  projectThreadByOp(opId: string): ProjectThreadRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM project_threads WHERE op_id = ?`)
      .get(opId) as Row | undefined;
    return row ? toProjectThread(row) : null;
  }

  projectThreads(projectId: string): ProjectThreadRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM project_threads WHERE project_id = ? ORDER BY created_at`,
        )
        .all(projectId) as Row[]
    ).map(toProjectThread);
  }

  /** Open create operations awaiting a native receipt. */
  pendingProjectThreads(): ProjectThreadRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM project_threads WHERE state IN ('pending', 'uncertain')`,
        )
        .all() as Row[]
    ).map(toProjectThread);
  }

  /**
   * Atomically confirm a coordinator start whose awaited home validation
   * already passed: the same operation must still be pending or uncertain,
   * the candidate already recorded for it (if any) must be this thread, and
   * the primary member the home was proven against must still be current.
   * Anything else means the validated facts went stale mid-await —
   * "superseded", and no authority is granted.
   */
  confirmCoordinatorReceipt(
    projectId: string,
    op: string,
    threadId: string,
    expectedPrimary: string,
    reason: string,
  ): "confirmed" | "superseded" {
    return this.tx(() => {
      const start = this.db
        .prepare(
          "SELECT state, thread_id FROM coordinator_starts WHERE project_id=? AND op_id=?",
        )
        .get(projectId, op) as
        | { state: string; thread_id: string | null }
        | undefined;
      if (!start) return "superseded";
      if (start.state === "done")
        return start.thread_id === threadId ? "confirmed" : "superseded";
      if (!["pending", "uncertain"].includes(start.state)) return "superseded";
      if (start.thread_id && start.thread_id !== threadId)
        return "superseded";
      const current = this.project(projectId);
      if (!current || current.memberProjectIds[0] !== expectedPrimary)
        return "superseded";
      if (current.coordinatorThreadId !== threadId)
        this.setCoordinator(projectId, threadId, reason);
      this.db
        .prepare(
          "UPDATE coordinator_starts SET state='done',thread_id=? WHERE project_id=? AND op_id=?",
        )
        .run(threadId, projectId, op);
      return "confirmed";
    });
  }

  setCoordinator(id: string, threadId: string, reason: string) {
    const project = this.project(id);
    if (!project) throw new Error(`Unknown Initiative ${id}`);
    const generation = project.coordinatorGeneration + 1;
    this.closeGeneration(id, 0, reason);
    this.db
      .prepare(
        `UPDATE projects SET coordinator_thread_id = ?, coordinator_generation = ?, coordinator_stopped_at = NULL, coordinator_continued_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(threadId, generation, this.now(), id);
    this.openGeneration(id, 0, generation, threadId);
    // A retained native parent now points at the former coordinator. Reports
    // must wake the new coordinator through Initiatives rather than rely on that notice.
    this.db
      .prepare(
        "UPDATE workers SET native_parent=0 WHERE project_id=? AND native_parent=1",
      )
      .run(id);
    return this.project(id)!;
  }

  touchProject(id: string) {
    this.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
      .run(this.now(), id);
  }

  // Coordinator handovers -----------------------------------------------------
  // The request is journal-like: it outlives restarts and resolves only through
  // the lifecycle drain, never inside the requesting call itself.

  upsertHandover(input: {
    projectId: string;
    threadId: string | null;
    reason: string;
    profile: Profile | null;
    environment: EnvironmentChoice | null;
    requestedBy: HandoverRecord["requestedBy"];
  }): HandoverRecord {
    const now = this.now();
    this.tx(() => {
      // Durable per-project sequence: every upsert consumes a fresh revision,
      // so a delete-and-recreate can never alias an earlier in-flight drain.
      this.db
        .prepare(
          `INSERT INTO handover_counters (project_id, next_revision) VALUES (?, 0)
           ON CONFLICT(project_id) DO NOTHING`,
        )
        .run(input.projectId);
      this.db
        .prepare(
          `UPDATE handover_counters SET next_revision = next_revision + 1 WHERE project_id = ?`,
        )
        .run(input.projectId);
      const { next_revision: revision } = this.db
        .prepare(
          `SELECT next_revision FROM handover_counters WHERE project_id = ?`,
        )
        .get(input.projectId) as { next_revision: number };
      this.db
        .prepare(
          `INSERT INTO coordinator_handovers (project_id, thread_id, reason, profile, environment, requested_by, state, detail, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET thread_id=excluded.thread_id, reason=excluded.reason, profile=excluded.profile, environment=excluded.environment, requested_by=excluded.requested_by, state='pending', detail=NULL, updated_at=excluded.updated_at, revision=excluded.revision`,
        )
        .run(
          input.projectId,
          input.threadId,
          input.reason,
          json(input.profile),
          json(input.environment),
          input.requestedBy,
          now,
          now,
          revision,
        );
    });
    this.touchProject(input.projectId);
    return this.handover(input.projectId)!;
  }

  handover(projectId: string): HandoverRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM coordinator_handovers WHERE project_id = ?`)
      .get(projectId) as Row | undefined;
    return row ? toHandover(row) : null;
  }

  hasFlag(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM plugin_flags WHERE key=?").get(key) !== undefined;
  }

  setFlag(key: string) {
    this.db.prepare("INSERT OR IGNORE INTO plugin_flags(key, set_at) VALUES(?, ?)").run(key, Date.now());
  }

  /** When a flag was set; null when it is absent. */
  flagSetAt(key: string): number | null {
    const row = this.db.prepare("SELECT set_at FROM plugin_flags WHERE key=?").get(key) as { set_at: number } | undefined;
    return row ? Number(row.set_at) : null;
  }

  /** W468: a new report's notice, first send at `at`; replaces the assignment's earlier notice under the new cycle id. */
  startReportNotice(projectId: string, num: number, cycle: string, hash: string, leadThreadId: string, at: number) {
    this.db.prepare("INSERT OR REPLACE INTO report_notices(project_id, assignment_num, cycle, hash, lead_thread_id, attempts, started_at, sent_at, open) VALUES(?,?,?,?,?,1,?,?,1)").run(projectId, num, cycle, hash, leadThreadId, at, at);
  }

  openReportNotices(): ReportNoticeCycle[] {
    return (this.db.prepare("SELECT * FROM report_notices WHERE open = 1 ORDER BY project_id, assignment_num").all() as Row[]).map(toNoticeCycle);
  }

  reportNotice(projectId: string, num: number): (ReportNoticeCycle & { open: boolean }) | null {
    const row = this.db.prepare("SELECT * FROM report_notices WHERE project_id = ? AND assignment_num = ?").get(projectId, num) as Row | undefined;
    return row ? { ...toNoticeCycle(row), open: !!row.open } : null;
  }

  /** Another send in this cycle, to `leadThreadId`; false when the cycle is over or replaced. */
  noteReportNoticeSend(projectId: string, num: number, cycle: string, leadThreadId: string, at: number): boolean {
    return this.db.prepare("UPDATE report_notices SET attempts = attempts + 1, lead_thread_id = ?, sent_at = ?, queued_id = NULL WHERE project_id = ? AND assignment_num = ? AND cycle = ? AND open = 1").run(leadThreadId, at, projectId, num, cycle).changes > 0;
  }

  /** BB queued the latest send as this row; it is BB's to dispatch. */
  queueReportNotice(projectId: string, num: number, cycle: string, queuedId: string) {
    this.db.prepare("UPDATE report_notices SET queued_id = ? WHERE project_id = ? AND assignment_num = ? AND cycle = ?").run(queuedId, projectId, num, cycle);
  }

  /** The cycle needs no more checks. */
  settleReportNotice(projectId: string, num: number, cycle: string) {
    this.db.prepare("UPDATE report_notices SET open = 0 WHERE project_id = ? AND assignment_num = ? AND cycle = ?").run(projectId, num, cycle);
  }

  /** Sets a flag's time, also when it already exists (v9's loops-v5 marker moves on each cutover). */
  upsertFlag(key: string, at: number) {
    this.db.prepare("INSERT INTO plugin_flags(key, set_at) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET set_at = excluded.set_at").run(key, at);
  }

  /** Clears every flag starting with `prefix`, but those starting with `keep`. */
  clearFlags(prefix: string, keep: string | null = null) {
    this.db
      .prepare("DELETE FROM plugin_flags WHERE substr(key, 1, length(?)) = ? AND (? IS NULL OR substr(key, 1, length(?)) <> ?)")
      .run(prefix, prefix, keep, keep, keep);
  }

  handoverDraft(projectId: string): HandoverDraft | null {
    const row = this.db.prepare("SELECT * FROM handover_drafts WHERE project_id=?").get(projectId) as Row | undefined;
    return row ? toDraft(row) : null;
  }

  handoverDraftByThread(threadId: string): HandoverDraft | null {
    const row = this.db.prepare("SELECT * FROM handover_drafts WHERE thread_id=? AND state='generating'").get(threadId) as Row | undefined;
    return row ? toDraft(row) : null;
  }

  /** Requested drafts waiting for a writer slot, oldest first. */
  queuedDrafts(): HandoverDraft[] {
    return (this.db.prepare("SELECT * FROM handover_drafts WHERE state='requested' AND detail='queued' ORDER BY created_at, project_id").all() as Row[]).map(toDraft);
  }

  generatingDrafts(): HandoverDraft[] {
    return (this.db.prepare("SELECT * FROM handover_drafts WHERE state='generating'").all() as Row[]).map(toDraft);
  }

  saveHandoverDraft(draft: Omit<HandoverDraft, "createdAt" | "updatedAt"> & { createdAt?: number }): HandoverDraft {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO handover_drafts(project_id, state, note, text, source, thread_id, detail, then_replace, fallback, fingerprint, captured_at, purpose, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET state=excluded.state, note=excluded.note, text=excluded.text, source=excluded.source,
         thread_id=excluded.thread_id, detail=excluded.detail, then_replace=excluded.then_replace, fallback=excluded.fallback,
         fingerprint=excluded.fingerprint, captured_at=excluded.captured_at, purpose=excluded.purpose, updated_at=excluded.updated_at`,
    ).run(draft.projectId, draft.state, draft.note, draft.text, draft.source, draft.threadId, draft.detail,
      draft.thenReplace ? JSON.stringify(draft.thenReplace) : null, draft.fallback ?? null, draft.fingerprint ?? null, draft.capturedAt ?? null, draft.purpose ?? null, draft.createdAt ?? now, now);
    return this.handoverDraft(draft.projectId)!;
  }

  /** A296: writer threads stay listed until their archive is confirmed. */
  trackWriter(threadId: string, projectId: string) {
    this.db.prepare("INSERT OR IGNORE INTO handover_writers(thread_id, project_id, created_at) VALUES(?, ?, ?)").run(threadId, projectId, Date.now());
  }

  untrackWriter(threadId: string) {
    this.db.prepare("DELETE FROM handover_writers WHERE thread_id=?").run(threadId);
  }

  trackedWriters(): { threadId: string; projectId: string }[] {
    return (this.db.prepare("SELECT thread_id, project_id FROM handover_writers ORDER BY created_at").all() as { thread_id: string; project_id: string }[])
      .map(row => ({ threadId: row.thread_id, projectId: row.project_id }));
  }

  clearHandoverDraft(projectId: string) {
    this.db.prepare("DELETE FROM handover_drafts WHERE project_id=?").run(projectId);
  }

  pendingHandover(projectId: string): HandoverRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM coordinator_handovers WHERE project_id = ? AND state = 'pending'`,
      )
      .get(projectId) as Row | undefined;
    return row ? toHandover(row) : null;
  }

  pendingHandoverProjects(): string[] {
    return (
      this.db
        .prepare(
          `SELECT project_id FROM coordinator_handovers WHERE state = 'pending'`,
        )
        .all() as Row[]
    ).map((row) => String(row.project_id));
  }

  /** Record why a pending request is waiting; returns false if a newer revision exists. */
  holdHandover(
    projectId: string,
    detail: string,
    revision?: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE coordinator_handovers SET detail = ?, updated_at = ? WHERE project_id = ? AND state = 'pending'${revision === undefined ? "" : " AND revision = ?"}`,
      )
      .run(
        detail,
        this.now(),
        projectId,
        ...(revision === undefined ? [] : [revision]),
      );
    if (!result.changes) return false;
    this.touchProject(projectId);
    return true;
  }

  failHandover(
    projectId: string,
    detail: string,
    revision?: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE coordinator_handovers SET state = 'failed', detail = ?, updated_at = ? WHERE project_id = ? AND state = 'pending'${revision === undefined ? "" : " AND revision = ?"}`,
      )
      .run(
        detail,
        this.now(),
        projectId,
        ...(revision === undefined ? [] : [revision]),
      );
    if (!result.changes) return false;
    this.touchProject(projectId);
    return true;
  }

  clearHandover(projectId: string, revision?: number): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM coordinator_handovers WHERE project_id = ?${revision === undefined ? "" : " AND revision = ?"}`,
      )
      .run(projectId, ...(revision === undefined ? [] : [revision]));
    if (!result.changes) return false;
    this.touchProject(projectId);
    return true;
  }

  // Membership -------------------------------------------------------------

  membership(threadId: string, includeArchived = false): Membership | null {
    const coordinator = this.db
      .prepare(
        `SELECT * FROM projects WHERE coordinator_thread_id = ? AND (? OR archived_at IS NULL) ORDER BY (archived_at IS NULL) DESC, updated_at DESC LIMIT 1`,
      )
      .get(threadId, Number(includeArchived)) as Row | undefined;
    if (coordinator)
      return {
        project: toProject(coordinator),
        workerNum: 0,
        kind: "coordinator" as const,
        worker: null,
        former: false,
      };
    const worker = this.db
      .prepare(
        `SELECT * FROM workers WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(threadId) as Row | undefined;
    if (worker) {
      const record = toWorker(worker);
      const project = this.project(record.projectId);
      if (project && (includeArchived || project.archivedAt === null))
        return {
          project,
          workerNum: record.num,
          kind: "worker" as const,
          worker: record,
          former: false,
        };
    }
    const generation = this.db
      .prepare(
        `SELECT * FROM generations WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(threadId) as Row | undefined;
    if (generation) {
      const project = this.project(String(generation.project_id));
      if (project && (includeArchived || project.archivedAt === null)) {
        const workerNum = Number(generation.worker_num);
        return {
          project,
          workerNum,
          kind: workerNum === 0 ? ("coordinator" as const) : ("worker" as const),
          worker: workerNum ? this.worker(project.id, workerNum) : null,
          former: true,
        };
      }
    }
    const adhoc = this.db
      .prepare(
        `SELECT * FROM project_threads WHERE thread_id = ? AND thread_id IS NOT NULL`,
      )
      .get(threadId) as Row | undefined;
    if (adhoc) {
      const project = this.project(String(adhoc.project_id));
      if (project && (includeArchived || project.archivedAt === null))
        return {
          project,
          workerNum: -1,
          kind: "adhoc" as const,
          discussion: adhoc.discussion === 1,
          worker: null,
          former: false,
        };
    }
    const nested = this.db
      .prepare(`SELECT * FROM project_nested_threads WHERE thread_id = ?`)
      .get(threadId) as Row | undefined;
    if (nested) {
      const project = this.project(String(nested.project_id));
      if (project && (includeArchived || project.archivedAt === null))
        return {
          project,
          workerNum: -1,
          kind: "adhoc" as const,
          worker: null,
          former: false,
        };
    }
    return null;
  }

  // Generations ------------------------------------------------------------

  openGeneration(
    projectId: string,
    workerNum: number,
    generation: number,
    threadId: string,
  ) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO generations (project_id, worker_num, generation, thread_id, started_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, workerNum, generation, threadId, this.now());
  }

  closeGeneration(projectId: string, workerNum: number, reason: string) {
    this.db
      .prepare(
        `UPDATE generations SET ended_at = ?, end_reason = ? WHERE project_id = ? AND worker_num = ? AND ended_at IS NULL`,
      )
      .run(this.now(), reason, projectId, workerNum);
  }

  generations(projectId: string, workerNum: number) {
    return (
      this.db
        .prepare(
          `SELECT * FROM generations WHERE project_id = ? AND worker_num = ? ORDER BY generation`,
        )
        .all(projectId, workerNum) as Row[]
    ).map((row) => ({
      generation: Number(row.generation),
      threadId: String(row.thread_id),
      providerThreadId: (row.provider_thread_id as string | null) ?? null,
      startedAt: Number(row.started_at),
      endedAt: (row.ended_at as number | null) ?? null,
      endReason: (row.end_reason as string | null) ?? null,
      holdReason: (row.hold_reason as string | null) ?? null,
    }));
  }

  /** Record (or clear, with null) why a former coordinator generation stays live; true when it changed. */
  holdGeneration(projectId: string, threadId: string, reason: string | null) {
    return (
      this.db
        .prepare(
          `UPDATE generations SET hold_reason = ? WHERE project_id = ? AND worker_num = 0 AND thread_id = ? AND hold_reason IS NOT ?`,
        )
        .run(reason, projectId, threadId, reason).changes > 0
    );
  }

  setProviderThread(threadId: string, providerThreadId: string) {
    this.db
      .prepare(
        `UPDATE generations SET provider_thread_id = ? WHERE thread_id = ? AND ended_at IS NULL`,
      )
      .run(providerThreadId, threadId);
  }

  // Tasks ------------------------------------------------------------------

  createTask(input: {
    projectId: string;
    title: string;
    summary: string;
    brief: Brief | null;
    priority: number;
    dependsOn: number[];
    workKind: WorkKind;
    profileOverride: Profile | null;
    profileSource: TaskRecord["profileSource"];
  }): TaskRecord {
    const num = this.nextNum("tasks", input.projectId);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (project_id, num, title, summary, brief, status, priority, depends_on, work_kind, profile_override, profile_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        num,
        input.title,
        input.summary,
        json(input.brief),
        input.priority,
        JSON.stringify(input.dependsOn),
        input.workKind,
        json(input.profileOverride),
        input.profileSource,
        now,
        now,
      );
    this.touchProject(input.projectId);
    return this.task(input.projectId, num)!;
  }

  task(projectId: string, num: number): TaskRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE project_id = ? AND num = ?`)
      .get(projectId, num) as Row | undefined;
    return row ? this.withStatus(projectId, [toTask(row)], num)[0]! : null;
  }

  tasks(projectId: string): TaskRecord[] {
    return this.withStatus(projectId, (
      this.db
        .prepare(
          `SELECT * FROM tasks WHERE project_id = ? ORDER BY priority, num`,
        )
        .all(projectId) as Row[]
    ).map(toTask));
  }

  /**
   * v9: each task's shown status, computed from the work assignments naming it and the PRs that
   * work names (its PR records, and the PRs its report names), unless it was set by hand.
   */
  private withStatus(projectId: string, tasks: TaskRecord[], only?: number): TaskRecord[] {
    const computed = tasks.filter((t) => t.statusSetAt === null);
    if (!computed.length) return tasks;
    const rows = (only === undefined
      ? this.db.prepare(`SELECT * FROM assignments WHERE project_id = ? AND role = 'work' AND task_nums <> '[]'`).all(projectId)
      : this.db.prepare(`SELECT * FROM assignments WHERE project_id = ? AND role = 'work' AND EXISTS (SELECT 1 FROM json_each(task_nums) WHERE value = ?)`).all(projectId, only)) as Row[];
    if (!rows.length) return tasks.map((t) => (t.statusSetAt === null ? { ...t, status: "planned" as const, statusReason: "no worker yet" } : t));
    const work = rows.map(toAssignment);
    const records = this.prRecords(projectId);
    const named = new Map<string, string[]>();
    for (const [url, record] of records) if (record.assignment) named.set(record.assignment, [...(named.get(record.assignment) ?? []), url]);
    const linkOf = (a: AssignmentRecord) => {
      const urls = [...new Set([...(named.get(a.ref) ?? []), ...reportPrs(a.report)])];
      return { num: a.num, workerNum: a.workerNum, state: a.state, stopReason: a.stopReason, threadFailed: closedOnThreadFailure(a),
        report: a.report ? { outcome: a.report.outcome, summary: a.report.summary } : null,
        prs: urls.map((url) => ({ url, state: this.prState(url)?.state ?? null, stage: records.get(url)?.stage ?? null })) };
    };
    return tasks.map((task) => {
      if (task.statusSetAt !== null) return task;
      const { status, reason } = computeTaskStatus(task, work.filter((a) => a.taskNums.includes(task.num)).map(linkOf));
      return { ...task, status, statusReason: reason };
    });
  }

  /**
   * Set a task's status by hand, or (null) let it follow its work again. Following the work stores
   * planned, so a computed task never stores done or cancelled: a stored done or cancelled with
   * no status_set_at can only be a close the previous build made (reconcileTaskOverrides).
   */
  setTaskStatus(projectId: string, num: number, status: HandStatus | null): TaskRecord {
    const now = this.now();
    this.db
      .prepare(`UPDATE tasks SET status = ?, status_set_at = ?, updated_at = ? WHERE project_id = ? AND num = ?`)
      .run(status ?? "planned", status === null ? null : now, now, projectId, num);
    this.touchProject(projectId);
    return this.task(projectId, num)!;
  }

  /**
   * v9, on every load after migrations: a done or cancelled the previous build stored becomes
   * hand-set, dated by its own write; a hand-set task the previous build moved to a status a hand
   * never sets follows the work again. Returns the tasks the first statement changed. An ordinary
   * reload changes nothing.
   */
  reconcileTaskOverrides(): { projectId: string; num: number; status: string }[] {
    return this.tx(() => {
      const closed = this.db
        .prepare(`SELECT project_id, num, status FROM tasks WHERE status IN ('done','cancelled') AND status_set_at IS NULL`)
        .all() as { project_id: string; num: number; status: string }[];
      this.db.prepare(`UPDATE tasks SET status_set_at = updated_at WHERE status IN ('done','cancelled') AND status_set_at IS NULL`).run();
      this.db.prepare(`UPDATE tasks SET status_set_at = NULL WHERE status_set_at IS NOT NULL AND status NOT IN ('planned','cancelled','done')`).run();
      return closed.map((row) => ({ projectId: row.project_id, num: row.num, status: row.status }));
    });
  }

  updateTask(
    projectId: string,
    num: number,
    patch: Partial<
      Pick<
        TaskRecord,
        | "title"
        | "summary"
        | "brief"
        | "priority"
        | "dependsOn"
        | "workKind"
        | "profileOverride"
        | "profileSource"
        | "progress"
        | "nextCheckpoint"
        | "result"
        | "acceptedAssignment"
      >
    >,
  ): TaskRecord {
    // v9: the status is computed, or set by hand through setTaskStatus; nothing else writes it.
    const current = this.task(projectId, num);
    if (!current) throw new Error(`Unknown task ${taskRef(num)}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, summary = ?, brief = ?, priority = ?, depends_on = ?, work_kind = ?, profile_override = ?, profile_source = ?, progress = ?, next_checkpoint = ?, result = ?, accepted_assignment = ?, updated_at = ?
         WHERE project_id = ? AND num = ?`,
      )
      .run(
        next.title,
        next.summary,
        json(next.brief),
        next.priority,
        JSON.stringify(next.dependsOn),
        next.workKind,
        json(next.profileOverride),
        next.profileSource,
        next.progress,
        next.nextCheckpoint,
        next.result,
        next.acceptedAssignment,
        this.now(),
        projectId,
        num,
      );
    this.touchProject(projectId);
    return this.task(projectId, num)!;
  }

  // Rules ------------------------------------------------------------------

  rules(projectId: string, includeRemoved = false): RuleRecord[] {
    return (this.db
      .prepare(`SELECT * FROM rules WHERE project_id = ? AND (? OR removed_at IS NULL) ORDER BY removed_at IS NOT NULL, position, num`)
      .all(projectId, Number(includeRemoved)) as Row[]).map(toRule);
  }

  rule(projectId: string, num: number): RuleRecord | null {
    const row = this.db.prepare(`SELECT * FROM rules WHERE project_id = ? AND num = ?`).get(projectId, num) as Row | undefined;
    return row ? toRule(row) : null;
  }

  /** Appends a rule; numbers are never reused, removed rules included. */
  addRule(projectId: string, text: string, sources: string[] = []): RuleRecord {
    const num = this.nextNum("rules", projectId);
    const position = (this.db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM rules WHERE project_id = ? AND removed_at IS NULL`).get(projectId) as { p: number }).p;
    const now = this.now();
    this.db
      .prepare(`INSERT INTO rules (project_id, num, text, position, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, num, text, position, JSON.stringify(sources), now, now);
    return this.rule(projectId, num)!;
  }

  updateRule(projectId: string, num: number, patch: { text?: string; sources?: string[]; removed?: boolean }): RuleRecord {
    const current = this.rule(projectId, num);
    if (!current) throw new Error(`Unknown rule ${ruleRef(num)}`);
    const now = this.now();
    this.db
      .prepare(`UPDATE rules SET text = ?, sources = ?, removed_at = ?, updated_at = ? WHERE project_id = ? AND num = ?`)
      .run(patch.text ?? current.text, JSON.stringify(patch.sources ?? current.sources),
        patch.removed === undefined ? current.removedAt : patch.removed ? now : null, now, projectId, num);
    return this.rule(projectId, num)!;
  }

  /** Writes the live rules' order: `order` lists every live rule number once. */
  orderRules(projectId: string, order: number[]) {
    const update = this.db.prepare(`UPDATE rules SET position = ?, updated_at = ? WHERE project_id = ? AND num = ?`);
    const now = this.now();
    order.forEach((num, index) => update.run(index + 1, now, projectId, num));
  }

  /** The live rules become exactly `rules`, numbers, order, text and sources (an import). */
  replaceRules(projectId: string, rules: { num: number; text: string; sources: string[] }[]) {
    const now = this.now();
    const keep = new Set(rules.map((r) => r.num));
    for (const live of this.rules(projectId))
      if (!keep.has(live.num)) this.db.prepare(`UPDATE rules SET removed_at = ?, updated_at = ? WHERE project_id = ? AND num = ?`).run(now, now, projectId, live.num);
    const upsert = this.db.prepare(`INSERT INTO rules (project_id, num, text, position, sources, created_at, updated_at, removed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(project_id, num) DO UPDATE SET text = excluded.text, position = excluded.position,
      sources = excluded.sources, updated_at = excluded.updated_at, removed_at = NULL`);
    rules.forEach((r, index) => upsert.run(projectId, r.num, r.text, index + 1, JSON.stringify(r.sources), now, now));
  }

  /** How many live rules there are and when the list last changed (null: never). */
  rulesStamp(projectId: string): { count: number; changedAt: number | null } {
    const row = this.db
      .prepare(`SELECT SUM(removed_at IS NULL) AS count, MAX(updated_at) AS changed FROM rules WHERE project_id = ?`)
      .get(projectId) as { count: number | null; changed: number | null };
    return { count: Number(row.count ?? 0), changedAt: row.changed === null ? null : Number(row.changed) };
  }

  // PR states ----------------------------------------------------------------

  prState(url: string): PrStateRecord | null {
    const row = this.db.prepare(`SELECT * FROM pr_states WHERE url = ?`).get(url) as Row | undefined;
    return row
      ? { url: String(row.url), state: row.state as PrStateRecord["state"], mergedAt: (row.merged_at as number | null) ?? null,
          closedAt: (row.closed_at as number | null) ?? null, checkedAt: Number(row.checked_at), error: (row.error as string | null) ?? null }
      : null;
  }

  /** The open-PR list names these: they are open. MERGED is final and never reopens. */
  markPrsOpen(urls: Iterable<string>, at: number) {
    const upsert = this.db.prepare(`INSERT INTO pr_states (url, state, checked_at) VALUES (?, 'OPEN', ?)
      ON CONFLICT(url) DO UPDATE SET state = 'OPEN', closed_at = NULL, error = NULL, checked_at = excluded.checked_at WHERE pr_states.state <> 'MERGED'`);
    this.tx(() => { for (const url of urls) upsert.run(url, at); });
  }

  /** One lookup's answer; a failed lookup stamps checked_at with its error and keeps the state. */
  savePrLookup(url: string, at: number, result: { state: PrStateRecord["state"]; mergedAt: number | null; closedAt: number | null } | { error: string }) {
    if ("error" in result)
      this.db.prepare(`INSERT INTO pr_states (url, state, checked_at, error) VALUES (?, 'OPEN', ?, ?)
        ON CONFLICT(url) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`).run(url, at, result.error);
    else
      this.db.prepare(`INSERT INTO pr_states (url, state, merged_at, closed_at, checked_at, error) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(url) DO UPDATE SET state = excluded.state, merged_at = excluded.merged_at, closed_at = excluded.closed_at,
        checked_at = excluded.checked_at, error = NULL WHERE pr_states.state <> 'MERGED'`).run(url, result.state, result.mergedAt, result.closedAt, at);
  }

  /**
   * The tracked PRs a lookup pass may check: every PR record and every PR a task's work reports
   * name, except those in the open list just fetched, MERGED ones and those checked within
   * `freshMs`; oldest check first, never checked first of all.
   */
  prsToLookUp(listed: ReadonlySet<string>, now: number, limit: number, freshMs = 60 * 60_000): string[] {
    const tracked = new Set((this.db.prepare(`SELECT DISTINCT url FROM pr_records`).all() as { url: string }[]).map((r) => r.url));
    for (const row of this.db.prepare(`SELECT report FROM assignments WHERE role = 'work' AND task_nums <> '[]' AND report IS NOT NULL`).all() as { report: string }[])
      for (const url of reportPrs(parseStored(row.report))) tracked.add(url);
    return [...tracked]
      .filter((url) => !listed.has(url))
      .map((url) => ({ url, state: this.prState(url) }))
      .filter(({ state }) => state?.state !== "MERGED" && (!state || now - state.checkedAt >= freshMs))
      .sort((a, b) => (a.state?.checkedAt ?? -Infinity) - (b.state?.checkedAt ?? -Infinity))
      .slice(0, limit)
      .map(({ url }) => url);
  }

  // Workers ----------------------------------------------------------------

  createWorker(input: {
    projectId: string;
    role: Role;
    kind?: WorkerKind | null;
    label: string;
    area: string;
    bbProjectId: string;
    forkedFrom?: number | null;
    nativeParent?: boolean;
  }): WorkerRecord {
    const num = this.nextNum("workers", input.projectId);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO workers (project_id, num, role, kind, label, area, generation, bb_project_id, state, forked_from, native_parent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'idle', ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        num,
        input.role,
        input.kind ?? null,
        input.label,
        input.area,
        input.bbProjectId,
        input.forkedFrom ?? null,
        input.nativeParent ? 1 : 0,
        now,
        now,
      );
    return this.worker(input.projectId, num)!;
  }

  worker(projectId: string, num: number): WorkerRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM workers WHERE project_id = ? AND num = ?`)
      .get(projectId, num) as Row | undefined;
    return row ? toWorker(row) : null;
  }

  workers(projectId: string): WorkerRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM workers WHERE project_id = ? ORDER BY num`)
        .all(projectId) as Row[]
    ).map(toWorker);
  }

  /** Role is deliberately not patchable: it is immutable for a worker's life. */
  updateWorker(
    projectId: string,
    num: number,
    patch: Partial<
      Pick<
        WorkerRecord,
        | "label"
        | "area"
        | "threadId"
        | "generation"
        | "environmentId"
        | "providerId"
        | "model"
        | "reasoningLevel"
        | "state"
        | "retention"
        | "handoff"
        | "nativeParent"
        | "userStopped"
        | "interventionAt"
        | "bbProjectId"
      >
    >,
  ): WorkerRecord {
    const current = this.worker(projectId, num);
    if (!current) throw new Error(`Unknown worker ${workerRef(num)}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE workers SET label = ?, area = ?, thread_id = ?, generation = ?, environment_id = ?, provider_id = ?, model = ?, reasoning_level = ?, state = ?, retention = ?, handoff = ?, native_parent = ?, user_stopped = ?, intervention_at = ?, bb_project_id = ?, updated_at = ?
         WHERE project_id = ? AND num = ?`,
      )
      .run(
        next.label,
        next.area,
        next.threadId,
        next.generation,
        next.environmentId,
        next.providerId,
        next.model,
        next.reasoningLevel,
        next.state,
        json(next.retention),
        json(next.handoff),
        next.nativeParent ? 1 : 0,
        next.userStopped ? 1 : 0,
        next.interventionAt,
        next.bbProjectId,
        this.now(),
        projectId,
        num,
      );
    this.touchProject(projectId);
    return this.worker(projectId, num)!;
  }

  // Assignments ------------------------------------------------------------

  createAssignment(
    input: Omit<
      AssignmentRecord,
      | "num"
      | "ref"
      | "createdAt"
      | "updatedAt"
      | "actualProfile"
      | "report"
      | "reportedAt"
      | "reportSeq"
      | "stopReason"
      | "queuedMessageId"
      | "fingerprint"
      | "reviewKey"
      | "briefDelivered"
      | "cancelRequested"
      | "pendingIdentity"
      | "label"
      | "access"
      | "reviewTargets"
      | "checkpoint"
      | "reportNotice"
      | "writeScope"
      | "scopeRelease"
      | "handoffSources"
      | "replyTo"
    > & {
      replyTo?: string | null;
      writeScope?: string[] | null;
      handoffSources?: HandoffSource[] | null;
      access?: AssignmentAccess;
      reviewKey?: AssignmentRecord["reviewKey"];
      pendingIdentity?: AssignmentRecord["pendingIdentity"];
    },
  ): AssignmentRecord {
    const num = this.nextNum("assignments", input.projectId);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO assignments (project_id, num, worker_num, task_nums, route, role, work_kind, thread_id, generation, profile, bb_project_id, environment_id, state, op_id, op_state, brief_text, review_of, rationale, review_key, pending_identity, label, access, write_scope, handoff_sources, reply_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        num,
        input.workerNum,
        JSON.stringify(input.taskNums),
        input.route,
        input.role,
        input.workKind,
        input.threadId,
        input.generation,
        JSON.stringify(input.profile),
        input.bbProjectId,
        input.environmentId,
        input.state,
        input.opId,
        input.opState,
        input.briefText,
        json(input.reviewOf),
        input.rationale,
        input.reviewKey ?? null,
        json(input.pendingIdentity),
        input.pendingIdentity?.label ?? this.worker(input.projectId, input.workerNum)?.label ?? null,
        input.role === "review" ? "read-only" : input.access ?? "write",
        json(input.writeScope ?? null),
        json(input.handoffSources?.length ? input.handoffSources : null),
        input.replyTo ?? null,
        now,
        now,
      );
    this.touchProject(input.projectId);
    return this.assignment(input.projectId, num)!;
  }

  assignment(projectId: string, num: number): AssignmentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM assignments WHERE project_id = ? AND num = ?`)
      .get(projectId, num) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  assignmentByOp(opId: string): AssignmentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM assignments WHERE op_id = ?`)
      .get(opId) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  assignmentByQueuedMessage(queuedMessageId: string): AssignmentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM assignments WHERE queued_message_id = ?`)
      .get(queuedMessageId) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  /** Open assignments whose brief sits in a native queue. */
  /**
   * Any assignment still holding a native queue receipt — including a
   * cancelled one whose deletion has not been confirmed. A receipted row may
   * still be runnable in BB; state alone must not drop it from reconcile.
   */
  assignmentsWithQueued(): AssignmentRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM assignments WHERE queued_message_id IS NOT NULL`)
        .all() as Row[]
    ).map(toAssignment);
  }

  assignments(projectId: string): AssignmentRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM assignments WHERE project_id = ? ORDER BY num`)
        .all(projectId) as Row[]
    ).map(toAssignment);
  }

  /**
   * The dashboard's first paint, without decoding what it never shows: a
   * report only while awaiting acceptance, a checkpoint only on open or
   * reported work, and never review targets, notices, staged identities,
   * write scopes, releases or handoff sources. Those fields are null here;
   * use `assignments` for anything else.
   */
  assignmentsForSummary(projectId: string): AssignmentRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM assignments WHERE project_id = ? ORDER BY num`)
        .all(projectId) as Row[]
    ).map((row) => {
      const settled = ["accepted", "rejected", "cancelled", "failed"].includes(String(row.state));
      return toAssignment({
        ...row,
        report: row.state === "reported" ? row.report : null,
        checkpoint: settled ? null : row.checkpoint,
        review_targets: null, report_notice: null, pending_identity: null,
        write_scope: null, scope_release: null, handoff_sources: null,
      });
    });
  }

  /** Each worker's latest assignment that carries a report, by worker number. */
  lastReportedAssignments(projectId: string): Map<number, number> {
    return new Map(
      (
        this.db
          .prepare(`SELECT worker_num AS worker, MAX(num) AS num FROM assignments WHERE project_id = ? AND report IS NOT NULL GROUP BY worker_num`)
          .all(projectId) as { worker: number; num: number }[]
      ).map((row) => [row.worker, row.num]),
    );
  }

  /** One worker's assignments, oldest first. */
  workerAssignments(projectId: string, workerNum: number): AssignmentRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM assignments WHERE project_id = ? AND worker_num = ? ORDER BY num`)
        .all(projectId, workerNum) as Row[]
    ).map(toAssignment);
  }

  /**
   * D440: the newest review still pending or running whose brief embeds this filing of the report
   * (its first handoff source): an amended report on the same A# is a new version. Uses the
   * assignments_open_review index.
   */
  openReviewOf(projectId: string, ref: string, version: string): AssignmentRecord | null {
    const row = this.db.prepare(OPEN_REVIEW_QUERY).get(projectId, ref, version) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  assignmentsWithOpState(
    states: AssignmentRecord["opState"][],
  ): AssignmentRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM assignments WHERE op_state IN (${states.map(() => "?").join(",")})`,
        )
        .all(...states) as Row[]
    ).map(toAssignment);
  }

  /** The newest assignment for a worker that is not finished from the worker's side. */
  /** A worker's latest assignment of any state, without scanning the whole ledger. */
  latestAssignment(projectId: string, workerNum: number): AssignmentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM assignments WHERE project_id = ? AND worker_num = ? ORDER BY num DESC LIMIT 1`)
      .get(projectId, workerNum) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  /**
   * T150: open work a non-retried failure of its worker's thread would close: delivered,
   * unreported, nothing pending or cancelling on it, on its live worker's current thread, in an
   * active Initiative. `only` narrows it to one assignment.
   */
  failureClosable(only?: { projectId: string; num: number }): AssignmentRecord[] {
    return (
      this.db
        .prepare(`SELECT a.* FROM assignments a JOIN workers w ON w.project_id = a.project_id AND w.num = a.worker_num JOIN projects p ON p.id = a.project_id
          WHERE a.state IN ('running', 'idle_no_report') AND a.brief_delivered = 1 AND a.report IS NULL AND a.queued_message_id IS NULL
            AND a.cancel_requested = 0 AND a.op_state = 'done' AND a.thread_id = w.thread_id AND a.generation = w.generation
            AND w.state != 'retired' AND p.archived_at IS NULL ${only ? "AND a.project_id = ? AND a.num = ?" : ""} ORDER BY a.project_id, a.num`)
        .all(...(only ? [only.projectId, only.num] : [])) as Row[]
    ).map(toAssignment);
  }

  /** T150: work closed on a thread failure, unreported, whose coordinator notice has not gone out (no threadFailureKey flag). */
  unnoticedThreadFailures(): AssignmentRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM assignments a WHERE state = 'failed' AND stop_reason LIKE ? AND report IS NULL AND NOT EXISTS (SELECT 1 FROM plugin_flags WHERE key = 'failed:' || a.project_id || ':' || a.num) ORDER BY project_id, num`)
        .all(`${THREAD_FAILED}%`) as Row[]
    ).map(toAssignment);
  }

  /** T136: a worker's latest assignment with a report, without scanning the whole ledger. */
  latestReported(projectId: string, workerNum: number): AssignmentRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM assignments WHERE project_id = ? AND worker_num = ? AND report IS NOT NULL ORDER BY num DESC LIMIT 1`)
      .get(projectId, workerNum) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  openAssignment(
    projectId: string,
    workerNum: number,
  ): AssignmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM assignments WHERE project_id = ? AND worker_num = ? AND state IN ('dispatching', 'queued', 'running', 'idle_no_report', 'stopped') ORDER BY CASE WHEN state='queued' THEN 1 ELSE 0 END, num ASC LIMIT 1`,
      )
      .get(projectId, workerNum) as Row | undefined;
    return row ? toAssignment(row) : null;
  }

  updateAssignment(
    projectId: string,
    num: number,
    patch: Partial<
      Pick<
        AssignmentRecord,
        | "threadId"
        | "generation"
        | "actualProfile"
        | "fingerprint"
        | "environmentId"
        | "state"
        | "opState"
        | "queuedMessageId"
        | "report"
        | "reportedAt"
        | "stopReason"
        | "briefDelivered"
        | "cancelRequested"
        | "pendingIdentity"
        | "reviewTargets"
        | "checkpoint"
        | "reportNotice"
        | "scopeRelease"
      >
    >,
  ): AssignmentRecord {
    // The staged-rename commit, its clearing, and the delivery/state write are
    // one transaction even when the caller holds none: a renamed worker with
    // an undelivered brief or a stale pending_identity must be impossible.
    // Nested calls join the caller's transaction via savepoint.
    return this.tx(() => {
      let current = this.assignment(projectId, num);
      if (!current) throw new Error(`Unknown assignment ${assignmentRef(num)}`);
      // Positive brief delivery commits a staged continue rename: the brief
      // that carried the new identity provably reached the thread.
      if (patch.briefDelivered === true && current.pendingIdentity) {
        const worker = this.worker(projectId, current.workerNum);
        if (worker)
          this.updateWorker(projectId, worker.num, {
            label: current.pendingIdentity.label ?? worker.label,
            area: current.pendingIdentity.area ?? worker.area,
          });
        this.updateAssignment(projectId, num, { pendingIdentity: null });
        current = this.assignment(projectId, num)!;
      }
      const next = { ...current, ...patch };
      // The decoded report is a public projection. Unrelated patches keep the
      // stored bytes; a replacement first archives a legacy report's exact text.
      const stored = (this.db.prepare("SELECT report FROM assignments WHERE project_id = ? AND num = ?")
        .get(projectId, num) as { report: string | null }).report;
      if ("report" in patch && stored && isLegacyReport(stored))
        this.archiveLegacyPayload(current.threadId, { assignment: assignmentRef(num), report: stored });
      this.db
        .prepare(
          `UPDATE assignments SET thread_id = ?, generation = ?, actual_profile = ?, fingerprint = ?, environment_id = ?, state = ?, op_state = ?, queued_message_id = ?, report = ?, report_seq = report_seq + ?, reported_at = ?, stop_reason = ?, brief_delivered = ?, cancel_requested = ?, pending_identity = ?, checkpoint = ?, review_targets = ?, report_notice = ?, scope_release = ?, updated_at = ?
           WHERE project_id = ? AND num = ?`,
        )
        .run(
          next.threadId,
          next.generation,
          json(next.actualProfile),
          next.fingerprint,
          next.environmentId,
          next.state,
          next.opState,
          next.queuedMessageId,
          "report" in patch ? json(next.report) : stored,
          // Every stored report is a new filing, even with identical content.
          "report" in patch && next.report !== null ? 1 : 0,
          next.reportedAt,
          next.stopReason,
          Number(next.briefDelivered),
          Number(next.cancelRequested),
          json(next.pendingIdentity),
          json(next.checkpoint),
          json(next.reviewTargets),
          json(next.reportNotice),
          json(next.scopeRelease),
          this.now(),
          projectId,
          num,
        );
      this.touchProject(projectId);
      return this.assignment(projectId, num)!;
    });
  }

  /**
   * Monotonic delivery confirmation: a receipt attaches only while the
   * assignment still waits to be queued, and positive dispatch only promotes
   * dispatching/queued to running. Newer running/report/terminal evidence is
   * never downgraded, and a settled assignment cannot regain a queue receipt.
   */
  /**
   * Positive delivery evidence. Monotonic: a newer state always wins — a
   * confirmed running or reported assignment is never downgraded to queued,
   * and a receipt a newer write already replaced is never reattached.
   */
  confirmAssignmentDelivery(
    projectId: string,
    num: number,
    queuedId: string | null = null,
  ) {
    const current = this.assignment(projectId, num)!;
    const state = queuedId
      ? current.state === "dispatching"
        ? "queued"
        : current.state
      : ["dispatching", "queued"].includes(current.state)
        ? "running"
        : current.state;
    return this.updateAssignment(projectId, num, {
      state,
      opState: "done",
      queuedMessageId:
        state === "queued" ? (current.queuedMessageId ?? queuedId) : null,
      briefDelivered: current.briefDelivered || queuedId === null,
    });
  }

  // Decisions. The original table is preserved as an inactive legacy archive.

  addDecision(input: {
    projectId: string;
    topic: string;
    status: DecisionStatus;
    scope: string;
    title: string;
    body: DecisionBody;
    humanAttention: HumanAttention;
    blocks: number[];
    deadline: string | null;
    provenance: Provenance;
    madeBy: "user" | "agent" | null;
    supersedes: number | null;
  }): DecisionRecord {
    const num = this.nextNum("knowledge", input.projectId);
    const now = this.now();
    const previous = this.db
      .prepare(
        `SELECT MAX(version) AS version FROM knowledge WHERE project_id = ? AND topic = ?`,
      )
      .get(input.projectId, input.topic) as { version: number | null };
    this.db
      .prepare(
        `INSERT INTO knowledge (project_id, num, topic, version, kind, status, scope, title, body, human_attention, blocks, deadline, provenance, supersedes, created_at, updated_at, decision_owner, decision_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        num,
        input.topic,
        (previous.version ?? 0) + 1,
        "decision",
        input.status,
        input.scope,
        input.title,
        JSON.stringify(input.body),
        input.humanAttention,
        JSON.stringify(input.blocks),
        input.deadline,
        JSON.stringify(input.provenance),
        input.supersedes,
        now,
        now,
        input.madeBy,
        input.madeBy === "agent" ? "pending" : null,
      );
    if (input.supersedes !== null)
      this.db
        .prepare(
          `UPDATE knowledge SET status = 'superseded', updated_at = ? WHERE project_id = ? AND num = ?`,
        )
        .run(now, input.projectId, input.supersedes);
    this.touchProject(input.projectId);
    return this.decisionItem(input.projectId, num)!;
  }

  decisionItem(projectId: string, num: number): DecisionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM knowledge WHERE project_id = ? AND num = ? AND ${DECISION}`)
      .get(projectId, num) as Row | undefined;
    return row ? toDecision(row) : null;
  }

  /** Handover (F1): the latest change to this Initiative's tasks, workers, work, questions or updates. */
  ledgerStamp(projectId: string): number {
    const row = this.db.prepare(`SELECT MAX(at) AS at FROM (
      SELECT MAX(updated_at) AS at FROM tasks WHERE project_id = ?
      UNION ALL SELECT MAX(updated_at) FROM workers WHERE project_id = ?
      UNION ALL SELECT MAX(updated_at) FROM assignments WHERE project_id = ?
      UNION ALL SELECT MAX(updated_at) FROM knowledge WHERE project_id = ?
      UNION ALL SELECT MAX(created_at) FROM updates WHERE project_id = ?)`).get(projectId, projectId, projectId, projectId, projectId) as { at: number | null };
    return row.at ?? 0;
  }

  /** Handover (F4): the bare status of any question or decision number, including legacy rows outside decisions(). */
  refStatuses(projectId: string, nums: number[]): RefStatus[] {
    if (!nums.length) return [];
    const rows = this.db
      .prepare(`SELECT k.num, k.kind, k.status, k.human_attention, k.decision_owner, k.decision_review, (SELECT MIN(s.num) FROM knowledge s WHERE s.project_id = k.project_id AND s.supersedes = k.num) AS superseded_by FROM knowledge k WHERE k.project_id = ? AND k.num IN (${nums.map(() => "?").join(",")}) ORDER BY k.num`)
      .all(projectId, ...nums) as Row[];
    return rows.map(row => ({
      num: Number(row.num),
      kind: String(row.kind),
      status: String(row.status),
      question: row.human_attention === "needs-opinion",
      madeBy: (row.decision_owner as RefStatus["madeBy"]) ?? null,
      review: (row.decision_review as string | null) ?? null,
      supersededBy: (row.superseded_by as number | null) ?? null,
    }));
  }

  decisions(
    projectId: string,
    options: { includeHistory?: boolean } = {},
  ): DecisionRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM knowledge WHERE project_id = ? AND ${DECISION} ${options.includeHistory ? "" : "AND status NOT IN ('superseded', 'rejected', 'removed')"} ORDER BY num`,
        )
        .all(projectId) as Row[]
    ).map(toDecision);
  }

  updateDecision(
    projectId: string,
    num: number,
    patch: Partial<Pick<DecisionRecord, "status" | "body" | "humanAttention" | "madeBy" | "review" | "reviewMessage" | "notification">>,
  ) {
    const current = this.decisionItem(projectId, num);
    if (!current) throw new Error(`Unknown decision ${decisionRef(num)}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE knowledge SET status = ?, body = ?, human_attention = ?, decision_owner = ?, decision_review = ?, decision_review_message = ?, decision_notification = ?, updated_at = ? WHERE project_id = ? AND num = ?`,
      )
      .run(
        next.status,
        JSON.stringify(next.body),
        next.humanAttention,
        next.madeBy,
        next.review,
        next.reviewMessage,
        json(next.notification),
        this.now(),
        projectId,
        num,
      );
    this.touchProject(projectId);
    return this.decisionItem(projectId, num)!;
  }

  archiveLegacyPayload(threadId: string | null, payload: unknown) {
    this.db.prepare("INSERT INTO legacy_session_payloads(thread_id, payload, created_at) VALUES (?, ?, ?)").run(threadId, JSON.stringify(payload), this.now());
  }

  // Updates ----------------------------------------------------------------

  addUpdate(
    projectId: string,
    summary: string,
    body: string,
    threadId: string | null,
  ): UpdateRecord {
    const num = this.nextNum("updates", projectId);
    this.db
      .prepare(
        `INSERT INTO updates (project_id, num, summary, body, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, num, summary, body, threadId, this.now());
    this.touchProject(projectId);
    return this.updates(projectId, 1)[0]!;
  }

  updates(projectId: string, limit = 10): UpdateRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM updates WHERE project_id = ? ORDER BY num DESC LIMIT ?`,
        )
        .all(projectId, limit) as Row[]
    ).map((row) => {
      const num = Number(row.num);
      return {
        projectId: String(row.project_id),
        num,
        ref: updateRef(num),
        summary: String(row.summary),
        body: String(row.body),
        threadId: (row.thread_id as string | null) ?? null,
        createdAt: Number(row.created_at),
      };
    });
  }

  // Inbox ------------------------------------------------------------------
  // Legacy tables are history only: the plugin no longer writes inbox rows or
  // batches, and pending legacy rows are never replayed. `inbox()` remains so
  // the "inbox" read view can still surface what was recorded.

  inbox(projectId: string, limit = 50): InboxRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM inbox WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(projectId, limit) as Row[]
    ).map(toInbox);
  }

  // Activity ---------------------------------------------------------------

  log(
    projectId: string,
    kind: string,
    summary: string,
    ref: Record<string, unknown> | null = null,
  ) {
    this.db
      .prepare(
        `INSERT INTO activity (project_id, at, kind, summary, ref) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, this.now(), kind, summary, json(ref));
    this.db
      .prepare(
        `DELETE FROM activity WHERE project_id = ? AND id <= (SELECT id FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(projectId, projectId, ACTIVITY_LIMIT);
  }

  activity(projectId: string, limit = 30): ActivityRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(projectId, limit) as Row[]
    ).map((row) => ({
      id: Number(row.id),
      projectId: String(row.project_id),
      at: Number(row.at),
      kind: String(row.kind),
      summary: String(row.summary),
      ref: decodeNullable("activity", row, "ref", objectSchema),
    }));
  }

  // Usage ------------------------------------------------------------------

  usage(threadId: string): UsageRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM usage WHERE thread_id = ?`)
      .get(threadId) as Row | undefined;
    return row ? toUsage(row) : null;
  }

  projectUsage(projectId: string): UsageRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM usage WHERE project_id = ?`)
        .all(projectId) as Row[]
    ).map(toUsage);
  }

  saveUsage(record: Omit<UsageRecord, "updatedAt">) {
    this.db
      .prepare(
        `INSERT INTO usage (thread_id, project_id, worker_num, last_seq, provider_thread_id, session_totals, closed_totals, resets, last_report_at, context_used, context_window, model, context_estimated, context_changed_at, context_observed_at, first_observed_at, last_observed_at, profile_observation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET project_id = excluded.project_id, worker_num = excluded.worker_num, last_seq = excluded.last_seq,
           provider_thread_id = excluded.provider_thread_id, session_totals = excluded.session_totals, closed_totals = excluded.closed_totals,
           resets = excluded.resets, last_report_at = excluded.last_report_at, context_used = excluded.context_used,
           context_window = excluded.context_window, model = excluded.model, context_estimated = excluded.context_estimated,
           context_changed_at = excluded.context_changed_at, context_observed_at = excluded.context_observed_at, first_observed_at = excluded.first_observed_at,
           last_observed_at = excluded.last_observed_at, profile_observation = excluded.profile_observation, updated_at = excluded.updated_at`,
      )
      .run(
        record.threadId,
        record.projectId,
        record.workerNum,
        record.lastSeq,
        record.providerThreadId,
        json(record.sessionTotals),
        JSON.stringify(record.closedTotals),
        record.resets,
        record.lastReportAt,
        record.contextUsed,
        record.contextWindow,
        record.model,
        record.contextEstimated == null
          ? null
          : Number(record.contextEstimated),
        record.contextChangedAt ?? null,
        record.contextObservedAt ?? null,
        record.firstObservedAt ?? null,
        record.lastObservedAt ?? null,
        json(record.profileObservation ?? null),
        this.now(),
      );
  }
  turnCursor(threadId: string) {
    const row = this.db.prepare("SELECT * FROM usage_turn_cursors WHERE thread_id = ?")
      .get(threadId) as Row | undefined;
    return row ? {
      lastSeq: Number(row.last_seq), firstObservedAt: Number(row.first_observed_at),
      lastObservedAt: Number(row.last_observed_at),
    } : null;
  }

  /** Commit the bounded page and cursor together; repeated turn ids pair once. */
  observeTurns(projectId: string, threadId: string, rows: {
    seq: number; createdAt: number; type: string;
    scope?: { kind?: string; turnId?: string | null }; data: unknown;
  }[]) {
    this.db.transaction(() => {
      const cursor = this.turnCursor(threadId);
      const unseen = [...rows].filter(row => ["turn/started", "turn/completed"].includes(row.type) && row.seq > (cursor?.lastSeq ?? 0))
        .sort((a,b) => a.seq - b.seq);
      if (!unseen.length) return;
      for (const row of unseen) {
        const turnId = row.scope?.turnId ?? null;
        const key = turnId ? `turn:${turnId}` : `seq:${row.seq}`;
        const start = row.type === "turn/started";
        const status = (row.data as { status?: string } | null)?.status ?? null;
        this.db.prepare(`INSERT INTO usage_turns
          (thread_id, turn_key, turn_id, started_at, completed_at, status, start_seq, completion_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, turn_key) DO UPDATE SET
            started_at = COALESCE(usage_turns.started_at, excluded.started_at),
            start_seq = COALESCE(usage_turns.start_seq, excluded.start_seq),
            completed_at = COALESCE(usage_turns.completed_at, excluded.completed_at),
            status = CASE WHEN usage_turns.completed_at IS NULL THEN excluded.status ELSE usage_turns.status END,
            completion_seq = COALESCE(usage_turns.completion_seq, excluded.completion_seq)`)
          .run(threadId, key, turnId, start ? row.createdAt : null,
            start ? null : row.createdAt, start ? null : status,
            start ? row.seq : null, start ? null : row.seq);
      }
      this.db.prepare(`INSERT INTO usage_turn_cursors
        (thread_id, project_id, last_seq, first_observed_at, last_observed_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET
        last_seq = excluded.last_seq, last_observed_at = excluded.last_observed_at`)
        .run(threadId, projectId, unseen.at(-1)!.seq,
          cursor?.firstObservedAt ?? unseen[0]!.createdAt, unseen.at(-1)!.createdAt);
    })();
  }

  /**
   * W224: the coordinator's PR records by canonical URL. A stage this version
   * doesn't know reads as none (the queue guesses one); malformed JSON reads as empty.
   */
  prRecords(projectId: string): Map<string, PrRecord> {
    const known = new Set<string>(PR_STAGE_IDS);
    const json = <T,>(value: unknown, fallback: T): T => {
      try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; }
    };
    const rows = this.db.prepare("SELECT * FROM pr_records WHERE project_id = ?").all(projectId) as Row[];
    return new Map(rows.map((row) => {
      const stage = known.has(row.stage as string) ? row.stage as PrStage : null;
      return [row.url as string, {
        url: row.url as string,
        stage,
        note: stage ? (row.note as string | null) ?? null : null,
        setAt: stage ? (row.stage_set_at as number | null) ?? null : null,
        category: (row.category as string | null) ?? null,
        waitingOn: (row.waiting_on as string | null) ?? null,
        changes: json<string[]>(row.changes, []),
        decision: json<PrRecord["decision"]>(row.decision, null),
        worker: (row.worker as string | null) ?? null,
        assignment: (row.assignment as string | null) ?? null,
        updatedAt: row.updated_at as number,
      }];
    }));
  }

  /** Writes one PR record whole; a record with nothing left in it is removed. */
  savePrRecord(projectId: string, r: PrRecord): void {
    const empty = !r.stage && !r.category && !r.waitingOn && !r.changes.length && !r.decision
      && !r.worker && !r.assignment;
    if (empty) {
      this.db.prepare("DELETE FROM pr_records WHERE project_id = ? AND url = ?").run(projectId, r.url);
      return;
    }
    const list = <T,>(values: T[]) => (values.length ? JSON.stringify(values) : null);
    this.db.prepare(`INSERT OR REPLACE INTO pr_records (project_id, url, stage, note, stage_set_at, category, waiting_on,
      changes, decision, worker, assignment, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, r.url, r.stage, r.stage ? r.note : null, r.stage ? r.setAt : null, r.category, r.waitingOn,
        list(r.changes), r.decision ? JSON.stringify(r.decision) : null, r.worker, r.assignment, r.updatedAt);
  }

  /** T157: appends one change to a PR's stage history. */
  addPrStageChange(projectId: string, url: string, change: Omit<PrStageChange, "n">): void {
    this.db.prepare(`INSERT INTO pr_stage_changes (project_id, url, n, at, author, from_stage, to_stage, note)
      SELECT ?, ?, coalesce(max(n), 0) + 1, ?, ?, ?, ?, ? FROM pr_stage_changes WHERE project_id = ? AND url = ?`)
      .run(projectId, url, change.at, change.author, change.from, change.to, change.note, projectId, url);
  }

  /** T157: a PR's newest `limit` stage changes, oldest first, and how many it has. */
  prStageChanges(projectId: string, url: string, limit: number): { items: PrStageChange[]; total: number } {
    const rows = this.db.prepare("SELECT * FROM pr_stage_changes WHERE project_id = ? AND url = ? ORDER BY n DESC LIMIT ?")
      .all(projectId, url, limit) as Row[];
    return {
      items: rows.reverse().map((row) => ({
        n: Number(row.n), at: Number(row.at), author: String(row.author),
        from: (row.from_stage as string | null) ?? null, to: (row.to_stage as string | null) ?? null, note: (row.note as string | null) ?? null,
      })),
      // Numbered 1, 2, … per PR: the newest's number counts them.
      total: rows.length ? Number(rows.at(-1)!.n) : 0,
    };
  }

  /** Moves every PR of category `from` (any case) to `to`, merging when `to` exists; returns how many moved. */
  renamePrCategory(projectId: string, from: string, to: string): number {
    return this.db.prepare("UPDATE pr_records SET category = ? WHERE project_id = ? AND category = ? COLLATE NOCASE")
      .run(to, projectId, from).changes;
  }

  /** W224: changes whenever any of the Initiative's assignments does; a cache key for prMentions. */
  assignmentsStamp(projectId: string): string {
    const row = this.db.prepare("SELECT count(*) AS n, max(updated_at) AS at, total(report_seq) AS seq FROM assignments WHERE project_id = ?")
      .get(projectId) as Row;
    return `${row.n}:${row.at}:${row.seq}`;
  }

  /**
   * W224: the assignments whose brief or report names a GitHub PR, oldest first; the report as
   * stored JSON, the brief without its shared appendix (ownBriefText).
   */
  prMentions(projectId: string): { num: number; workerNum: number; role: string; brief: string; report: string | null }[] {
    const rows = this.db.prepare(`SELECT num, worker_num, role, brief_text, report FROM assignments
      WHERE project_id = ? AND (brief_text LIKE '%github.com/%/pull/%' OR report LIKE '%github.com/%/pull/%') ORDER BY num`)
      .all(projectId) as Row[];
    return rows.map((row) => ({ num: row.num as number, workerNum: row.worker_num as number, role: row.role as string,
      brief: ownBriefText((row.brief_text as string | null) ?? ""), report: (row.report as string | null) ?? null }));
  }

  /**
   * T156: the rows whose text may name one PR, for its detail panel: the
   * assignments (brief, report), decisions and updates whose text matches a
   * LIKE pattern, and the assignments `assignmentNums` name.
   * Callers confirm each match on the text. Assignments are projected, their
   * reports left undecoded.
   */
  prDetailRows(projectId: string, patterns: string[], assignmentNums: number[]) {
    const read = (sql: string, columns: string[], extra = "", more: number[] = []) => {
      const like = patterns.flatMap(() => columns.map((c) => `${c} LIKE ?`)).join(" OR ") || "0";
      return this.db.prepare(sql.replace("$match", `(${like}${extra})`))
        .all(projectId, ...patterns.flatMap((p) => columns.map(() => p)), ...more) as Row[];
    };
    const named = assignmentNums.length ? ` OR num IN (${assignmentNums.map(() => "?").join(", ")})` : "";
    return {
      assignments: read("SELECT num, worker_num, brief_text, report FROM assignments WHERE project_id = ? AND $match",
        ["brief_text", "report"], named, assignmentNums)
        .map((row) => ({ num: Number(row.num), workerNum: Number(row.worker_num), brief: ownBriefText(String(row.brief_text ?? "")), report: String(row.report ?? "") })),
      decisions: read("SELECT num, title || ' ' || body AS text FROM knowledge WHERE project_id = ? AND kind = 'decision' AND $match", ["title", "body"])
        .map((row) => ({ num: Number(row.num), text: String(row.text) })),
      updates: read("SELECT num, summary, body, created_at FROM updates WHERE project_id = ? AND $match ORDER BY num DESC", ["summary", "body"])
        .map((row) => ({ num: Number(row.num), ref: updateRef(Number(row.num)), summary: String(row.summary), text: `${row.summary}\n${row.body}`, createdAt: Number(row.created_at) })),
    };
  }

  /** T156: of these numbers, the decisions a list shows (not removed), newest first. Reads no bodies. */
  listedDecisions(projectId: string, nums: number[]): number[] {
    return (this.db.prepare(`SELECT num FROM knowledge WHERE project_id = ? AND num IN (SELECT value FROM json_each(?))
      AND ${DECISION} AND status != 'removed' ORDER BY num DESC`)
      .all(projectId, JSON.stringify(nums)) as Row[]).map((row) => Number(row.num));
  }

  /** T156: the numbers of the decisions these assignments made (provenance). */
  decisionsBy(projectId: string, assignmentNums: number[]): number[] {
    if (!assignmentNums.length) return [];
    return (this.db.prepare(`SELECT num FROM knowledge WHERE project_id = ? AND kind = 'decision'
      AND json_extract(provenance, '$.assignment') IN (${assignmentNums.map(() => "?").join(", ")})`)
      .all(projectId, ...assignmentNums) as Row[]).map((row) => Number(row.num));
  }

  usageTurns(threadId: string): UsageTurn[] {
    return (this.db.prepare("SELECT * FROM usage_turns WHERE thread_id = ?")
      .all(threadId) as Row[]).map(row => ({
        turnId: (row.turn_id as string | null) ?? null,
        startedAt: (row.started_at as number | null) ?? null,
        completedAt: (row.completed_at as number | null) ?? null,
        status: (row.status as string | null) ?? null,
      }));
  }

}
