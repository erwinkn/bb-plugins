// The transport boundary (A144 §10 as amended by A154 §13 and A161).
//
// Every route makes at most one upstream request per review. Nothing is
// resent, nothing falls back to another model, route or account.

import type { RouteSpec } from "../config/routes.js";
import type { PacketCard } from "../rules/packet.js";
import type { Hunk } from "../rules/diff.js";

/**
 * pre-upstream  proven that no vendor request happened (no reservation kept)
 * rejected      the vendor refused before running the model (by convention; released)
 * ambiguous     the vendor may have run it; usage unknown (full reservation charged)
 * completed     full body with the pinned model and parsed output
 * cut           executed but unusable: cancel or failure after headers, refusal,
 *               truncation, model mismatch, invalid output (full reservation charged)
 */
export type Outcome = "pre-upstream" | "rejected" | "ambiguous" | "completed" | "cut";

export interface Usage {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export interface SendResult {
  outcome: Outcome;
  status: number | null;
  /** Did a request leave for the vendor? "unknown" when nothing can prove it either way. */
  dispatched: "none" | "sent" | "unknown";
  output?: unknown;
  usage?: Usage | null;
  model?: string | null;
  error?: string;
}

/** What a transport is asked to send. Real routes send only `body`; the fake reads the cards. */
export interface ReviewRequest {
  body: string;
  cards: Array<PacketCard & { hunks?: Hunk[] }>;
}

export interface ReviewTransport {
  route: RouteSpec;
  /** Serializes the exact body this transport sends, so the packet builder measures what is sent. */
  serialize(system: string, packet: string): string;
  send(request: ReviewRequest, signal: AbortSignal): Promise<SendResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
