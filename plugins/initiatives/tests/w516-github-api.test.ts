// W516: GitHub's GraphQL API over HTTP, with the token `gh auth token` hands over once.
import { describe, expect, it, vi } from "vitest";
import { githubGraphQl, type GraphQlStats } from "../lib/github-api";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch answering each request in turn from `answers`, recording the token and body it was sent. */
const fake = (...answers: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) => {
  const sent: { token: string; body: unknown }[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ token: String((init!.headers as Record<string, string>).authorization), body: JSON.parse(String(init!.body)) });
    const next = answers.shift() ?? json({ data: {} });
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(init!) : next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, calls: fetch };
};

describe("githubGraphQl", () => {
  it("posts the query with the token, read once, and resolves the answer's data", async () => {
    const token = vi.fn(async () => "gho_one\n");
    const stats: GraphQlStats = { requests: 0, bytes: 0 };
    const f = fake(json({ data: { a: 1 } }), json({ data: { b: 2 } }));
    const github = githubGraphQl(token, { fetch: f.fetch, stats });
    expect(await github("query { a }", { x: 1 }, 1000)).toEqual({ a: 1 });
    expect(await github("query { b }", {}, 1000)).toEqual({ b: 2 });
    expect(token).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([
      { token: "bearer gho_one", body: { query: "query { a }", variables: { x: 1 } } },
      { token: "bearer gho_one", body: { query: "query { b }", variables: {} } },
    ]);
    expect(stats).toEqual({ requests: 2, bytes: '{"data":{"a":1}}'.length + '{"data":{"b":2}}'.length });
  });

  it("reads the token again after a 401 and retries once; a second 401 says to sign in", async () => {
    const tokens = ["gho_old", "gho_new", "gho_newer"];
    const token = vi.fn(async () => tokens.shift()!);
    const f = fake(json({ message: "Bad credentials" }, 401), json({ data: { ok: true } }), json({ message: "Bad credentials" }, 401), json({ message: "Bad credentials" }, 401));
    const github = githubGraphQl(token, { fetch: f.fetch });
    expect(await github("query { ok }", {}, 1000)).toEqual({ ok: true });
    expect(f.sent.map((s) => s.token)).toEqual(["bearer gho_old", "bearer gho_new"]);
    await expect(github("query { ok }", {}, 1000)).rejects.toThrow("GitHub refused the token (401): run `gh auth login` on the BB server");
    expect(f.sent.map((s) => s.token)).toEqual(["bearer gho_old", "bearer gho_new", "bearer gho_new", "bearer gho_newer"]);
    expect(token).toHaveBeenCalledTimes(3);
  });

  it("reads the token once for requests beside each other, and again after a failed read", async () => {
    let fail = true;
    const token = vi.fn(async () => {
      if (fail) throw new Error("To get started with GitHub CLI, please run: gh auth login");
      return "gho_one";
    });
    const f = fake();
    const github = githubGraphQl(token, { fetch: f.fetch });
    await expect(github("q", {}, 1000)).rejects.toThrow("gh auth login");
    fail = false;
    await Promise.all([github("q", {}, 1000), github("q", {}, 1000)]);
    expect(token).toHaveBeenCalledTimes(2);
    await expect(githubGraphQl(async () => " \n", { fetch: f.fetch })("q", {}, 1000)).rejects.toThrow("gh auth token printed no token");
  });

  it("says what went wrong in GitHub's words, never JSON.parse's", async () => {
    const reset = Date.parse("2026-10-19T13:45:00Z") / 1000;
    const cases: [Response | Error, string][] = [
      [json({ data: null, errors: [{ message: "Something went wrong while executing your query." }] }), "GitHub: Something went wrong while executing your query."],
      [json({ data: { search: null }, errors: [{ type: "NOT_FOUND" }] }), "GitHub returned an error without a message"],
      [json("<html>Bad Gateway</html>", 502), "GitHub answered HTTP 502"],
      [json({ message: "Server Error" }, 500), "GitHub answered HTTP 500: Server Error"],
      [json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }), "GitHub's API rate limit is used up until 13:45 UTC"],
      [json(""), "GitHub returned an empty answer"],
      [json('{"data":{"sea'), "GitHub returned malformed JSON (13 bytes)"],
      [json({ data: null }), "GitHub returned no data"],
      [new TypeError("fetch failed"), "couldn't reach GitHub: fetch failed"],
    ];
    for (const [answer, message] of cases)
      await expect(githubGraphQl(async () => "t", { fetch: fake(answer).fetch })("q", {}, 1000)).rejects.toThrow(message);
  });

  it("waits for a token read only as long as the request's own time allows, and shares the read (W516 r1)", async () => {
    let give!: (token: string) => void;
    const token = vi.fn(() => new Promise<string>((resolve) => { give = resolve; }));
    const f = fake(json({ data: { ok: 1 } }));
    const github = githubGraphQl(token, { fetch: f.fetch });
    const started = Date.now();
    await expect(github("q", {}, 30)).rejects.toThrow("GitHub didn't answer within 1 s");
    expect(Date.now() - started).toBeLessThan(1000);
    // The read kept running: the next request uses it, without reading again.
    const next = github("q", {}, 1000);
    give("gho_late");
    expect(await next).toEqual({ ok: 1 });
    expect(token).toHaveBeenCalledTimes(1);
    expect(f.sent.map((s) => s.token)).toEqual(["bearer gho_late"]);
  });

  it("gives up once its time is spent, aborting the request", async () => {
    let aborted = false;
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); });
    });
    const github = githubGraphQl(async () => "t", { fetch: fake(hang).fetch });
    await expect(github("q", {}, 30)).rejects.toThrow("GitHub didn't answer within 1 s");
    expect(aborted).toBe(true);
  });
});
