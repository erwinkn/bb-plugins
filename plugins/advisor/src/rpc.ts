// The frontend data plane. Inputs are validated at the boundary; outputs are
// typed read models (strict JSON). Panel actions are recorded with their
// caller unverified: BB has no authenticated human identity for plugin calls.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CardView, EntrySummary, FeedView, FindingView, InitiativeWatchView, Overview, WatchDetail, WatchSummary } from "./views.js";
import type { PoolerAdvisorStatus } from "./config/routes.js";
import type { LedgerRow } from "./store/store.js";

const out = <T>() => z.custom<T>(() => true);
const id = z.string().min(1).max(200);

export interface SettingsView {
  effective: Record<string, unknown>;
  errors: { review: string[]; observation: string[] };
  notes: string[];
  secrets: Record<string, boolean>;
  routes: Array<{
    id: string;
    label: string;
    model: string | null;
    billing: string;
    transport: string;
    categories: string[];
    secret: string | null;
    unverified: string[];
    price: { inMax: number; out: number; basis: string; source: string; version: string } | null;
  }>;
  pooler: PoolerAdvisorStatus;
  settingsLog: Array<{ at: number; settingsRev: number; keys: string[]; summary: string }>;
  deferred: Array<{ id: string; label: string; status: string }>;
  initiativeContext: string;
}

export interface ThreadOption {
  id: string;
  title: string | null;
  projectId: string | null;
  status: string;
  watched: boolean;
}

export interface InitiativeOption {
  id: string;
  name: string;
  paused: boolean;
  /** An Initiative watch for it is on. */
  watched: boolean;
}

export interface OpenedEvidence {
  source: "evidence" | "retained";
  complete: boolean;
  label: string | null;
  card: CardView | null;
  retained: unknown;
}

const cursor = z.object({ createdAt: z.number().int(), id }).strict();

/** BB's NewThreadRequest from the native composer, forwarded to threads.spawn unchanged. */
const composeRequest = z
  .object({
    projectId: id,
    providerId: z.string().min(1).max(80),
    model: z.string().min(1).max(120),
    reasoningLevel: z.string().min(1).max(40),
    permissionMode: z.string().min(1).max(40),
    serviceTier: z.string().max(40).optional(),
    executionInputSources: z.record(z.string(), z.string()),
    environment: z.record(z.string(), z.json()).refine((v) => typeof v.type === "string", "environment needs a type"),
    input: z.array(z.record(z.string(), z.json())).min(1).max(100),
    sendAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: out<Overview>() },
  settingsView: { input: z.null(), output: out<SettingsView>() },
  threadOptions: { input: z.object({ query: z.string().max(200).optional() }).strict(), output: out<{ threads: ThreadOption[] }>() },
  threadStatus: { input: z.object({ threadId: id }).strict(), output: out<{ watch: WatchSummary | null }>() },
  watchAdd: { input: z.object({ threadId: id }).strict(), output: out<{ watch: WatchSummary }>() },
  watchRemove: { input: z.object({ watchId: id }).strict(), output: out<{ ok: true; excludedFrom: string[] }>() },
  /** Open Initiatives from the Initiatives context routes; `status` says when they cannot be read. */
  initiativeOptions: { input: z.null(), output: out<{ status: "ok" | "unavailable" | "failed"; error: string | null; initiatives: InitiativeOption[] }>() },
  initiativeWatchSet: { input: z.object({ initiativeId: id, enabled: z.boolean() }).strict(), output: out<{ initiative: InitiativeWatchView }>() },
  initiativeWatchRemove: { input: z.object({ initiativeId: id }).strict(), output: out<{ deleted: number }>() },
  watchSetEnabled: { input: z.object({ watchId: id, enabled: z.boolean() }).strict(), output: out<{ ok: true }>() },
  watchPause: { input: z.object({ watchId: id }).strict(), output: out<{ ok: true }>() },
  watchResume: { input: z.object({ watchId: id }).strict(), output: out<{ ok: true }>() },
  watchSkipToTip: { input: z.object({ watchId: id }).strict(), output: out<{ skipped: number }>() },
  watchDetail: { input: z.object({ watchId: id }).strict(), output: out<WatchDetail>() },
  watchEvidence: {
    input: z.object({ watchId: id, beforeSeq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    output: out<{ cards: CardView[]; nextBeforeSeq: number | null }>(),
  },
  previewReview: { input: z.object({ watchId: id }).strict(), output: out<{ state: string; reviewId: string | null; why: string | null }>() },
  findingOpen: { input: z.object({ occurrenceId: id }).strict(), output: out<OpenedEvidence>() },
  findingAcknowledge: { input: z.object({ occurrenceId: id }).strict(), output: out<{ ok: true }>() },
  issueSetState: {
    input: z.object({ watchId: id, category: z.string().max(64), locator: z.string().max(2000), state: z.enum(["open", "muted", "dismissed-unverified"]) }).strict(),
    output: out<{ ok: true }>(),
  },
  findingsClearAcknowledged: { input: z.object({ watchId: id }).strict(), output: out<{ cleared: number }>() },
  ledger: { input: z.null(), output: out<{ rows: LedgerRow[] }>() },
  /** T105: findings across every watch, newest first, filtered by Initiative or thread. */
  feed: {
    input: z.object({ initiativeId: id.optional(), watchId: id.optional(), before: cursor.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    output: out<FeedView>(),
  },
  /** The Sidebar's Advisor entry: unseen real findings at or above the display threshold, review state and watch counts. */
  unseen: { input: z.null(), output: out<EntrySummary>() },
  feedMarkSeen: { input: z.object({ initiativeId: id.optional(), watchId: id.optional() }).strict(), output: out<{ marked: number }>() },
  /** What Discuss seeds the composer with, and the discussion thread already opened for it, if any. */
  discussDraft: { input: z.object({ occurrenceId: id }).strict(), output: out<{ prompt: string; projectId: string | null; threadId: string | null; title: string }>() },
  /** Called only by the composer's submit: opens (or reuses) the separate discussion thread. */
  discussCreate: { input: z.object({ occurrenceId: id, request: composeRequest }).strict(), output: out<{ threadId: string; reused: boolean }>() },
  /** Advisor-owned finding records by id: the read-only intake surface a later Initiatives stage (S5) or T80 can pull. */
  recordsGet: { input: z.object({ occurrenceIds: z.array(id).min(1).max(50) }).strict(), output: out<{ records: FindingView[]; missing: string[] }>() },
});

export type AdvisorRpc = typeof rpcContract;
