import { z } from "zod";
import type { RuleRecord } from "./store";

// Standing rules (D518, D523): the lasting choices every lead and worker follows. BB cuts a
// plugin's instructions at 4096 characters, so the full list never goes there: it travels in
// briefs, work messages, each coordinator's first message and initiative_read {view:"rules"};
// the instructions carry only a pointer (instructions.ts).

export const MAX_RULES = 60;
export const RULE_MAX_CHARACTERS = 400;

/**
 * What a rule may say: one line of one or two sentences, and sources without commas, so every
 * rule the dashboard, CLI or agent tool accepts round-trips through a rules file.
 */
export const ruleText = z.string().trim().min(1).max(RULE_MAX_CHARACTERS).refine((t) => !/[\r\n]/.test(t), "A rule is one line: one or two sentences.");
export const ruleSources = z.array(z.string().trim().min(1).max(40).refine((t) => !/[,\r\n]/.test(t), "A source is one name without commas, e.g. D12.")).max(20);

const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** "8, last changed 2026-10-14 10:12" (UTC). */
export const rulesCount = (rules: readonly RuleRecord[]) => {
  const changed = rules.reduce((max, r) => Math.max(max, r.updatedAt), 0);
  return `${rules.length}${changed ? `, last changed ${stamp(changed)} UTC` : ""}`;
};

/** The full numbered list, as briefs, work messages and a coordinator's first message end. */
export function renderRules(rules: readonly RuleRecord[], heading = "Standing rules"): string {
  if (!rules.length) return `${heading}: none yet.`;
  return [`${heading} (${rulesCount(rules)}). The full list; follow it:`, ...rules.map((r) => `${r.ref}. ${r.text}`)].join("\n");
}

/**
 * A rules file, for `bb initiative rules import` and its undo: one rule per line, "R5. <text>",
 * optionally followed by an indented "Sources: D12, D40" line. Headings (#) and blank lines are
 * ignored. Writing then reading a list gives back the same numbers, order, text and sources.
 */
export function formatRulesFile(name: string, rules: readonly Pick<RuleRecord, "num" | "text" | "sources">[]): string {
  return [`# Standing rules · ${name}`, "", ...rules.flatMap((r) => [`R${r.num}. ${r.text}`, ...(r.sources.length ? [`    Sources: ${r.sources.join(", ")}`] : [])]), ""].join("\n");
}

export function parseRulesFile(text: string): { num: number; text: string; sources: string[] }[] {
  const rules: { num: number; text: string; sources: string[] }[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const rule = /^R([1-9]\d*)\.\s+(.+?)\s*$/.exec(line);
    const sources = /^\s+Sources:\s*(.*?)\s*$/.exec(line);
    if (rule) rules.push({ num: Number(rule[1]), text: rule[2]!, sources: [] });
    else if (sources && rules.length && !rules.at(-1)!.sources.length)
      rules.at(-1)!.sources = sources[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (line.trim() && !line.startsWith("#")) problems.push(`line ${index + 1}: expected "R<n>. <rule>" or an indented "Sources: …" line`);
  });
  const seen = new Set<number>();
  for (const r of rules) {
    if (seen.has(r.num)) problems.push(`R${r.num} appears twice`);
    seen.add(r.num);
    if (r.text.length > RULE_MAX_CHARACTERS) problems.push(`R${r.num} has ${r.text.length} characters; a rule has at most ${RULE_MAX_CHARACTERS}`);
  }
  if (rules.length > MAX_RULES) problems.push(`${rules.length} rules; an Initiative has at most ${MAX_RULES}`);
  if (problems.length) throw new Error(`The rules file can't be imported: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; ${problems.length - 5} more` : ""}.`);
  return rules;
}
