/**
 * Credential-shaped text never leaves the plugin in a handover (W194): the writer's packet, the
 * plain fallback and the replay fixtures all go through this one redactor. It only knows
 * specific shapes, so ids, commit hashes, paths and names like DOPPLER_TOKEN stay readable.
 * It works line by line and in linear time: handover text can hold very long lines.
 */

/** Commands that set or reveal a secret: the whole command is dropped, continuation lines too. */
const SECRET_SETTER = /\b(?:bb secret|gh secret (?:set|edit)|doppler secrets (?:set|upload|download)|wrangler secret (?:put|bulk)|vercel env add|security add-generic-password|op item (?:create|edit))\b/;
/** Commands never listed as the coordinator's actions: secret setters and any `export X=`. */
export const SECRET_COMMAND = new RegExp(`${SECRET_SETTER.source}|\\bexport\\s+[A-Za-z_][A-Za-z0-9_]*=`);
const DROPPED = "[a command setting a secret, not shown]";

/**
 * A key name that says its value is a secret. Plural "tokens" (inputTokens, max_tokens) counts
 * tokens and is not one.
 */
const SECRET_KEY = /(?:token(?!s)|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?key)/i;

const LINE_RULES: [RegExp, string][] = [
  // Known key shapes.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "[redacted key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]"],
  [/\bdp\.(?:st|pt|sa|ct|scim|audit)\.[A-Za-z0-9_.-]{16,}/g, "[redacted token]"],
  [/\bBearer\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [redacted]"],
  // Credentials in URLs: a password before @, or a secret-named query parameter.
  [/(:\/\/[^/\s:@]+:)(?!\[redacted)[^@\s/]{6,}@/g, "$1[redacted]@"],
  [/([?&#](?:access_token|token|key|api[_-]?key|secret|password|auth|code|sig|signature|session)=)(?!\[redacted)[^&#\s"'`)\]]{6,}/gi, "$1[redacted]"],
  // A quoted or backticked token-like value named in prose ("the console token `Y969NG9…`"): 16+
  // characters mixing upper case, lower case and digits, a few words after a credential word.
  // Hex hashes, BB ids, op markers, paths and ALL_CAPS names never mix all three, and a slug
  // with more than two separators is a name, not a token, so they stay.
  // (Case-sensitive on purpose: with /i the upper/lower lookaheads would accept a hex hash.)
  [/(\b(?:[Tt]okens?|TOKENS?|[Kk]eys?|KEYS?|[Ss]ecrets?|SECRETS?|[Pp]asswords?|PASSWORDS?|[Cc]redentials?|CREDENTIALS?|(?:[Aa]pi|API)[ _-]?(?:[Kk]eys?|KEYS?))\b[^\n`'"]{0,40}?[`'"])(?=[A-Za-z0-9_\-+/=.]{16,}[`'"])(?=(?:[^`'"\s_.-]*[_.-]){0,2}[^`'"\s_.-]*[`'"])(?=[^`'"\s]*[A-Z])(?=[^`'"\s]*[a-z])(?=[^`'"\s]*[0-9])[A-Za-z0-9_\-+/=.]{16,}([`'"])/g, "$1[redacted]$2"],
];

/**
 * KEY=value, key: value and JSON "key": "value" when the key names a secret: any non-empty value
 * goes, whatever its characters (numbers, leading punctuation). One pass over the words of the
 * line, so a long line costs linear time. `pending` is true when the line ends with such a key
 * and no value (or a YAML block marker): the value is on the next non-empty line.
 */
function redactAssignments(line: string): { line: string; pending: boolean } {
  const word = /[A-Za-z0-9_.-]+/g;
  let out = "";
  let from = 0;
  let pending = false;
  for (let m = word.exec(line); m; m = word.exec(line)) {
    if (!SECRET_KEY.test(m[0])) continue;
    // A file reference is not a key: /repo/lib/secret.ts:123, lib/password.ts:55, [x](token.ts:42).
    const before = line[m.index - 1];
    if (before === "/" || before === "\\" || before === ".") continue;
    let i = m.index + m[0].length;
    if (/\.[A-Za-z0-9]{1,8}$/.test(m[0]) && line[i] === ":" && /[0-9]/.test(line[i + 1] ?? "")) continue;
    if (line[i] === '"' || line[i] === "'") i++;
    while (line[i] === " " || line[i] === "\t") i++;
    if (line[i] !== ":" && line[i] !== "=") continue;
    i++;
    while (line[i] === " " || line[i] === "\t") i++;
    if (i >= line.length || /^[|>][-+]?\s*$/.test(line.slice(i))) {
      pending = true;
      break;
    }
    const quote = line[i] === '"' || line[i] === "'" || line[i] === "`" ? line[i] : null;
    const start = quote ? i + 1 : i;
    let end = start;
    if (quote) {
      while (end < line.length && line[end] !== quote) end += line[end] === "\\" ? 2 : 1;
    } else {
      // An unquoted value runs to whitespace or a separator; objects and lists are not values.
      if (line[start] === "{" || line[start] === "[") continue;
      while (end < line.length && !/[\s,;)\]}]/.test(line[end]!)) end++;
    }
    end = Math.min(end, line.length);
    if (end <= start || line.slice(start, end) === "[redacted]") continue;
    out += `${line.slice(from, start)}[redacted]`;
    from = end;
    // Every loop here moves forward: the scan resumes after the value, never before the key.
    word.lastIndex = Math.max(end, m.index + m[0].length);
  }
  return { line: out + line.slice(from), pending };
}

/** A heredoc opened on a command line: its terminator word. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
/** A secret command's heredoc body ends within this many lines, or the rest of the text goes. */
const HEREDOC_MAX = 200;

export function redactCredentials(text: string): string {
  // Private keys span lines.
  const keyless = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[^]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]");
  const lines = keyless.split("\n");
  const out: string[] = [];
  // One pass with one bit of state: a secret-named key whose value is on the next line.
  let pending = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (SECRET_SETTER.test(line)) {
      // The whole logical command: a line ending in a backslash continues on the next, and a
      // heredoc runs to its terminator.
      let terminator: string | null = HEREDOC.exec(line)?.[2] ?? null;
      while (/\\\s*$/.test(lines[i]!) && i + 1 < lines.length) {
        i++;
        terminator ??= HEREDOC.exec(lines[i]!)?.[2] ?? null;
      }
      if (terminator) {
        let end = -1;
        for (let j = i + 1; j < Math.min(lines.length, i + 1 + HEREDOC_MAX); j++)
          if (lines[j]!.trim() === terminator) { end = j; break; }
        i = end === -1 ? lines.length : end;
      }
      out.push(DROPPED);
      pending = false;
      continue;
    }
    if (pending && line.trim()) {
      out.push(`${/^\s*/.exec(line)![0]}[redacted]${/,\s*$/.test(line) ? "," : ""}`);
      pending = false;
      continue;
    }
    for (const [rule, replacement] of LINE_RULES) line = line.replace(rule, replacement);
    const done = redactAssignments(line);
    out.push(done.line);
    pending ||= done.pending;
  }
  return out.join("\n");
}

/** Every string inside a value, redacted (snapshots before the packet is budgeted). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactCredentials(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}
