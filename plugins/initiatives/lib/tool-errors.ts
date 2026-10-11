import { z } from "zod";
import { ProjectError } from "./bb";
import { PR_NOTE_FIELDS, PR_STATE_FIELDS } from "./pr-stages";

/**
 * T147: what a tool call that fails validation answers with. Help costs tokens only when a call
 * is wrong, so it lives here and not in the upfront tool schemas: the nearest valid key for an
 * unknown one, the keys that exist, and what to change, in words.
 */

/** A call refused for its arguments; initiative_batch leads it with the action's index. */
export class ToolInputError extends ProjectError {}

type Path = readonly PropertyKey[];

const PR_FIELDS_HINT = "`prs:[{url,…}]` (PR fields go inside `prs`, one object per PR)";
/**
 * Guesses seen in real calls, keyed by tool and, below the root, the object's path (array items
 * as []). Each reads as "did you mean <hint>?". A wrong key is never accepted or renamed.
 */
const HINTS: Record<string, Record<string, string>> = {
  initiative_spawn: { brief: "`text`", prompt: "`text`", instructions: "`text`", description: "`purpose` (a few words) or `text` (the brief)", worktree: '`environment:{type:"worktree"}`', name: "`label`", title: "`label`", model: "`profile` (an explicit model) or `kind`" },
  initiative_message: { worker: "`to`", recipient: "`to`", message: "`text`", body: "`text`", content: "`text`" },
  initiative_task: { summary: "`text`", description: "`text`", body: "`text`", name: "`title`", id: "`task`", ref: "`task`", status: "`action` (close or reopen)" },
  initiative_worker: { ref: "`worker`", id: "`worker`", thread: "`threadId`", name: "`label`" },
  initiative_report: { body: "`report`", details: "`report`", text: "`summary` (short) and `report` (full)" },
  initiative_read: { id: "`refs`", ref: "`refs`", kind: "`view`", type: "`view`", page: "`offset`", count: "`limit`", n: "`limit`", full: "`detailed`", verbose: "`detailed`" },
  initiative_batch: { calls: "`actions`", tools: "`actions`", operations: "`actions`" },
  initiative_pr: Object.fromEntries(["url", "stage", "note", ...PR_STATE_FIELDS, ...PR_NOTE_FIELDS].map(key => [key, PR_FIELDS_HINT])),
  "initiative_pr.prs[]": { status: "`stage`", link: "`url`", pr: "`url`", message: "`note`" },
};
/** Keys that exist for older sessions only; never listed as valid. */
const LEGACY_KEYS: Record<string, string[]> = { initiative_message: ["target"], initiative_update: ["checkpoint"] };
/** Short fields: a long value belongs in `text` where the tool has one. */
const SHORT_FIELDS = ["title", "label", "purpose", "summary"];

/** Own entries only: a rejected key named toString or constructor is just a name. */
const own = <T,>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined => record && Object.hasOwn(record, key) ? record[key] : undefined;
/** The most distinct problems named in one error, the most places and names listed for one problem, and the longest name echoed back. */
const MAX_PROBLEMS = 4, MAX_PLACES = 3, MAX_NAME = 40, MAX_NAMES = 6, MAX_ISSUES_BYTES = 1500;
/** The most one error may take of a batch response: its problems and the lead-in fit. */
export const MAX_ERROR_BYTES = 2048;
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What the text costs inside a JSON string: UTF-8 bytes, escapes counted. */
const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;
/** The text, or its longest start that still serializes within max bytes with an ellipsis. */
export function clipBytes(text: string, max: number) {
  const ellipsis = jsonBytes("…");
  let used = 0, seen = 0, end = 0;
  for (const char of text) {
    used += jsonBytes(char);
    seen += char.length;
    if (used + ellipsis <= max) end = seen;
    if (used > max) return `${text.slice(0, end)}…`;
  }
  return text;
}

const tick = (names: readonly string[]) => names.slice(0, MAX_NAMES).map(name => `\`${clip(name, MAX_NAME)}\``).join(", ") + (names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : "");

/** Edit distance where swapping two neighbours (titel, title) costs one. */
function distance(a: string, b: string) {
  const rows = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
    }
  }
  return rows[a.length]![b.length]!;
}

/** The valid name closest to a wrong one: same letters in another case, one name inside the other, or a small edit away. */
export function nearest(name: string, valid: readonly string[]): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null, bestDistance = Infinity;
  for (const candidate of valid) {
    const other = candidate.toLowerCase();
    const [short, long] = lower.length < other.length ? [lower, other] : [other, lower];
    const d = other === lower ? 0 : short.length >= 4 && long.includes(short) ? 1 : distance(lower, other);
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best !== null && bestDistance <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

type Context = { tool: string; schema: z.ZodType; raw: unknown; json?: Record<string, any> | null };
type Problem = { text: string; help?: string };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const valueAt = (raw: unknown, path: Path) => path.reduce<unknown>((value, key) => isObject(value) && Object.hasOwn(value, key) ? value[key as string] : undefined, raw);

/** Look through nullable/union wrappers to the object or array node; a union's branch is the one the value's discriminator selects. */
function settle(node: any, value: unknown): any {
  if (!node || node.properties || node.items) return node;
  const branches = [...(node.anyOf ?? node.oneOf ?? [])].map(branch => settle(branch, value)).filter(branch => branch?.properties || branch?.items);
  const given = isObject(value) ? value : {};
  const selected = branches.find(branch => Object.entries<any>(branch.properties ?? {}).every(([key, prop]) => !("const" in prop) || (Object.hasOwn(given, key) && given[key] === prop.const)));
  return selected ?? branches[0] ?? node;
}

/** The JSON Schema node at a path, following the call's own values through unions. */
function nodeAt(ctx: Context, path: Path): Record<string, any> | null {
  if (ctx.json === undefined) {
    try { ctx.json = z.toJSONSchema(ctx.schema, { io: "input" }); } catch { ctx.json = null; }
  }
  let node: any = ctx.json;
  for (const [index, key] of path.entries()) {
    node = settle(node, valueAt(ctx.raw, path.slice(0, index)));
    node = typeof key === "number" ? node?.items : own(node?.properties, String(key));
  }
  return settle(node, valueAt(ctx.raw, path)) ?? null;
}

const label = (tool: string, path: Path) => path.length ? path.reduce<string>((out, key) => typeof key === "number" ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key), "") : tool;
const hintKey = (tool: string, path: Path) => tool + path.map(key => typeof key === "number" ? "[]" : `.${String(key)}`).join("");

const validKeys = (ctx: Context, path: Path) =>
  Object.keys(nodeAt(ctx, path)?.properties ?? {}).filter(name => !own(LEGACY_KEYS, hintKey(ctx.tool, path))?.includes(name));

/** What an unknown key was meant to be: a known guess, else the nearest valid key the object does not already have. */
function guess(ctx: Context, path: Path, name: string, given: unknown): string | null {
  const known = own(own(HINTS, hintKey(ctx.tool, path)), name);
  if (known) return known;
  const close = nearest(name, validKeys(ctx, path).filter(v => !(isObject(given) && Object.hasOwn(given, v))));
  return close && `\`${close}\``;
}

/** Unknown keys: the meant key where known, then what exists (the second part once per kind of object). */
function unknownKeys(ctx: Context, path: Path, keys: readonly string[], helped: Set<string>): Problem {
  const key = hintKey(ctx.tool, path);
  const valid = validKeys(ctx, path);
  const given = valueAt(ctx.raw, path);
  const meant = new Map<string | null, string[]>();
  for (const name of keys) {
    const said = guess(ctx, path, name, given);
    meant.set(said, [...(meant.get(said) ?? []), name]);
  }
  const sentences = [...meant].map(([said, names]) =>
    `${tick(names)} ${names.length > 1 ? "are not keys" : "is not a key"} of ${label(ctx.tool, path)}${said ? `; did you mean ${said}?` : "."}`);
  const first = !helped.has(key);
  helped.add(key);
  return { text: sentences.join(" "), ...(valid.length && first ? { help: `Valid keys: ${valid.join(", ")}.` } : {}) };
}

function describe(ctx: Context, issue: z.core.$ZodIssue, helped: Set<string>): Problem {
  const path = issue.path;
  const where = path.map(String).join(".") || "(input)";
  const name = String(path.at(-1) ?? "input");
  const value = valueAt(ctx.raw, path);
  if (issue.code === "unrecognized_keys") return unknownKeys(ctx, path, issue.keys, helped);
  if (issue.code === "invalid_type") {
    if (value === undefined) return { text: `\`${where}\` is required.` };
    // A JSON string where the structure itself belongs: agents serialize it by habit.
    if (typeof value === "string" && (issue.expected === "array" || issue.expected === "object") && /^\s*[[{]/.test(value))
      return { text: `\`${where}\` is a JSON string; pass ${issue.expected === "array" ? "an array" : "an object"}, not a JSON string.` };
  }
  if (issue.code === "too_big" && issue.origin === "string" && typeof value === "string") {
    const longText = SHORT_FIELDS.includes(name) && Object.hasOwn(nodeAt(ctx, path.slice(0, -1))?.properties ?? {}, "text") ? ` Put the long text in \`text\` and keep \`${name}\` short.` : "";
    return { text: `\`${where}\` is ${value.length} characters; at most ${issue.maximum} fit.${longText}` };
  }
  if (issue.code === "invalid_value" && name === "tool" && typeof value === "string" && value.startsWith("initiative_")) {
    const allowed = issue.values.map(String);
    const bare = value.slice("initiative_".length);
    return { text: allowed.includes(bare)
      ? `\`${where}\` is "${clip(value, MAX_NAME)}"; drop the initiative_ prefix ("${bare}").`
      : `\`${where}\` is "${clip(value, MAX_NAME)}", which a batch cannot run. Use one of ${allowed.join(", ")} (without the initiative_ prefix); any other tool is called on its own.` };
  }
  return { text: `${where}: ${issue.message}.`.replace(/\.+$/, ".") };
}

/** The issues worth saying: a wrong type hides the checks that ran on it anyway. */
function reported(issues: z.core.$ZodIssue[]) {
  const wrongType = new Set(issues.filter(issue => issue.code === "invalid_type").map(issue => issue.path.join(".")));
  return issues.filter(issue => issue.code === "invalid_type" || !wrongType.has(issue.path.join(".")));
}

/**
 * The problems of one call, bounded: the same problem in many places (100 PRs, each with the same
 * wrong key) is one sentence naming the first few places, and the whole is clipped.
 */
function problemsOf(ctx: Context, issues: z.core.$ZodIssue[]) {
  const groups = new Map<string, { issue: z.core.$ZodIssue; places: string[] }>();
  for (const issue of issues) {
    const kind = issue.path.map(key => typeof key === "number" ? "[]" : String(key)).join(".");
    const id = [kind, issue.code, issue.code === "unrecognized_keys" ? issue.keys.join(",") : issue.message].join("|");
    const group = groups.get(id) ?? { issue, places: [] };
    group.places.push(label(ctx.tool, issue.path));
    groups.set(id, group);
  }
  const helped = new Set<string>();
  const sentences = [...groups.values()].slice(0, MAX_PROBLEMS).map(({ issue, places }) => {
    const { text, help } = describe(ctx, issue, helped);
    const more = places.length - 1;
    const same = more > 0 ? ` Same at ${places.slice(1, MAX_PLACES + 1).join(", ")}${more > MAX_PLACES ? ` and ${more - MAX_PLACES} more` : ""}.` : "";
    return `${text}${same}${help ? ` ${help}` : ""}`;
  });
  const left = groups.size - MAX_PROBLEMS;
  return clipBytes(`${sentences.join(" ")}${left > 0 ? ` And ${left} more kind${left === 1 ? "" : "s"} of problem.` : ""}`, MAX_ISSUES_BYTES);
}

export function toolInputMessage<T>(tool: string, schema: z.ZodType<T>, raw: unknown, error: z.ZodError) {
  return `Invalid arguments for ${tool}: ${problemsOf({ tool, schema, raw }, reported(error.issues))}`;
}

/** Parse a tool's arguments, or throw an error that names the fix. */
export function parseToolInput<T>(schema: z.ZodType<T>, raw: unknown, tool: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ToolInputError(toolInputMessage(tool, schema, raw, result.error));
  return result.data;
}
