// Conservative admission reservations (A140 §5.5, A144 §8, A161 F4, A168).
// Scenarios at published list prices, not quotes or invoice guarantees.
// Subscription quota is never converted to USD.

import { ALLOWANCE } from "../rules/packet.js";

export const PRICE_VERSION = "2026-10-04";

export interface Price {
  /** $/MTok used for every input token: max(plain input, cache write). */
  inMax: number;
  in: number;
  out: number;
  basis: string;
  source: string;
}

export const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": {
    inMax: 2.5,
    in: 2.0,
    out: 10.0,
    basis: "5-minute cache-write rate ($2.50) > input ($2); valid only with no 1-hour cache_control and no inference_geo",
    source: "platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-04 (A168)",
  },
  "gpt-6-luna": {
    inMax: 0.125,
    in: 0.1,
    out: 0.5,
    basis: "OpenAI published cache-write rate, short context (<=272K input tokens); writes are not additive",
    source: "developers.openai.com/api/docs/pricing, fetched 2026-10-04 (A168)",
  },
  "jev-1.13.0": {
    inMax: 0.042,
    in: 0.042,
    out: 0,
    basis: "input only; no cache-write rate published; output free; state assumed billed once per request (U3)",
    source: "TypeSafe models page as recorded by A141/A147 (not re-fetched)",
  },
};

/**
 * R = (serialized body bytes + 1024) x inMax + maxOutputTokens x out, assuming
 * tokens <= bytes (byte-level BPE) plus a framing allowance. Vendors do not
 * guarantee it; it is a conservative admission bound.
 */
export function reservationUsd(model: string, bodyBytes: number, maxOut: number): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  return ((bodyBytes + ALLOWANCE) * p.inMax + maxOut * p.out) / 1e6;
}

export function expectedUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICES[model]!;
  return (inTok * p.in + outTok * p.out) / 1e6;
}

/** USD from complete vendor usage. Cache reads/writes are not requested, so any reported are priced at inMax. */
export function actualUsd(model: string, usage: { input: number; output: number; cacheWrite?: number; cacheRead?: number }): number {
  const p = PRICES[model]!;
  const cached = (usage.cacheWrite ?? 0) + (usage.cacheRead ?? 0);
  return (usage.input * p.in + cached * p.inMax + usage.output * p.out) / 1e6;
}

/** Subscription token reservation: the same tokens <= bytes assumption, in tokens. */
export function reservationTokens(bodyBytes: number, maxOut: number): number {
  return bodyBytes + ALLOWANCE + maxOut;
}
