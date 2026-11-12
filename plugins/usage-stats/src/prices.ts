import type { Metrics, Weights } from "./model";
import type { PoolerStatsRow } from "./pooler";

// What usage would cost at each provider's public API list prices: an API-price equivalent, not a
// subscription bill. USD per million tokens, standard tier, global routing. A model missing here,
// or a token type its provider lists no price for, counts as unpriced: never as $0.

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
export const PRICES_CHECKED = "2026-11-12";

export interface Price {
  input: number;
  cacheRead: number;
  // OpenAI lists 30m and 12h writes, which the ledger has no counts for: Codex writes are billed,
  // and recorded, as uncached input.
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  output: number;
  source: string;
  checked: string;
}

const price = (source: string, input: number, cacheRead: number, cacheWrite5m: number | null, cacheWrite1h: number | null, output: number): Price => ({
  input, cacheRead, cacheWrite5m, cacheWrite1h, output, source, checked: PRICES_CHECKED,
});
// Anthropic's 5m and 1h writes are 1.25× and 2× input on every model its page lists.
const claude = (input: number, cacheRead: number, output: number) => price(ANTHROPIC, input, cacheRead, input * 1.25, input * 2, output);
// OpenAI's short-context prices (prompts up to 272K tokens).
const openai = (input: number, cacheRead: number, output: number) => price(OPENAI, input, cacheRead, null, null, output);

export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": claude(8, 0.2, 40),
  "claude-fable-5-1": claude(10, 0.25, 50),
  "claude-fable-5": claude(10, 1, 50),
  "claude-opus-5-5": claude(4, 0.2, 20),
  "claude-opus-5": claude(5, 0.5, 25),
  "claude-opus-4-8": claude(5, 0.5, 25),
  "claude-opus-4-7": claude(5, 0.5, 25),
  "claude-opus-4-6": claude(5, 0.5, 25),
  "claude-sonnet-5-5": claude(2, 0.1, 10),
  "claude-sonnet-5": claude(2, 0.2, 10),
  "claude-sonnet-4-6": claude(3, 0.3, 15),
  // Prompts up to 100K tokens. Longer ones cost 5×, which hourly sums cannot tell apart.
  "claude-haiku-5-5": claude(0.1, 0.01, 0.5),
  "claude-haiku-4-5": claude(1, 0.1, 5),
  "gpt-6-astra": openai(10, 1, 50),
  "gpt-6.1-sol": openai(2, 0.1, 10),
  "gpt-6.1-terra": openai(1, 0.05, 5),
  "gpt-6-sol": openai(2, 0.2, 10),
  "gpt-6-luna": openai(0.1, 0.01, 0.5),
  "gpt-5.6-terra": openai(2, 0.2, 12),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2),
};

/** A model's list price; a dated Claude id ("claude-haiku-4-5-20251001") is its model's. */
export function priceOf(model: string | null | undefined): Price | null {
  if (model == null) return null;
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$/u, "")] ?? null;
}

export const TOKEN_TYPES = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export const USD_FIELDS = {
  input: "usdInput",
  output: "usdOutput",
  cacheRead: "usdCacheRead",
  cacheWrite5m: "usdCacheWrite5m",
  cacheWrite1h: "usdCacheWrite1h",
} as const satisfies Record<TokenType, keyof Metrics>;

/**
 * One Pooler row, of one model and kind, with its dollars. A refresh's dollars are also its
 * warming cost. The Pooler's savings are in its fixed weights; they become dollars by recovering
 * how many of the avoided rewrite's tokens were 1h writes: saved = Σ read × (write weight − read
 * weight), with the 5m and 1h write weights the only two.
 */
export function priced(row: PoolerStatsRow, weights: Weights): Metrics {
  const metrics = row.metrics;
  const list = priceOf(row.key.model);
  const usd: Pick<Metrics, (typeof USD_FIELDS)[TokenType]> = { usdInput: 0, usdOutput: 0, usdCacheRead: 0, usdCacheWrite5m: 0, usdCacheWrite1h: 0 };
  let unpricedTokens = 0;
  for (const type of TOKEN_TYPES) {
    const perMillion = list?.[type] ?? null;
    if (perMillion === null) unpricedTokens += metrics[type];
    else usd[USD_FIELDS[type]] = (metrics[type] * perMillion) / 1e6;
  }
  let usdSaved = 0;
  const avoided = metrics.rewriteTokensAvoided;
  if (list !== null && list.cacheWrite5m !== null && list.cacheWrite1h !== null && avoided > 0) {
    const writeWeighted = metrics.savedInputEquivalent + weights.cacheRead * avoided;
    const oneHour = Math.min(avoided, Math.max(0, (writeWeighted - weights.cacheWrite5m * avoided) / (weights.cacheWrite1h - weights.cacheWrite5m)));
    usdSaved = ((avoided - oneHour) * list.cacheWrite5m + oneHour * list.cacheWrite1h - avoided * list.cacheRead) / 1e6;
  }
  const total = usd.usdInput + usd.usdOutput + usd.usdCacheRead + usd.usdCacheWrite5m + usd.usdCacheWrite1h;
  return { ...metrics, ...usd, usdRefresh: row.key.kind === "refresh" ? total : 0, usdSaved, unpricedTokens };
}
