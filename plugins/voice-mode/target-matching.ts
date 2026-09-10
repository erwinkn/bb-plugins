/** Ranked, tolerant matching of spoken descriptions against thread, project, and profile names.
 * Speech gives approximate words: "BB plugin" for bb-plugins, "planned" for plans. Exact
 * all-token matching cannot resolve them, so every candidate gets a score and the caller ranks.
 */

/** Words that describe a kind of target or a relation, not the target itself. */
const NEUTRAL = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "with", "that", "this", "these", "those", "our", "my", "your", "its", "their",
  "one", "some", "any", "all", "at", "by", "as", "so", "up", "out", "from", "into", "about", "like", "than", "then", "too", "very", "also", "here", "there",
  "we", "you", "it", "me", "us", "them", "they", "he", "she", "him", "her", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "did", "does", "can", "could", "would", "should", "will", "what", "which", "who", "when", "where", "how", "please",
  "thread", "threads", "project", "projects", "repo", "repository", "worker", "workers", "task", "tasks", "session", "call", "space", "spaces",
  "latest", "recent", "recently", "newest", "new", "last", "current", "just", "now", "child", "children", "parent", "sub", "main"]);

export function tokenize(text: string | null | undefined): string[] {
  return ((text ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 2);
}
/** Query tokens that carry meaning. An empty list means "anything", ranked by recency. */
export function queryTokens(query: string): string[] { return tokenize(query).filter(word => !NEUTRAL.has(word)); }

function editDistance(a: string, b: string): number {
  const rows = a.length + 1, cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i < rows; i++) for (let j = 1; j < cols; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** 1 for equal words, 0.9 for a shared stem (plan, plans, planned), 0.8 for a small typo, else 0. */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return 0.9;
  if (short.length >= 4) {
    const stem = Math.min(short.length, long.length) - 1;
    if (stem >= 4 && short.slice(0, stem) === long.slice(0, stem)) return 0.85;
    const allowed = short.length >= 7 ? 2 : 1;
    if (editDistance(short, long) <= allowed) return 0.8;
  }
  return 0;
}

/** Share of query tokens found in the candidate name, between 0 and 1. No query tokens match everything. */
export function scoreName(tokens: string[], name: string): number {
  if (tokens.length === 0) return 1;
  const words = tokenize(name);
  let total = 0;
  for (const token of tokens) total += words.reduce((best, word) => Math.max(best, tokenSimilarity(token, word)), 0);
  return Math.round((total / tokens.length) * 100) / 100;
}

export interface Ranked<T> { item: T; match: number }
/** Rank candidates by score, then by a recency key. Items under the threshold are dropped. */
export function rank<T>(items: T[], tokens: string[], name: (item: T) => string, recency: (item: T) => number, options: { threshold?: number; limit?: number } = {}): Ranked<T>[] {
  const { threshold = 0.5, limit = 30 } = options;
  return items.map(item => ({ item, match: scoreName(tokens, name(item)) })).sort((a, b) => b.match - a.match || recency(b.item) - recency(a.item))
    .filter(entry => entry.match >= threshold).slice(0, limit);
}

/** Resolve a spoken or guessed name against a small closed set. Returns the unique best match above 0.6, else null. */
export function resolveName<T>(query: string, items: T[], name: (item: T) => string): T | null {
  const wanted = tokenize(query);
  if (wanted.length === 0) return null;
  const exact = items.find(item => tokenize(name(item)).join(" ") === wanted.join(" "));
  if (exact) return exact;
  const ranked = rank(items, wanted, name, () => 0, { threshold: 0.6, limit: 2 });
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0].match === ranked[1].match)) return null;
  return ranked[0].item;
}
