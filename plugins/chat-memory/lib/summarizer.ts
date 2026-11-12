/**
 * The tree's summarizer: GPT-6 Luna through the Account Pooler's isolated route for plugins
 * (POST /advisor/v1/responses, authenticated with the Pooler's plugin token), so it uses the
 * accounts already in the pool and no credential of its own. Codex caches a repeated prefix
 * only with a session_id header (W216: prompt_cache_key alone got 0% cached), so every call of
 * one scope sends the same one. W587: when no Codex account can run Luna, the same request goes
 * to OpenAI's public API on a pay-as-you-go key (fallbackSummarizer, lib/pooler.ts).
 */
export const SUMMARIZER_MODEL = "gpt-6-luna";
export const POOLER_PLUGIN_ID = "account-pool-local";
/** List prices, $ per million tokens: input, cached input, output. Luna: W216, on either route. */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  [SUMMARIZER_MODEL]: { input: 0.1, cached: 0.01, output: 0.5 },
};

export type InputItem =
  | { role: "user" | "developer"; content: { type: "input_text"; text: string }[] }
  | { role: "assistant"; content: { type: "output_text"; text: string }[] };

/**
 * Who a call is for, so the Pooler's usage report can attribute it: the scope's first thread, its
 * Initiative when it has one, and why ("memory-tree"). Sent as the x-bb-thread, x-bb-initiative
 * and x-bb-purpose headers, which the Pooler's ledger reads and never forwards to the vendor.
 */
export interface Attribution {
  initiative: string | null;
  thread: string | null;
  purpose: string;
}

export interface SummarizerRequest {
  instructions: string;
  input: InputItem[];
  effort: string;
  /** One per scope: the prompt-cache session. */
  cacheKey: string;
  attribution?: Attribution;
  signal: AbortSignal;
  /** W315: the call gives up this long after it starts (its wait for a permit aside): reason "timeout". */
  timeoutMs?: number;
  /** The response started: its prefix is in the cache by now. */
  onStart?: () => void;
}
export interface Usage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}
/**
 * W371: what a final response was made of, kept to diagnose empty replies. Types, counts and
 * reasons only: never the prompt, a reply's text, a refusal or reasoning content.
 */
export interface ReplyShape {
  /** The stream's last event: response.completed or response.incomplete. */
  event: string;
  status: string | null;
  /** incomplete_details.reason, e.g. max_output_tokens. */
  incomplete: string | null;
  /** The output items' types, in order: reasoning, message, ... */
  items: string[];
  /** The content blocks' types, in order: output_text, refusal, ... */
  blocks: string[];
  output: number;
  reasoning: number;
}
/** model: the model that answered, which prices its usage; direct: paid on the OpenAI key, outside the Pooler. */
export type SummarizerResult =
  | { ok: true; text: string; usage: Usage; latencyMs: number; shape?: ReplyShape; model?: string; direct?: boolean }
  | {
      ok: false;
      error: string;
      /**
       * rate-limited: back off and retry (429, or no account eligible); transient: a 5xx or
       * dropped connection, retry soon; unavailable: the route is off or the Pooler is missing,
       * retry much later; failed: this request was refused, retrying it as-is won't help;
       * timeout: no reply within timeoutMs (a slow call, not a slow route), retry it alone.
       */
      reason: "rate-limited" | "transient" | "unavailable" | "failed" | "timeout" | "aborted";
      retryAfterMs?: number;
      usage?: Usage;
      model?: string;
      direct?: boolean;
    };
export type Summarizer = (request: SummarizerRequest) => Promise<SummarizerResult>;

/** A model missing from PRICES is priced as Luna. */
export const usageCost = (u: Usage, model = SUMMARIZER_MODEL) => {
  const p = PRICES[model] ?? PRICES[SUMMARIZER_MODEL]!;
  return ((u.input - u.cached) * p.input + u.cached * p.cached + u.output * p.output) / 1e6;
};

async function* sse(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let k: number;
    while ((k = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, k);
      buffer = buffer.slice(k + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data) as Record<string, any>;
    }
  }
}

const retryAfter = (value: string | null) => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

const attributionHeaders = (a?: Attribution): Record<string, string> =>
  a ? { ...(a.initiative ? { "x-bb-initiative": a.initiative } : {}), ...(a.thread ? { "x-bb-thread": a.thread } : {}), "x-bb-purpose": a.purpose } : {};

/**
 * A Responses API client. `url` and `headers` come from the caller: the Pooler route in the
 * plugin, the native pool route in the read-only measurement script, OpenAI's API (direct: its
 * calls carry none of the Pooler's headers, session_id and attribution, and say they were direct).
 */
export function responsesSummarizer(deps: {
  fetch: typeof fetch;
  url: () => string;
  headers: (signal: AbortSignal) => Promise<Record<string, string>>;
  model?: string;
  direct?: boolean;
}): Summarizer {
  const direct = deps.direct ? { direct: true } : {};
  const summarize = bounded(call);
  return async (request) => ({ ...(await summarize(request)), ...direct });

  async function call(signal: AbortSignal, { instructions, input, effort, cacheKey, attribution, onStart }: Omit<SummarizerRequest, "timeoutMs">): Promise<SummarizerResult> {
    const t0 = Date.now();
    let headers: Record<string, string>;
    try {
      // The lookup may not heed the signal (the Pooler's token RPC does not): the call stops with it anyway.
      headers = await untilAborted(deps.headers(signal), signal);
    } catch (error) {
      return { ok: false, reason: signal.aborted ? "aborted" : "unavailable", error: `credentials unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const body = { model: deps.model ?? SUMMARIZER_MODEL, instructions, input, stream: true, store: false, reasoning: { effort }, prompt_cache_key: cacheKey };
    let res: Response;
    try {
      res = await deps.fetch(deps.url(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...(deps.direct ? {} : { session_id: cacheKey, ...attributionHeaders(attribution) }), ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return { ok: false, reason: signal.aborted ? "aborted" : "transient", error: String(error) };
    }
    if (!res.ok || !res.body) return httpFailure(res);
    let started = false;
    let final: Record<string, any> | null = null;
    let finalEvent = "";
    try {
      for await (const event of sse(res.body)) {
        if (!started) {
          started = true;
          onStart?.();
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          final = event.response;
          finalEvent = event.type;
        } else if (event.type === "response.failed" || event.type === "error") {
          const error = JSON.stringify(event.response?.error ?? event.error ?? event).slice(0, 300);
          return { ok: false, reason: /rate|quota|limit/i.test(error) ? "rate-limited" : /overload|server_error|timeout/i.test(error) ? "transient" : "failed", error };
        }
      }
    } catch (error) {
      return { ok: false, reason: signal.aborted ? "aborted" : "transient", error: `stream: ${String(error)}` };
    }
    onStart?.();
    if (!final) return { ok: false, reason: "transient", error: "the stream ended without a response" };
    const u = final.usage ?? {};
    const usage: Usage = {
      input: u.input_tokens ?? 0,
      cached: u.input_tokens_details?.cached_tokens ?? 0,
      output: u.output_tokens ?? 0,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
    };
    const text = (final.output ?? [])
      .filter((o: { type?: string }) => o.type === "message")
      .flatMap((o: { content?: { type?: string; text?: string }[] }) => o.content ?? [])
      .filter((c: { type?: string }) => c.type === "output_text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
    const types = (list: { type?: unknown }[]) => list.map((x) => String(x?.type ?? "?").slice(0, 40));
    const items: { type?: unknown; content?: { type?: unknown }[] }[] = final.output ?? [];
    const shape: ReplyShape = {
      event: finalEvent,
      status: typeof final.status === "string" ? final.status : null,
      incomplete: typeof final.incomplete_details?.reason === "string" ? final.incomplete_details.reason : null,
      items: types(items),
      blocks: types(items.flatMap((o) => o.content ?? [])),
      output: usage.output,
      reasoning: usage.reasoning,
    };
    return { ok: true, text, usage, latencyMs: Date.now() - t0, shape, model: body.model };
  }
}

/**
 * The call, stopped by the caller's signal or after timeoutMs (reason "timeout"); a request
 * stopped before it starts (between its permit's grant and now) never starts.
 */
export function bounded(call: (signal: AbortSignal, request: Omit<SummarizerRequest, "timeoutMs">) => Promise<SummarizerResult>): Summarizer {
  return async ({ timeoutMs, ...request }) => {
    if (request.signal.aborted) return { ok: false, reason: "aborted", error: "stopped" };
    if (timeoutMs === undefined) return call(request.signal, request);
    // The call's own signal: the caller's stop, or the bound.
    const bound = new AbortController();
    const stop = () => bound.abort();
    request.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    try {
      const result = await call(bound.signal, request);
      return !result.ok && result.reason === "aborted" && !request.signal.aborted ? { ok: false, reason: "timeout", error: `no reply within ${timeoutMs / 1000} s` } : result;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", stop);
    }
  };
}

/** A refused HTTP response as a failure: its reason says when to try again. */
export async function httpFailure(res: Response): Promise<SummarizerResult & { ok: false }> {
  const text = (await res.text().catch(() => "")).slice(0, 300);
  const error = `${res.status} ${text}`;
  if (res.status === 429) return { ok: false, reason: "rate-limited", error, retryAfterMs: retryAfter(res.headers.get("retry-after")) };
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, reason: "unavailable", error };
  if (res.status >= 500 || res.status === 499) return { ok: false, reason: "transient", error, retryAfterMs: retryAfter(res.headers.get("retry-after")) };
  return { ok: false, reason: "failed", error };
}

/** How long the Pooler is skipped after a refusal without Retry-After, and at most. */
export const PRIMARY_BACKOFF = { default: 15 * 60_000, max: 60 * 60_000 };

/**
 * The primary summarizer (Luna on the Pooler), or the fallback (Luna on OpenAI's API) when the
 * primary is rate-limited or unavailable. After such a refusal the fallback goes first, with no
 * primary call, until the refusal's Retry-After (15 minutes without one, an hour at most) has
 * passed. One timestamp in memory: a restart tries the primary again. A fallback that answers
 * unavailable (no key, or a key refused) is no fallback: the primary's refusal stands and the next
 * call tries the primary again. When both refuse otherwise, the fallback's failure is the result,
 * and the builder backs off on it as before.
 */
export function fallbackSummarizer(primary: Summarizer, fallback: Summarizer, options: { now?: () => number; log?: (message: string) => void } = {}): Summarizer {
  const now = options.now ?? Date.now;
  let primaryUntil = 0;
  return async (request) => {
    let refused: (SummarizerResult & { ok: false }) | null = null;
    let opened = false;
    if (now() >= primaryUntil) {
      const r = await primary(request);
      if (r.ok || (r.reason !== "rate-limited" && r.reason !== "unavailable")) return r;
      refused = r;
      // Calls that were in flight together see the window a first one opened.
      opened = now() >= primaryUntil;
      primaryUntil = now() + Math.min(r.retryAfterMs ?? PRIMARY_BACKOFF.default, PRIMARY_BACKOFF.max);
    }
    const f = await fallback(request);
    if (!f.ok && f.reason === "unavailable") {
      primaryUntil = 0;
      return refused ?? f;
    }
    if (opened && refused) options.log?.(`Memory summarizer: the Pooler's ${SUMMARIZER_MODEL} is ${refused.reason} (${refused.error.slice(0, 120)}); OpenAI's API takes its calls for ${Math.round((primaryUntil - now()) / 60_000)} min.`);
    return f;
  };
}

/** The promise, or its signal's abort as a rejection, whichever comes first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
