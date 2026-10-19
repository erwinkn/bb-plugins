/**
 * W516: GitHub's GraphQL API over HTTP, from the server process itself. Each `gh api graphql`
 * forked the 2.6 GB BB server; 23 of 55 event-loop stalls on 2026-10-18 had that spawn on top
 * (W515). The token comes from `gh auth token`, read once and again after a 401: one spawn
 * per server life, not one per request.
 */

/** Runs one GraphQL query and resolves its `data`, failing after `timeoutMs`. */
export type GraphQl = (query: string, variables: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

/** Running totals, for measuring what a refresh costs (W516's report). */
export interface GraphQlStats {
  requests: number;
  bytes: number;
}

const ENDPOINT = "https://api.github.com/graphql";

/**
 * A GraphQl over `fetch` with the token `token()` resolves. A failed token read is read again
 * by the next request; a 401 reads it again once and retries, so `gh auth login` or a rotated
 * token heals without a restart. An answer with GraphQL errors fails whole, as `gh api graphql`
 * did: no list goes short on a partial answer.
 */
export function githubGraphQl(
  token: () => Promise<string>,
  options: { fetch?: typeof fetch; stats?: GraphQlStats } = {},
): GraphQl {
  let cached: Promise<string> | null = null;
  const current = () => {
    if (cached) return cached;
    const read = token().then((value) => {
      const trimmed = value.trim();
      if (!trimmed) throw new Error("gh auth token printed no token: run `gh auth login` on the BB server");
      return trimmed;
    });
    read.catch(() => {
      if (cached === read) cached = null;
    });
    return (cached = read);
  };
  const post = async (query: string, variables: Record<string, unknown>, deadline: number, timeoutMs: number) => {
    const timedOut = () => new Error(`GitHub didn't answer within ${Math.ceil(timeoutMs / 1000)} s`);
    const used = current();
    const auth = await beforeDeadline(used, deadline, timedOut);
    const left = deadline - Date.now();
    if (left <= 0) throw timedOut();
    let response: Response;
    let text: string;
    try {
      response = await (options.fetch ?? fetch)(ENDPOINT, {
        method: "POST",
        headers: { authorization: `bearer ${auth}`, "content-type": "application/json", "user-agent": "bb-initiatives" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(left),
      });
      text = await response.text();
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw timedOut();
      throw new Error(`couldn't reach GitHub: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.stats) {
      options.stats.requests++;
      options.stats.bytes += text.length;
    }
    return { response, text, used };
  };
  return async (query, variables, timeoutMs) => {
    // One deadline for both tries: a 401's retry gets what is left.
    const deadline = Date.now() + timeoutMs;
    let { response, text, used } = await post(query, variables, deadline, timeoutMs);
    if (response.status === 401) {
      // Read the token again, unless a request beside this one already has.
      if (cached === used) cached = null;
      ({ response, text } = await post(query, variables, deadline, timeoutMs));
      if (response.status === 401) throw new Error("GitHub refused the token (401): run `gh auth login` on the BB server");
    }
    return answer(response, text);
  };
}

/**
 * `promise`, unless `deadline` passes first: a token read shared by several requests keeps
 * running for the others, but each waits only as long as its own time allows.
 */
function beforeDeadline<T>(promise: Promise<T>, deadline: number, timedOut: () => Error): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(timedOut());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut()), left); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The `data` of one GraphQL answer, or an error that says what went wrong in GitHub's words. */
function answer(response: Response, text: string): unknown {
  let body: { data?: unknown; errors?: { message?: unknown }[]; message?: unknown } | null = null;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    // Reported below with the status and size.
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0" && reset > 0)
    throw new Error(`GitHub's API rate limit is used up until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC`);
  const graphqlError = Array.isArray(body?.errors) ? body.errors.map((e) => (typeof e?.message === "string" ? e.message : "")).find(Boolean) : undefined;
  if (!response.ok) {
    const message = graphqlError ?? (typeof body?.message === "string" ? body.message : "");
    throw new Error(`GitHub answered HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }
  if (!text.trim()) throw new Error("GitHub returned an empty answer");
  if (!body || typeof body !== "object") throw new Error(`GitHub returned malformed JSON (${text.length} bytes)`);
  if (Array.isArray(body.errors) && body.errors.length) throw new Error(graphqlError ? `GitHub: ${graphqlError}` : "GitHub returned an error without a message");
  if (body.data === null || typeof body.data !== "object") throw new Error("GitHub returned no data");
  return body.data;
}
