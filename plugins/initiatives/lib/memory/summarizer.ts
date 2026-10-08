/**
 * The tree's summarizer: GPT-6 Luna through the Account Pooler's isolated route for plugins
 * (POST /advisor/v1/responses, authenticated with the Pooler's plugin token), so it uses the
 * accounts already in the pool and no credential of its own. Codex caches a repeated prefix
 * only with a session_id header (W216: prompt_cache_key alone got 0% cached), so every call of
 * one Initiative sends the same one.
 */
export const SUMMARIZER_MODEL = "gpt-6-luna";
export const POOLER_PLUGIN_ID = "account-pool-local";
/** Luna list prices, $ per million tokens (W216): input, cached input, output. */
export const LUNA_PRICES = { input: 0.1, cached: 0.01, output: 0.5 } as const;

export type InputItem =
  | { role: "user"; content: { type: "input_text"; text: string }[] }
  | { role: "assistant"; content: { type: "output_text"; text: string }[] };

export interface SummarizerRequest {
  instructions: string;
  input: InputItem[];
  effort: string;
  /** One per Initiative: the prompt-cache session. */
  cacheKey: string;
  signal: AbortSignal;
  /** The response started: its prefix is in the cache by now. */
  onStart?: () => void;
}
export interface Usage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}
export type SummarizerResult =
  | { ok: true; text: string; usage: Usage; latencyMs: number }
  | {
      ok: false;
      error: string;
      /**
       * rate-limited: back off and retry (429, or no account eligible); transient: a 5xx or
       * dropped connection, retry soon; unavailable: the route is off or the Pooler is missing,
       * retry much later; failed: this request was refused, retrying it as-is won't help.
       */
      reason: "rate-limited" | "transient" | "unavailable" | "failed" | "aborted";
      retryAfterMs?: number;
      usage?: Usage;
    };
export type Summarizer = (request: SummarizerRequest) => Promise<SummarizerResult>;

export const usageCost = (u: Usage) =>
  ((u.input - u.cached) * LUNA_PRICES.input + u.cached * LUNA_PRICES.cached + u.output * LUNA_PRICES.output) / 1e6;

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

/**
 * A Responses API client. `url` and `headers` come from the caller: the Pooler route in the
 * plugin, the native pool route in the read-only measurement script.
 */
export function responsesSummarizer(deps: {
  fetch: typeof fetch;
  url: () => string;
  headers: (signal: AbortSignal) => Promise<Record<string, string>>;
  model?: string;
}): Summarizer {
  return async ({ instructions, input, effort, cacheKey, signal, onStart }) => {
    const t0 = Date.now();
    let headers: Record<string, string>;
    try {
      headers = await deps.headers(signal);
    } catch (error) {
      return { ok: false, reason: signal.aborted ? "aborted" : "unavailable", error: `Account Pooler token unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const body = { model: deps.model ?? SUMMARIZER_MODEL, instructions, input, stream: true, store: false, reasoning: { effort }, prompt_cache_key: cacheKey };
    let res: Response;
    try {
      res = await deps.fetch(deps.url(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", session_id: cacheKey, ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return { ok: false, reason: signal.aborted ? "aborted" : "transient", error: String(error) };
    }
    if (!res.ok || !res.body) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const error = `${res.status} ${text}`;
      if (res.status === 429) return { ok: false, reason: "rate-limited", error, retryAfterMs: retryAfter(res.headers.get("retry-after")) };
      if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, reason: "unavailable", error };
      if (res.status >= 500 || res.status === 499) return { ok: false, reason: "transient", error, retryAfterMs: retryAfter(res.headers.get("retry-after")) };
      return { ok: false, reason: "failed", error };
    }
    let started = false;
    let final: Record<string, any> | null = null;
    try {
      for await (const event of sse(res.body)) {
        if (!started) {
          started = true;
          onStart?.();
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") final = event.response;
        else if (event.type === "response.failed" || event.type === "error") {
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
    return { ok: true, text, usage, latencyMs: Date.now() - t0 };
  };
}
