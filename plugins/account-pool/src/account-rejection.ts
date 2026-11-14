// Whether an API-key account's 4xx is about the account (terms or a policy to accept, billing,
// credits or quota, a key or account that is invalid or disabled) rather than about the request (a
// malformed body, a model the gateway does not serve). An account-level refusal will answer every
// request the same way until someone acts, so the hub holds the whole account and fails over, as
// for a 429; a request-level one keeps the existing per-model path.

// Error types that name the account whatever the message says (Anthropic's error.type).
const ACCOUNT_ERROR_TYPES = new Set(["authentication_error", "billing_error"]);

// Phrases that only a refusal about the account uses. Each needs a verb or a qualifier, never a
// bare word: a malformed request may well name a field, a tool or a model "payment" or "terms".
const ACCOUNT_MESSAGES: readonly RegExp[] = [
  // "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them…"
  /\b(?:updated|changed) (?:our|the|its)\b[^.]*\b(?:terms|privacy policy|usage policy)\b/i,
  /\b(?:accept|agree to) (?:the |our |its |updated |new )*(?:[\w-]+ )?(?:terms|privacy policy|usage policy)\b/i,
  // "Your credit balance is too low…", "insufficient credits", "You have reached your specified API
  // usage limits", "You exceeded your current quota", "payment required".
  /\bcredit balance\b|\b(?:insufficient|out of|no remaining) (?:credits?|funds|balance)\b/i,
  /\b(?:exceeded|reached)\b[^.]*\b(?:quota|spend(?:ing)? limits?|usage limits?)\b/i,
  /\b(?:billing|payment)\b[^.]*\b(?:required|failed|overdue|past due)\b/i,
  // "This organization has been disabled.", "Your API key has been revoked.", "Invalid API key"
  /\b(?:account|organi[sz]ation|workspace|api[ -]?key)\b[^.]*\b(?:has been|is|was) (?:disabled|suspended|deactivated|banned|revoked|expired)\b/i,
  /\b(?:invalid|expired|revoked) (?:x-)?api[ -]?key\b/i,
];

// The upstream's message when the refusal is about the account, else null. `body` is the start of
// the error body (JSON in the Anthropic shape, or plain text). A 401 is about the key, a 402 about
// payment, whatever the body says.
export function accountRejection(status: number, body: string): string | null {
  if (status < 400 || status >= 500) return null;
  const { type, message } = errorOf(body);
  if (
    status === 401 ||
    status === 402 ||
    (type !== null && ACCOUNT_ERROR_TYPES.has(type))
  )
    return message || `HTTP ${status}`;
  return ACCOUNT_MESSAGES.some((pattern) => pattern.test(message))
    ? message
    : null;
}

// The same message told twice is one alert: case, spacing, numbers and request ids aside.
export function normalizedRejection(message: string): string {
  return message
    .toLowerCase()
    .replace(/\b[a-z]+_[a-z0-9]{8,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function errorOf(body: string): { type: string | null; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { type: null, message: body.trim() };
  }
  const error = isRecord(parsed)
    ? isRecord(parsed.error)
      ? parsed.error
      : parsed
    : null;
  const type =
    error !== null && typeof error.type === "string" ? error.type : null;
  const message =
    error !== null && typeof error.message === "string"
      ? error.message
      : isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : body.trim();
  return { type, message: message.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
