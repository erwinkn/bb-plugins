// The frontend data plane. Inputs are validated at the boundary; outputs are
// typed read models (strict JSON). Panel actions are recorded with their
// caller unverified: BB has no authenticated human identity for plugin calls.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CardView, FindingView, Overview, WatchDetail, WatchSummary } from "./views.js";
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
  pooler: { status: "unknown" | "read"; detail: string };
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

export interface OpenedEvidence {
  source: "evidence" | "retained";
  complete: boolean;
  label: string | null;
  card: CardView | null;
  retained: unknown;
}

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: out<Overview>() },
  settingsView: { input: z.null(), output: out<SettingsView>() },
  threadOptions: { input: z.object({ query: z.string().max(200).optional() }).strict(), output: out<{ threads: ThreadOption[] }>() },
  threadStatus: { input: z.object({ threadId: id }).strict(), output: out<{ watch: WatchSummary | null }>() },
  watchAdd: { input: z.object({ threadId: id }).strict(), output: out<{ watch: WatchSummary }>() },
  watchRemove: { input: z.object({ watchId: id }).strict(), output: out<{ ok: true }>() },
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
  /** Advisor-owned finding records by id: the read-only intake surface a later Projects stage (S5) or T80 can pull. */
  recordsGet: { input: z.object({ occurrenceIds: z.array(id).min(1).max(50) }).strict(), output: out<{ records: FindingView[]; missing: string[] }>() },
});

export type AdvisorRpc = typeof rpcContract;
