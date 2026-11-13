/**
 * W615: a Claude Code PostToolUse hook that nudges an Initiative worker to batch its reads.
 *
 * Each request (one assistant response; its transcript entries share a message id) rereads the
 * whole conversation, so three reads in three requests cost about three times one request with
 * three parallel reads. The hook stays silent unless the 3 requests before this one each made
 * exactly one call, and that call only read: Read, Grep, Glob, or a Bash line of known reading
 * programs (anything else counts as not reading). Then it adds NUDGE to this call's result.
 *
 * The current request doesn't count: Claude Code writes a response's calls as they stream and
 * runs a read as soon as it arrives, so the first of three parallel reads finishes before the
 * transcript shows the other two. At most once per 3 requests: silent while NUDGE is attached to
 * this request or one of the 2 before (the transcript records it as a hook_additional_context
 * attachment). It reads only the transcript's last 2 MB; any error leaves it silent.
 *
 * A path-installed plugin runs from a bundle in BB's cache, with no stable path to a file of its
 * own, so the plugin writes the script beside its data (installBatchingNudge) and worker sessions
 * run it there with node.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NUDGE =
  "Your last 3 requests each made one read. Put independent reads in one message, or in one shell command: each request rereads the whole conversation.";

/** The hook: the tool call as JSON on stdin, the line to add (if any) as JSON on stdout. */
export const BATCHING_NUDGE_SCRIPT = String.raw`import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

const NUDGE = ${JSON.stringify(NUDGE)};
const WINDOW = 3;
const TAIL_BYTES = 2 * 1024 * 1024;

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
// Programs that only read, given the arguments readsOnly lets through. A program is on the list
// only if its writing or program-running options are few enough to reject them all.
const READ_PROGRAMS = new Set([
  "cat", "head", "tail", "sed", "grep", "rg", "ls", "find", "wc", "nl", "sort", "uniq", "cut", "tr",
  "diff", "stat", "du", "df", "pwd", "echo", "jq", "which", "basename", "dirname", "realpath",
  "readlink", "uptime", "cd", "git",
]);
const READ_GIT = new Set([
  "log", "diff", "show", "status", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "merge-base",
  "describe", "shortlog", "cat-file", "rev-list",
]);
// sed -n '40,120p', '1,5p;5q', '$p': line-number addresses printing or quitting, nothing else.
const SED_PRINT = /^(?:\s*(?:\d+|\$)(?:\s*,\s*(?:\d+|\$|\+\d+))?\s*[pq]\s*;?)+\s*$/;
// Arguments that make a program write or run another program. GNU and git long options also
// take any unambiguous prefix (--out=x is --output=x), hence the short prefixes; a short option
// can be bundled with others and carry its value attached (sort -uoout.txt).
const UNSAFE = {
  find: (a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a),
  sort: (a) => /^-[^-]*o/.test(a) || /^--(o|com)/.test(a),
  rg: (a) => /^--(pr|hostname-bin)/.test(a),
};

// sed reads when its only options are these flags and every script prints lines by number:
// anything else may hold a w (write) or e (execute) command.
function sedReads(args) {
  const scripts = [];
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[nEsz]*e$/.test(a) || a === "--expression") scripts.push(args[++i]);
    else if (/^-[nEsz]+$/.test(a) || a === "--quiet" || a === "--silent") continue;
    else if (a.startsWith("-")) return false;
    else operands.push(a);
  }
  if (scripts.length === 0) scripts.push(operands[0]);
  return scripts.every((script) => typeof script === "string" && SED_PRINT.test(script));
}

function gitReads(args) {
  let i = 0;
  while (args[i] === "-C" || args[i] === "--no-pager") i += args[i] === "-C" ? 2 : 1;
  const command = args[i];
  const rest = args.slice(i + 1);
  // --output writes; --ext-diff, --textconv and --filters run a helper program. Helpers that a
  // repo's own config turns on are out of scope: the label only decides an advisory nudge.
  if (!READ_GIT.has(command) || rest.some((a) => /^--(ou|ext|textc|filt)/.test(a))) return false;
  // git grep -O opens the matches in a pager or editor of the caller's choosing.
  return command !== "grep" || !rest.some((a) => /^-[^-]*O/.test(a) || /^--op/.test(a));
}

function readsOnly(words) {
  const [program, ...args] = words;
  if (!READ_PROGRAMS.has(program)) return false;
  if (program === "sed") return sedReads(args);
  if (program === "git") return gitReads(args);
  if (UNSAFE[program] && args.some(UNSAFE[program])) return false;
  // A second operand is an output file; after "--" it may start with a dash, and "-" is stdin.
  if (program === "uniq") return !args.includes("--") && args.filter((a) => a === "-" || !a.startsWith("-")).length <= 1;
  return true;
}

// What may follow ">": a stream thrown away or merged, never a file.
const HARMLESS_REDIRECT = /^>>?\s*(\/dev\/null|&[12])(?=$|[\s;|&)])/;
const BACKTICK = "\x60";
// Unquoted, these expand (parameters, braces, globs, ~, ANSI-C $'...') into words the checks
// below never see: sort --{output=x,unique} is sort --output=x --unique.
const EXPANDS = new Set(["$", "{", "}", "*", "?", "[", "]", "~", "!", BACKTICK]);

// The character a backslash keeps: none for a line continuation, which Bash removes
// (find . -de\<newline>lete is find . -delete).
const escaped = (c) => (c === undefined || c === "\n" ? "" : c);

// The commands of a shell line as lists of words, or null when the line can do more than run
// them (a substitution, a heredoc or a redirect into a file) or its words are not literal.
function shellCommands(line) {
  const commands = [[]];
  let word = "";
  let inWord = false;
  let quote = null;
  const flush = () => {
    if (inWord) commands[commands.length - 1].push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === BACKTICK || c === "$") return null;
      else if (c === "\\") word += escaped(line[++i]);
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\") {
      word += escaped(line[++i]);
      inWord = true;
    } else if (EXPANDS.has(c) || line.startsWith("<<", i) || line.startsWith("<(", i)) {
      return null;
    } else if (c === ">") {
      const redirect = HARMLESS_REDIRECT.exec(line.slice(i));
      if (!redirect) return null;
      if (/^\d$/.test(word)) word = ""; // the stream number in 2>
      flush();
      i += redirect[0].length - 1;
    } else if (c === "&" && line[i + 1] === ">") {
      flush(); // &> : the > comes next
    } else if (c === " " || c === "\t" || c === "<") {
      flush();
    } else if (c === "|" || c === "&" || c === ";" || c === "\n") {
      flush();
      if (commands[commands.length - 1].length > 0) commands.push([]);
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return null;
  flush();
  return commands.filter((words) => words.length > 0);
}

function isRead(call) {
  if (READ_TOOLS.has(call.name)) return true;
  if (call.name !== "Bash" || typeof call.input?.command !== "string") return false;
  const commands = shellCommands(call.input.command);
  return !!commands && commands.length > 0 && commands.every(readsOnly);
}

function tailLines(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift(); // cut mid-line
    return { lines, whole: length === size };
  } finally {
    closeSync(fd);
  }
}

function nudgeFor(transcriptPath, toolUseId) {
  const { lines, whole } = tailLines(transcriptPath);
  const requests = new Map(); // message id -> its tool calls, newest request first
  const nudged = new Set(); // ids of the calls NUDGE was attached to
  for (let i = lines.length - 1; i >= 0 && requests.size <= WINDOW + 1; i--) {
    const line = lines[i];
    if (!line.includes('"type":"assistant"') && !line.includes("hook_additional_context")) continue;
    const entry = JSON.parse(line);
    if (entry.type === "attachment" && entry.attachment?.type === "hook_additional_context") {
      if (entry.attachment.content?.includes(NUDGE)) nudged.add(entry.attachment.toolUseID);
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain || !entry.message?.id) continue;
    const calls = requests.get(entry.message.id) ?? [];
    for (const block of entry.message.content ?? [])
      if (block?.type === "tool_use") calls.unshift({ id: block.id, name: block.name, input: block.input });
    requests.set(entry.message.id, calls);
  }
  const [current, ...before] = [...requests.values()];
  if (!current?.some((call) => call.id === toolUseId) || current.length > 1) return null;
  // The oldest request counted is whole only if the tail also reached one before it.
  if (before.length < WINDOW + (whole ? 0 : 1)) return null;
  if ([current, ...before.slice(0, WINDOW - 1)].some((calls) => calls.some((call) => nudged.has(call.id)))) return null;
  return before.slice(0, WINDOW).every((calls) => calls.length === 1 && isRead(calls[0])) ? NUDGE : null;
}

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (!input.agent_id && typeof input.transcript_path === "string" && typeof input.tool_use_id === "string") {
    const line = nudgeFor(input.transcript_path, input.tool_use_id);
    if (line) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line } }));
  }
} catch {
  // Silent: a nudge is never worth a broken tool call.
}
`;

/** Writes the hook into `dir` unless it is already there, and returns the command that runs it. */
export function installBatchingNudge(dir: string): string {
  const path = join(dir, "batching-nudge.mjs");
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current !== BATCHING_NUDGE_SCRIPT) {
    mkdirSync(dir, { recursive: true });
    // A session may be running the old copy: replace it whole.
    writeFileSync(`${path}.${process.pid}`, BATCHING_NUDGE_SCRIPT);
    renameSync(`${path}.${process.pid}`, path);
  }
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
}
