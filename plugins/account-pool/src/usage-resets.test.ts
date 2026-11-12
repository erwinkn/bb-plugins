// Usage resets end to end over the real hub, SQLite stores and claim store, with a fake Anthropic:
// the program read, a claim (manual and automatic at a wall) and the preferred Fable account. No
// request leaves the process; no real reset is ever claimed.
import Database from "better-sqlite3";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, AccountSecret } from "./contracts.js";
import { createHub } from "./hub.js";
import { PoolAffinityStore, QUOTA_MIGRATIONS, QuotaStore, type AccountStore, type HubTokenStore } from "./store.js";
import { quotaFromUsage } from "./usage.js";
import {
  CLAUDE_CLI_USER_AGENT,
  holdsGrant,
  pickGrant,
  ResetClaimStore,
  resetsFromUsage,
  type PendingClaim,
} from "./usage-resets.js";

const NOW = Date.parse("2026-11-12T13:30:00Z");
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const ORG = "0c0c0c0c-0000-4000-8000-000000000000";

// A grant as the usage read's cedar_ember block lists it (Claude Code 2.1.321, 2026-11-12).
function rawGrant(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label: "Full usage reset",
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-11-01T00:00:00Z",
    ends_at: "2026-12-10T00:00:00Z",
    clears: ["seven_day", "seven_day_overage_included"],
    paused: false,
    usable_now: true,
    use_requires_limit: true,
    percent_used: { seven_day: 100, seven_day_overage_included: 40 },
    blocking: [],
    type: "weekly",
    gives_back_weekly: false,
    unavailable_reason: null,
    ...extra,
  };
}

const fableGrant = (id: string, extra: Record<string, unknown> = {}) =>
  rawGrant(id, {
    label: "Fable reset",
    resets_total: 3,
    ends_at: "2027-03-09T00:00:00Z",
    clears: ["seven_day_overage_included"],
    type: undefined,
    gives_back_weekly: true,
    percent_used: { seven_day_overage_included: 53 },
    ...extra,
  });

interface Usage {
  weekly: number;
  // null: the reading names no weekly reset.
  weeklyResetAt?: number | null;
  fable?: number;
  grants?: unknown[];
  exhausted?: string[];
  cooldownUntil?: number | null;
  eligible?: boolean;
}

// The plain usage payload plus the program block, as ?cedar_ember=1&skip_spend=1 answers.
function usagePayload(usage: Usage) {
  const weeklyResetAt = usage.weeklyResetAt === undefined ? NOW + 3 * 24 * HOUR : usage.weeklyResetAt;
  const reset = weeklyResetAt === null ? null : iso(weeklyResetAt);
  return {
    five_hour: { utilization: 10, resets_at: iso(NOW + 2 * HOUR) },
    seven_day: { utilization: usage.weekly * 100, resets_at: reset },
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: (usage.fable ?? 0) * 100,
        resets_at: reset,
        scope: { model: { display_name: "Fable" } },
      },
    ],
    cedar_ember: {
      eligible: usage.eligible ?? true,
      ineligible_reason: usage.eligible === false ? "surface" : null,
      at_limit: usage.weekly >= 1,
      exhausted: usage.exhausted ?? (usage.weekly >= 1 ? ["seven_day"] : []),
      grants: usage.grants ?? [],
      next_grant_id: null,
      weekly_resets_at: reset,
      cooldown_until: usage.cooldownUntil == null ? null : iso(usage.cooldownUntil),
      event_props: { surface: "cli" },
    },
  };
}

function memoryKv(): PluginKvStorage {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key) => {
      values.delete(key);
    },
    list: async (prefix = "") => [...values.keys()].filter((key) => key.startsWith(prefix)),
  };
}

type Reply = { status: number; body?: unknown } | "fail";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function makePool(
  specs: Array<{ email: string; usage: Usage }>,
  options: {
    claim?: (index: number, body: Record<string, unknown>) => Reply | Promise<Reply>;
    // An upstream answer to a Messages request on an account; 200 when undefined.
    messages?: (index: number) => Response | undefined;
    // A KV shared with an earlier pool: the same plugin after a reload.
    kv?: PluginKvStorage;
    profileFails?: (index: number) => boolean;
    // The account's credential cannot be read (its OAuth refresh failed, say).
    secretFails?: (index: number) => boolean;
  } = {},
) {
  let clock = NOW;
  const db = new Database(":memory:");
  for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
  const quotas = new QuotaStore(db);
  const kv = options.kv ?? memoryKv();
  const resetClaims = new ResetClaimStore(kv);
  const accounts: Account[] = specs.map((spec, index) => ({
    id: `aaaaaaaa-0000-4000-8000-00000000000${index + 1}`,
    provider: "claude",
    kind: "oauth",
    label: "Erwin",
    email: spec.email,
    accountUuid: `bbbbbbbb-0000-4000-8000-00000000000${index + 1}`,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    enabled: true,
    priority: index + 1,
    createdAt: 0,
    lastUsedAt: null,
    lastUsedHostId: null,
  }));
  // A number answers with that status; "malformed" answers 200 with a payload the usage parse rejects.
  // A function answers each read afresh (and may act, as a concurrent change would).
  type Answer = Usage | number | "malformed";
  const usage = new Map(specs.map((spec, index) => [index, spec.usage] as [number, Answer | (() => Answer | Promise<Answer>)]));
  const tokenIndex = (headers: Headers) => Number(headers.get("authorization")?.replace("Bearer tok-", ""));
  const served: string[] = [];
  const attempts: string[] = [];
  const claims: Array<{ email: string; body: Record<string, unknown>; headers: Headers }> = [];
  const usageReads: Array<{ url: string; headers: Headers }> = [];
  const logs: Array<[string, string]> = [];
  const affinity = new PoolAffinityStore(db);
  const hub = createHub({
    accounts: {
      list: async () => accounts.map((account) => ({ ...account })),
      recordUsed: async () => false,
      readSecret: async (id: string): Promise<AccountSecret> => {
        const index = accounts.findIndex((account) => account.id === id);
        if (options.secretFails?.(index) === true) throw new Error("the secret file is unreadable");
        return {
        kind: "oauth",
        accessToken: `tok-${index}`,
        refreshToken: "rt",
        expiresAt: NOW + 30 * 24 * HOUR,
        };
      },
      writeSecret: async () => {},
      setAccountUuid: async () => {},
    } as unknown as AccountStore,
    quotas,
    affinity,
    hubTokens: {
      authenticate: async (token: string | null) => (token === "hub" ? "host-one" : null),
      list: async () => [],
    } as unknown as HubTokenStore,
    getSettings: () => ({
      anthropicUpstreamBaseUrl: "https://upstream.test",
      codexUpstreamBaseUrl: "https://upstream.test/codex",
      switchThreshold: 0.98,
      claudeMainCacheTtl: "1h",
      sessionAffinityIdleMinutes: 60,
    }),
    now: () => clock,
    usageUrl: "https://api.test/usage?cedar_ember=1&skip_spend=1",
    profileUrl: "https://api.test/profile",
    resetUrl: (organization) => `https://api.test/organizations/${organization}/reset_rate_limits`,
    resetClaims,
    logReset: (message, level) => logs.push([level, message]),
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const index = tokenIndex(headers);
      if (url.startsWith("https://api.test/usage")) {
        usageReads.push({ url, headers });
        const entry = usage.get(index)!;
        const current = typeof entry === "function" ? await entry() : entry;
        if (current === "malformed") return Response.json({ unexpected: true });
        return typeof current === "number"
          ? new Response("{}", { status: current })
          : Response.json(usagePayload(current));
      }
      if (url === "https://api.test/profile")
        return options.profileFails?.(index) === true
          ? new Response("{}", { status: 500 })
          : Response.json({ account: { uuid: accounts[index]!.accountUuid }, organization: { uuid: ORG } });
      if (url === `https://api.test/organizations/${ORG}/reset_rate_limits`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        claims.push({ email: specs[index]!.email, body, headers });
        const reply = (await options.claim?.(index, body)) ?? { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } };
        if (reply === "fail") throw new TypeError("fetch failed");
        return Response.json(reply.body ?? {}, { status: reply.status });
      }
      if (url === "https://upstream.test/v1/messages") {
        attempts.push(specs[index]!.email);
        const answer = options.messages?.(index);
        if (answer !== undefined) return answer;
        served.push(specs[index]!.email);
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const controller = new AbortController();
  const started = hub.start(controller.signal);
  await hub.refreshUsage(undefined, true);
  closers.push(async () => {
    controller.abort();
    await started;
    db.close();
  });
  const send = async (model: string, session?: string, signal?: AbortSignal) => {
    const response = await hub.handle(
      new Request("https://hub.test/api/v1/plugins/account-pool-local/http/v1/messages", {
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
        headers: { authorization: "Bearer hub", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          ...(session === undefined ? {} : { metadata: { user_id: JSON.stringify({ session_id: session }) } }),
        }),
      }),
      "claude",
    );
    await response.text();
    return { status: response.status, servedBy: response.ok ? served.at(-1) : null };
  };
  const setUsage = (index: number, next: Answer | (() => Answer | Promise<Answer>)) => usage.set(index, next);
  return {
    hub,
    accounts,
    quotas,
    resetClaims,
    served,
    attempts,
    kv,
    claims,
    usageReads,
    logs,
    send,
    setUsage,
    advance: (ms: number) => {
      clock += ms;
    },
    refresh: () => hub.refreshUsage(undefined, true),
  };
}

describe("the program read", () => {
  it("parses the live block, deriving each grant's kind as Claude Code does", () => {
    const payload = usagePayload({
      weekly: 1,
      grants: [
        rawGrant("full-reset-2611"),
        fableGrant("launch-2610-fable", { resets_left: 0, usable_now: false }),
        rawGrant("five-only", { type: undefined, clears: ["five_hour"] }),
        rawGrant("both", { type: undefined, clears: ["five_hour", "seven_day"] }),
        rawGrant("weekly-derived", { type: undefined }),
      ],
      cooldownUntil: NOW + 60_000,
    });
    const resets = resetsFromUsage(payload, NOW)!;
    expect(resets).toMatchObject({ eligible: true, cooldownUntil: NOW + 60_000, observedAt: NOW });
    expect(resets.grants.map((grant) => [grant.id, grant.kind])).toEqual([
      ["full-reset-2611", "weekly"],
      ["launch-2610-fable", "fable"],
      ["five-only", "session"],
      ["both", "full"],
      ["weekly-derived", "weekly"],
    ]);
    expect(resets.grants[0]).toEqual({
      id: "full-reset-2611",
      kind: "weekly",
      resetsTotal: 1,
      resetsLeft: 1,
      startsAt: Date.parse("2026-11-01T00:00:00Z"),
      endsAt: Date.parse("2026-12-10T00:00:00Z"),
      clears: ["seven_day", "seven_day_overage_included"],
      paused: false,
      usableNow: true,
      useRequiresLimit: true,
      percentUsed: { seven_day: 1, seven_day_overage_included: 0.4 },
      blocking: [],
      unavailableReason: null,
    });
  });

  it("drops a malformed grant on its own, and reads a malformed block as none, leaving the usage reading", () => {
    const payload = usagePayload({ weekly: 0.5, grants: [rawGrant("ok"), { id: "Bad Id!", resets_left: 1 }, { id: "no-count" }] });
    expect(resetsFromUsage(payload, NOW)?.grants.map((grant) => grant.id)).toEqual(["ok"]);
    const broken = { ...payload, cedar_ember: { grants: "nope" } };
    expect(resetsFromUsage(broken, NOW)).toBeNull();
    expect(resetsFromUsage({ seven_day: payload.seven_day }, NOW)).toBeNull();
    // The plain usage fields still read from the program payload.
    const empty = { accountId: "aaaaaaaa-0000-4000-8000-000000000001", sevenDayUtilization: null, sevenDayResetAt: null, sevenDayStatus: null, representativeClaim: null, familyWeekly: { fable: null, sonnet: null, opus: null, haiku: null, other: null }, limitWindows: [], observedAt: null, heldUntil: null, rejectedUntil: null, rejectedAt: null, rejectedLimit: null, error: null };
    expect(quotaFromUsage(empty.accountId, broken, empty, NOW, NOW)).toMatchObject({ sevenDayUtilization: 0.5 });
  });

  it("refuses a kind with the reason the grants give", () => {
    const resets = (grants: unknown[], extra: Partial<Usage> = {}) => resetsFromUsage(usagePayload({ weekly: 1, grants, ...extra }), NOW)!;
    const refused = (value: ReturnType<typeof pickGrant>) => ("refused" in value ? value.refused : value.grant.id);
    expect(refused(pickGrant(resets([rawGrant("w")]), "session", NOW))).toBe("it holds no session reset; it holds weekly (w)");
    expect(refused(pickGrant(resets([fableGrant("f", { resets_left: 0, usable_now: false })]), "fable", NOW))).toBe("no fable reset is usable: f none left");
    expect(refused(pickGrant(resets([fableGrant("f", { usable_now: false, blocking: ["five_hour"] })]), "fable", NOW))).toBe(
      "no fable reset is usable: f blocked by five_hour",
    );
    expect(refused(pickGrant(resets([fableGrant("f", { usable_now: false, unavailable_reason: "at_five_hour" })]), "fable", NOW))).toBe(
      "no fable reset is usable: f at_five_hour",
    );
    expect(refused(pickGrant(resets([fableGrant("f", { paused: true })]), "fable", NOW))).toBe("no fable reset is usable: f paused");
    expect(refused(pickGrant(resets([rawGrant("w")], { cooldownUntil: NOW + 30_000 }), "weekly", NOW))).toBe(
      `a claim cooldown runs until ${iso(NOW + 30_000)}`,
    );
    expect(refused(pickGrant(resets([rawGrant("w")], { eligible: false }), "weekly", NOW))).toBe(
      "the account is not eligible for usage resets (surface)",
    );
    // The CLI's target: the first usable grant of the kind, in the server's order.
    expect(refused(pickGrant(resets([fableGrant("a", { resets_left: 0, usable_now: false }), fableGrant("b"), fableGrant("c")]), "fable", NOW))).toBe("b");
  });

  it("reads usage with the CLI's identity and keeps the grants with the reading", async () => {
    const pool = await makePool([{ email: "tech@equisafe.io", usage: { weekly: 0.4, grants: [rawGrant("full-reset-2611")] } }]);
    const read = pool.usageReads[0]!;
    expect(read.url).toBe("https://api.test/usage?cedar_ember=1&skip_spend=1");
    expect(read.headers.get("user-agent")).toBe(CLAUDE_CLI_USER_AGENT);
    expect(read.headers.get("x-app")).toBe("cli");
    expect(read.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    const [account] = (await pool.hub.status()).accounts;
    expect(account?.sevenDayUtilization).toBe(0.4);
    expect(account?.resets?.grants.map((grant) => [grant.id, grant.kind, grant.resetsLeft])).toEqual([["full-reset-2611", "weekly", 1]]);
  });
});

describe("claiming a reset", () => {
  it("claims the first usable grant of the kind from a fresh read, then releases the hold it lifted", async () => {
    // A wall of half an hour: too short for an automatic claim.
    const freeAt = NOW + 30 * 60_000;
    const pool = await makePool([{ email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: freeAt, grants: [rawGrant("full-reset-2611")] } }], {
      claim: () => {
        pool.setUsage(0, { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
        return { status: 200, body: { result: "reset", reason: null, resets_left: 0, cleared: ["seven_day", "seven_day_overage_included"], cooldown_until: iso(NOW + 60_000) } };
      },
    });
    const id = pool.accounts[0]!.id;
    // A weekly-limit 429 the Pooler recorded before the claim.
    pool.quotas.put({ ...pool.quotas.get(id), rejectedUntil: freeAt, rejectedAt: NOW - 1, rejectedLimit: "seven_day" });
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    const reads = pool.usageReads.length;
    const outcome = await pool.hub.claimReset(id, "weekly");
    expect(outcome).toEqual({
      status: "answered",
      grantId: "full-reset-2611",
      kind: "weekly",
      result: "reset",
      reason: null,
      resetsLeft: 0,
      cleared: ["seven_day", "seven_day_overage_included"],
    });
    // One read before the claim, one after.
    expect(pool.usageReads.length).toBe(reads + 2);
    expect(pool.claims).toHaveLength(1);
    expect(pool.claims[0]!.body).toEqual({ program: "cedar_ember", grant_id: "full-reset-2611", request_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
    expect(pool.claims[0]!.headers.get("user-agent")).toBe(CLAUDE_CLI_USER_AGENT);
    expect(pool.quotas.get(id).rejectedUntil).toBeNull();
    expect(await pool.resetClaims.pending(id)).toBeNull();
    expect((await pool.send("claude-opus-5")).servedBy).toBe("tech@equisafe.io");
    expect(pool.logs).toEqual([
      ["debug", `Account Pooler does not auto-claim a usage reset: an account frees up on its own at ${iso(freeAt)}, within an hour.`],
      ["info", "Account Pooler manual claim of weekly reset full-reset-2611 on tech@equisafe.io: reset, 0 left, cleared seven_day, seven_day_overage_included."],
    ]);
  });

  it("refuses without sending anything when no grant of the kind is usable, or the read fails", async () => {
    const pool = await makePool([
      { email: "hi@erwinkn.com", usage: { weekly: 0.2, exhausted: ["five_hour"], grants: [rawGrant("full-reset-2611", { usable_now: false, blocking: ["five_hour"] })] } },
    ]);
    const id = pool.accounts[0]!.id;
    expect(await pool.hub.claimReset(id, "weekly")).toEqual({ status: "refused", reason: "no weekly reset is usable: full-reset-2611 blocked by five_hour" });
    expect(await pool.hub.claimReset(id, "fable")).toEqual({ status: "refused", reason: "it holds no fable reset; it holds weekly (full-reset-2611)" });
    pool.setUsage(0, 503);
    expect(await pool.hub.claimReset(id, "weekly")).toEqual({ status: "refused", reason: "the usage read of hi@erwinkn.com failed; nothing was sent" });
    expect(pool.claims).toEqual([]);
    expect(await pool.hub.claimReset("aaaaaaaa-0000-4000-8000-00000000000f", "weekly")).toBeNull();
  });

  it("resends an ambiguous claim with the same request id, so the reset is spent once", async () => {
    const replies: Reply[] = [{ status: 503 }, "fail", { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } }];
    const pool = await makePool([{ email: "tech@equisafe.io", usage: { weekly: 1, grants: [rawGrant("full-reset-2611")] } }], {
      claim: () => replies.shift()!,
    });
    const id = pool.accounts[0]!.id;
    expect(await pool.hub.claimReset(id, "weekly")).toEqual({
      status: "unsettled",
      grantId: "full-reset-2611",
      kind: "weekly",
      reason: "the claim got HTTP 503; claim again to resend it with the same request id",
    });
    const pending = (await pool.resetClaims.pending(id)) as PendingClaim;
    expect(pending).toMatchObject({ grantId: "full-reset-2611", resetsLeftBefore: 1 });
    expect((await pool.hub.claimReset(id, "weekly"))?.status).toBe("unsettled");
    expect(await pool.hub.claimReset(id, "weekly")).toMatchObject({ status: "answered", result: "reset" });
    expect(pool.claims.map((claim) => claim.body.request_id)).toEqual([pending!.requestId, pending!.requestId, pending!.requestId]);
    expect(await pool.resetClaims.pending(id)).toBeNull();
  });

  it("settles an ambiguous claim by re-reading: a grant with fewer resets left was used", async () => {
    const pool = await makePool([{ email: "tech@equisafe.io", usage: { weekly: 1, grants: [rawGrant("full-reset-2611")] } }], {
      claim: () => {
        pool.setUsage(0, { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
        return { status: 502 };
      },
    });
    const id = pool.accounts[0]!.id;
    expect(await pool.hub.claimReset(id, "weekly")).toMatchObject({ status: "answered", result: "reset", resetsLeft: 0 });
    expect(await pool.resetClaims.pending(id)).toBeNull();
  });

  it("finds an earlier unsettled claim used at the next claim, and sends nothing new", async () => {
    const pool = await makePool([{ email: "tech@equisafe.io", usage: { weekly: 1, grants: [rawGrant("full-reset-2611")] } }], {
      claim: () => {
        // The answer is lost and so is the read after it.
        pool.setUsage(0, 500);
        return "fail";
      },
    });
    const id = pool.accounts[0]!.id;
    expect((await pool.hub.claimReset(id, "weekly"))?.status).toBe("unsettled");
    pool.setUsage(0, { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
    expect(await pool.hub.claimReset(id, "weekly")).toMatchObject({ status: "answered", result: "reset" });
    expect(pool.claims).toHaveLength(1);
  });

  it("reports a definite non-reset answer and forgets the claim", async () => {
    const pool = await makePool([{ email: "tech@equisafe.io", usage: { weekly: 0.3, grants: [rawGrant("full-reset-2611")] } }], {
      claim: () => ({ status: 200, body: { result: "not_limited", reason: "below_limit", resets_left: 1, cleared: [] } }),
    });
    const id = pool.accounts[0]!.id;
    expect(await pool.hub.claimReset(id, "weekly")).toMatchObject({ status: "answered", result: "not_limited", reason: "below_limit", resetsLeft: 1 });
    expect(await pool.resetClaims.pending(id)).toBeNull();
  });
});

describe("the preferred Fable account", () => {
  // Fable use smeared as on 2026-11-12; only b and c hold a Fable reset.
  const smeared = () => [
    { email: "a", usage: { weekly: 0.3, fable: 0.1, grants: [rawGrant("full-reset-2611")] } },
    { email: "b", usage: { weekly: 0.3, fable: 0.41, grants: [fableGrant("launch-2610-fable")] } },
    { email: "c", usage: { weekly: 0.3, fable: 0.53, grants: [fableGrant("launch-2610-fable")] } },
  ];

  it("sends Fable to the grant holder with the fullest Fable limit, and other models as before", async () => {
    const pool = await makePool(smeared());
    expect((await pool.send("claude-opus-5")).servedBy).toBe("a");
    expect((await pool.send("claude-fable-5")).servedBy).toBe("c");
    expect((await pool.send("claude-fable-5", "s-new")).servedBy).toBe("c");
    expect((await pool.send("claude-sonnet-5")).servedBy).toBe("a");
  });

  it("never moves a session's pin or the provider's cursor for the detour", async () => {
    const pool = await makePool(smeared());
    expect((await pool.send("claude-opus-5", "s1")).servedBy).toBe("a");
    expect((await pool.send("claude-fable-5", "s1")).servedBy).toBe("c");
    expect((await pool.send("claude-opus-5", "s1")).servedBy).toBe("a");
    // A session whose first request is Fable is not bound to c: its Opus goes to the active account.
    expect((await pool.send("claude-fable-5", "s2")).servedBy).toBe("c");
    expect((await pool.send("claude-opus-5", "s2")).servedBy).toBe("a");
    expect((await pool.send("claude-opus-5", "s3")).servedBy).toBe("a");
  });

  it("falls back to the next holder, then to today's selection, as their Fable limits fill", async () => {
    const pool = await makePool(smeared());
    pool.setUsage(2, { weekly: 0.3, fable: 1, grants: [fableGrant("launch-2610-fable")] });
    await pool.refresh();
    expect((await pool.send("claude-fable-5")).servedBy).toBe("b");
    pool.setUsage(1, { weekly: 0.3, fable: 1, grants: [fableGrant("launch-2610-fable")] });
    await pool.refresh();
    expect((await pool.send("claude-fable-5")).servedBy).toBe("a");
  });

  it("leaves selection as it is when no account holds a Fable reset it can spend", async () => {
    const pool = await makePool([
      { email: "a", usage: { weekly: 0.3, fable: 0.1 } },
      { email: "b", usage: { weekly: 0.3, fable: 0.6, grants: [fableGrant("used", { resets_left: 0, usable_now: false })] } },
      { email: "c", usage: { weekly: 0.3, fable: 0.7, grants: [fableGrant("paused", { paused: true })] } },
    ]);
    expect((await pool.send("claude-fable-5")).servedBy).toBe("a");
    expect((await pool.send("claude-fable-5", "s1")).servedBy).toBe("a");
  });
});

describe("automatic use of a reset at a wall", () => {
  // Both accounts at their weekly limit; tech@ waits longest, so its weekly reset ranks first.
  const wall = (otherFreeAt = NOW + 2 * 24 * HOUR) => [
    { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611")] } },
    { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: otherFreeAt, grants: [fableGrant("launch-2610-fable")] } },
  ];
  const landing = (pool: () => Awaited<ReturnType<typeof makePool>>) => () => {
    pool().setUsage(0, { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
    return { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day", "seven_day_overage_included"] } } as Reply;
  };

  it("claims the top advised grant with no flag set when no account frees up within an hour, and serves the request", async () => {
    let ref: Awaited<ReturnType<typeof makePool>>;
    const pool = (ref = await makePool(wall(), { claim: landing(() => ref) }));
    expect(await pool.send("claude-opus-5", "s1")).toEqual({ status: 200, servedBy: "tech@equisafe.io" });
    expect(pool.claims.map((claim) => [claim.email, claim.body.grant_id])).toEqual([["tech@equisafe.io", "full-reset-2611"]]);
    expect(pool.logs).toEqual([
      ["info", "Account Pooler auto claim of weekly reset full-reset-2611 on tech@equisafe.io: reset, 0 left, cleared seven_day, seven_day_overage_included."],
    ]);
  });

  it("spends a Fable reset only once the Fable weekly limit is at least 40% used", async () => {
    const fableWall = (fable: number) => [
      { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR } },
      { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable", { percent_used: { seven_day_overage_included: fable } })] } },
    ];
    // Under 40% in a reading newer than any response, the wall costs no usage read at all.
    const low = await makePool(fableWall(39));
    const reads = low.usageReads.length;
    for (let index = 0; index < 3; index += 1) {
      expect((await low.send("claude-opus-5")).status).toBe(429);
      low.advance(61_000);
    }
    expect(low.usageReads.length).toBe(reads);
    expect(low.claims).toEqual([]);
    expect(low.logs).toEqual([]);
    const high = await makePool(fableWall(40));
    await high.send("claude-opus-5");
    expect(high.claims.map((claim) => claim.body.grant_id)).toEqual(["launch-2610-fable"]);
  });

  it("probes a wall when a response came after the reading: the Fable use may have risen since", async () => {
    const fableAt = (fable: number) => ({
      weekly: 1,
      weeklyResetAt: NOW + 2 * 24 * HOUR,
      grants: [fableGrant("launch-2610-fable", { percent_used: { seven_day_overage_included: fable } })],
    });
    const pool = await makePool([
      { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR } },
      { email: "erwin@gmail.com", usage: fableAt(30) },
    ]);
    // erwin@ serves after its last reading (busy, the usage loop skips it): only its quota moves.
    pool.advance(1_000);
    const erwin = pool.accounts[1]!.id;
    pool.quotas.put({ ...pool.quotas.get(erwin), observedAt: NOW + 1_000 });
    pool.setUsage(1, fableAt(45));
    await pool.send("claude-opus-5");
    expect(pool.claims.map((claim) => [claim.email, claim.body.grant_id])).toEqual([["erwin@gmail.com", "launch-2610-fable"]]);
  });

  it("walks past a refused pick: to another account's grant, and to the same account's next one", async () => {
    // Both Fable resets give back little, so the longest wait ranks first: tech@'s, under 40%.
    const fables = await makePool([
      { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [fableGrant("tech-fable", { percent_used: { seven_day_overage_included: 30 } })] } },
      { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable", { percent_used: { seven_day_overage_included: 45 } })] } },
    ]);
    await fables.send("claude-opus-5");
    expect(fables.claims.map((claim) => [claim.email, claim.body.grant_id])).toEqual([["erwin@gmail.com", "launch-2610-fable"]]);
    // tech@'s Fable reset ranks before its weekly one, but a limit blocks it.
    const blocked = await makePool([
      { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [fableGrant("launch-2610-fable", { blocking: ["seven_day"] }), rawGrant("full-reset-2611")] } },
      { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR } },
    ]);
    await blocked.send("claude-opus-5");
    expect(blocked.claims.map((claim) => [claim.email, claim.body.grant_id])).toEqual([["tech@equisafe.io", "full-reset-2611"]]);
  });

  it("declines when an account frees up on its own within the hour", async () => {
    const pool = await makePool(wall(NOW + 40 * 60_000));
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(pool.logs).toEqual([
      ["debug", `Account Pooler does not auto-claim a usage reset: an account frees up on its own at ${iso(NOW + 40 * 60_000)}, within an hour.`],
    ]);
  });

  it("declines a grant that is blocked, unusable or paused, and stops probing once a reading shows it", async () => {
    const pool = await makePool([wall()[0]!, { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR } }]);
    const walledWith = (extra: Record<string, unknown>) =>
      pool.setUsage(0, { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611", extra)] });
    // The cached reading still shows the grant usable, so the wall is probed; the fresh read rules
    // it out before any claim read.
    walledWith({ blocking: ["five_hour"] });
    let reads = pool.usageReads.length;
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.usageReads.length).toBe(reads + 2);
    // Once the cached reading shows a grant no automatic claim could spend, a wall reads nothing.
    for (const extra of [{ blocking: ["five_hour"] }, { usable_now: false, blocking: ["five_hour"] }, { paused: true }]) {
      walledWith(extra);
      await pool.refresh();
      pool.advance(61_000);
      reads = pool.usageReads.length;
      expect((await pool.send("claude-opus-5")).status).toBe(429);
      expect(pool.usageReads.length).toBe(reads);
    }
    expect(pool.claims).toEqual([]);
    expect(pool.logs.map(([, message]) => message)).toEqual([
      "Account Pooler does not auto-claim a usage reset: no usable reset could be claimed (tech@equisafe.io full-reset-2611: blocked by five_hour).",
    ]);
  });

  it("claims once per wall: no second grant until an account has served again", async () => {
    // The claim answers reset, but the pool still cannot serve (the read after it shows tech@ at its
    // limit), so gmail's reset waits.
    let ref: Awaited<ReturnType<typeof makePool>>;
    const pool = (ref = await makePool(wall(), {
      claim: () => {
        ref.setUsage(0, { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
        return { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } };
      },
    }));
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims.map((claim) => claim.body.grant_id)).toEqual(["full-reset-2611"]);
    expect(pool.logs.at(-1)).toEqual([
      "debug",
      "Account Pooler does not auto-claim a usage reset: one was claimed at this wall and no account has served since.",
    ]);
    // gmail frees up and serves; at the next wall its reset may be spent.
    pool.setUsage(1, { weekly: 0.2, grants: [fableGrant("launch-2610-fable")] });
    await pool.refresh();
    expect((await pool.send("claude-opus-5")).servedBy).toBe("erwin@gmail.com");
    pool.setUsage(1, { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable")] });
    await pool.refresh();
    pool.advance(2 * 60_000);
    await pool.send("claude-opus-5");
    expect(pool.claims.map((claim) => claim.body.grant_id)).toEqual(["full-reset-2611", "launch-2610-fable"]);
  });

  it("does nothing, and logs nothing, in a pool holding no reset", async () => {
    const pool = await makePool(wall().map((spec) => ({ ...spec, usage: { ...spec.usage, grants: [] } })));
    const reads = pool.usageReads.length;
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(pool.logs).toEqual([]);
    expect(pool.usageReads.length).toBe(reads);
  });

  it("declines while an earlier claim is unsettled", async () => {
    const pool = await makePool(wall());
    await pool.resetClaims.setPending(pool.accounts[1]!.id, { grantId: "launch-2610-fable", requestId: "abc", resetsLeftBefore: 1, at: NOW });
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(pool.logs.map(([, message]) => message)).toEqual([
      `Account Pooler does not auto-claim a usage reset: an earlier claim of launch-2610-fable on erwin@gmail.com is unsettled until ${iso(NOW + 10 * 60_000)}.`,
    ]);
  });
});

describe("review round 1 regressions", () => {
  const both = () => [
    {
      email: "tech@equisafe.io",
      usage: { weekly: 1, grants: [rawGrant("full-reset-2611"), fableGrant("launch-2610-fable-6mo")] },
    },
  ];
  type Pool = Awaited<ReturnType<typeof makePool>>;

  it("refuses a claim of another grant while one is unsettled, and resends the unsettled one", async () => {
    const replies: Reply[] = [{ status: 503 }, { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } }];
    const pool = await makePool(both(), { claim: () => replies.shift()! });
    const id = pool.accounts[0]!.id;
    expect((await pool.hub.claimReset(id, "weekly"))?.status).toBe("unsettled");
    const refused = await pool.hub.claimReset(id, "fable");
    expect(refused).toEqual({
      status: "refused",
      reason: `an earlier claim of full-reset-2611 on tech@equisafe.io is unsettled; claim it again to resend it, or wait until ${iso(NOW + 10 * 60_000)}`,
    });
    expect(await pool.hub.claimReset(id, "weekly")).toMatchObject({ status: "answered", result: "reset" });
    expect(pool.claims.map((claim) => claim.body.grant_id)).toEqual(["full-reset-2611", "full-reset-2611"]);
    expect(pool.claims[0]!.body.request_id).toBe(pool.claims[1]!.body.request_id);
  });

  it("clears an unsettled claim a read shows used, and proceeds with a claim of another kind", async () => {
    let ref: Pool;
    const replies: Reply[] = [{ status: 503 }, { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day_overage_included"] } }];
    const pool = (ref = await makePool(both(), { claim: () => replies.shift()! }));
    const id = pool.accounts[0]!.id;
    expect((await pool.hub.claimReset(id, "weekly"))?.status).toBe("unsettled");
    // The weekly claim landed after all.
    ref.setUsage(0, { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false }), fableGrant("launch-2610-fable-6mo")] });
    expect(await pool.hub.claimReset(id, "fable")).toMatchObject({
      status: "answered",
      grantId: "launch-2610-fable-6mo",
      kind: "fable",
      result: "reset",
    });
    expect(pool.claims.map((claim) => claim.body.grant_id)).toEqual(["full-reset-2611", "launch-2610-fable-6mo"]);
    expect(pool.logs.map(([, message]) => message)).toContain("Account Pooler found its earlier claim of full-reset-2611 on tech@equisafe.io used.");
  });

  it("does not settle a claim whose grant the read no longer lists, until the 10-minute horizon", async () => {
    const replies: Reply[] = [{ status: 503 }, { status: 200, body: { result: "reset", resets_left: 0, cleared: [] } }];
    const pool = await makePool(both(), { claim: () => replies.shift()! });
    const id = pool.accounts[0]!.id;
    expect((await pool.hub.claimReset(id, "weekly"))?.status).toBe("unsettled");
    pool.setUsage(0, { weekly: 1, grants: [fableGrant("launch-2610-fable-6mo")] });
    expect(await pool.hub.claimReset(id, "fable")).toEqual({
      status: "refused",
      reason: `grant full-reset-2611 of an earlier unsettled claim is no longer listed; that claim's state is unknown until ${iso(NOW + 10 * 60_000)}`,
    });
    expect(await pool.resetClaims.pending(id)).toMatchObject({ grantId: "full-reset-2611" });
    pool.advance(10 * 60_000);
    expect(await pool.hub.claimReset(id, "fable")).toMatchObject({ status: "answered", grantId: "launch-2610-fable-6mo" });
    expect(pool.logs.map(([, message]) => message)).toContain(
      "Account Pooler dropped its unsettled claim of full-reset-2611 on tech@equisafe.io: the grant is no longer listed within 10 minutes.",
    );
    expect(pool.claims).toHaveLength(2);
  });

  it("settles a rejected claim as used when the read shows it, and forgets one that was not", async () => {
    let ref: Pool;
    const replies: Array<() => Reply> = [
      () => ({ status: 400 }),
      () => {
        ref.setUsage(0, { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
        return { status: 409 };
      },
    ];
    const pool = (ref = await makePool(both(), { claim: () => replies.shift()!() }));
    const id = pool.accounts[0]!.id;
    expect(await pool.hub.claimReset(id, "weekly")).toEqual({
      status: "refused",
      reason: "the server refused the claim of full-reset-2611 (HTTP 400)",
    });
    expect(await pool.resetClaims.pending(id)).toBeNull();
    expect(await pool.hub.claimReset(id, "weekly")).toMatchObject({ status: "answered", result: "reset" });
    expect(await pool.resetClaims.pending(id)).toBeNull();
  });

  it("sends one claim when a manual claim races an automatic one on the same account", async () => {
    let ref: Pool;
    const pool = (ref = await makePool(
      [
        { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611")] } },
        { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR } },
      ],
      {
        claim: () => {
          ref.setUsage(0, { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
          return { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } };
        },
      },
    ));
    const id = pool.accounts[0]!.id;
    const [manual] = await Promise.all([pool.hub.claimReset(id, "weekly"), pool.send("claude-opus-5")]);
    expect(pool.claims).toHaveLength(1);
    expect(manual?.status === "answered" || manual?.status === "refused").toBe(true);
    expect((await pool.send("claude-opus-5")).servedBy).toBe("tech@equisafe.io");
  });

  // tech@ holds a weekly reset; gmail, none, walled for two days unless a test changes it.
  const wall = () => [
    { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611")] } as Usage },
    { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR } as Usage },
  ];
  const declines = (pool: Pool) => pool.logs.map(([, message]) => message);

  it("declines the wall spend when an account's free-up time is unknown", async () => {
    const specs = wall();
    specs[1]!.usage = { weekly: 1, weeklyResetAt: null };
    const pool = await makePool(specs);
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(declines(pool)).toEqual([
      "Account Pooler does not auto-claim a usage reset: erwin@gmail.com is at a limit with no known free-up time.",
    ]);
  });

  it("declines the wall spend when an account is in error or its fresh read fails", async () => {
    const pool = await makePool(wall());
    const gmail = pool.accounts[1]!.id;
    pool.quotas.put({ ...pool.quotas.get(gmail), error: "OAuth refresh failed with HTTP 400." });
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    pool.quotas.put({ ...pool.quotas.get(gmail), error: null });
    pool.setUsage(1, 500);
    pool.advance(61_000);
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(declines(pool)).toEqual([
      "Account Pooler does not auto-claim a usage reset: erwin@gmail.com is in error.",
      "Account Pooler does not auto-claim a usage reset: the usage read of erwin@gmail.com failed.",
    ]);
  });

  it("judges the wall from fresh reads: a reset claimed by hand elsewhere serves the request", async () => {
    const pool = await makePool(wall());
    // Inside the 5-minute refresh window: the cached reading still shows gmail walled.
    pool.setUsage(1, { weekly: 0 });
    expect(await pool.send("claude-opus-5")).toEqual({ status: 200, servedBy: "erwin@gmail.com" });
    expect(pool.claims).toEqual([]);
  });

  it("keeps the once-per-wall state across a hub restart", async () => {
    let ref: Pool;
    const first = (ref = await makePool(wall(), {
      claim: () => {
        ref.setUsage(0, { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });
        return { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } };
      },
    }));
    expect((await first.send("claude-opus-5")).status).toBe(429);
    expect(first.claims).toHaveLength(1);
    const specs = wall();
    specs[1]!.usage = { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable")] };
    const second = await makePool(specs, { kv: first.kv });
    second.advance(2 * 60_000);
    expect((await second.send("claude-opus-5")).status).toBe(429);
    expect(second.claims).toEqual([]);
    expect(declines(second)).toEqual([
      "Account Pooler does not auto-claim a usage reset: one was claimed at this wall and no account has served since.",
    ]);
  });

  it("skips probing for a minute after a decline, bounding reads across walled requests", async () => {
    // The profile read fails, so each probe ends unsent and the grant still reads usable.
    const pool = await makePool(wall(), { profileFails: () => true });
    const before = pool.usageReads.length;
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    const probed = pool.usageReads.length;
    expect(probed).toBeGreaterThan(before);
    for (let index = 0; index < 5; index += 1) expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.usageReads.length).toBe(probed);
    expect(declines(pool).at(-1)).toBe("Account Pooler does not auto-claim a usage reset: the last decision was less than 60 s ago.");
    pool.advance(61_000);
    await pool.send("claude-opus-5");
    expect(pool.usageReads.length).toBeGreaterThan(probed);
  });

  it("ends a client's wait when it aborts, but not the claim already sent", async () => {
    let release = () => {};
    let sent = () => {};
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const pool = await makePool(wall(), {
      claim: async () => {
        sent();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } };
      },
    });
    const controller = new AbortController();
    const answer = pool.send("claude-opus-5", undefined, controller.signal);
    await started;
    controller.abort();
    expect((await answer).status).toBe(499);
    release();
    await expect.poll(() => pool.logs.some(([level]) => level === "info")).toBe(true);
    expect(pool.logs.find(([level]) => level === "info")?.[1]).toBe(
      "Account Pooler auto claim of weekly reset full-reset-2611 on tech@equisafe.io: reset, 0 left, cleared seven_day.",
    );
  });

  it("does not re-pick the preferred Fable account after it fails upstream", async () => {
    const pool = await makePool(
      [
        { email: "a", usage: { weekly: 0.3, fable: 0.1 } },
        { email: "b", usage: { weekly: 0.3, fable: 0.41, grants: [fableGrant("launch-2610-fable")] } },
        { email: "c", usage: { weekly: 0.3, fable: 0.53, grants: [fableGrant("launch-2610-fable")] } },
      ],
      { messages: (index) => (index === 2 ? Response.json({ error: "overloaded" }, { status: 529 }) : undefined) },
    );
    expect(await pool.send("claude-fable-5", "s1")).toEqual({ status: 200, servedBy: "b" });
    expect(pool.attempts).toEqual(["c", "b"]);
  });

  it("prefers only a Fable grant that has started, on an account eligible for resets", async () => {
    const pool = await makePool([
      { email: "a", usage: { weekly: 0.3, fable: 0.1 } },
      { email: "b", usage: { weekly: 0.3, fable: 0.41, eligible: false, grants: [fableGrant("launch-2610-fable")] } },
      { email: "c", usage: { weekly: 0.3, fable: 0.53, grants: [fableGrant("later", { starts_at: iso(NOW + HOUR) })] } },
    ]);
    expect((await pool.send("claude-fable-5")).servedBy).toBe("a");
  });
});

describe("state stored by the first build", () => {
  it("reads each legacy shape, ignoring the fields no longer kept", async () => {
    const db = new Database(":memory:");
    for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
    const quotas = new QuotaStore(db);
    const accountId = "aaaaaaaa-0000-4000-8000-000000000001";
    // An account_resets row as the first build wrote it: a grant label and the exhausted limits.
    const legacy = {
      eligible: true,
      ineligibleReason: null,
      exhausted: ["seven_day"],
      grants: [
        {
          id: "full-reset-2611",
          label: "Full usage reset",
          kind: "weekly",
          resetsTotal: 1,
          resetsLeft: 1,
          startsAt: null,
          endsAt: Date.parse("2026-12-10T00:00:00Z"),
          clears: ["seven_day", "seven_day_overage_included"],
          paused: false,
          usableNow: true,
          useRequiresLimit: true,
          percentUsed: { seven_day: 1 },
          blocking: [],
          unavailableReason: null,
        },
      ],
      cooldownUntil: null,
      observedAt: NOW,
    };
    db.prepare("INSERT INTO account_resets (account_id, resets_json) VALUES (?, ?)").run(accountId, JSON.stringify(legacy));
    const read = quotas.getResets(accountId);
    expect(read?.grants.map((grant) => [grant.id, grant.kind, grant.resetsLeft])).toEqual([["full-reset-2611", "weekly", 1]]);
    expect(read).not.toHaveProperty("exhausted");
    expect(read?.grants[0]).not.toHaveProperty("label");
    db.close();

    // A wall record as the first build wrote it: an object, not true.
    const kv = memoryKv();
    await kv.set("reset-wall-claimed", { at: NOW });
    const store = new ResetClaimStore(kv);
    expect(await store.wallClaimed()).toBe(true);
    // An account served: the legacy wall record goes.
    await store.setWallClaimed(false);
    expect(await kv.get("reset-wall-claimed")).toBeUndefined();
    expect(await new ResetClaimStore(kv).wallClaimed()).toBe(false);
  });
});

describe("review round 2 regressions", () => {
  type Pool = Awaited<ReturnType<typeof makePool>>;
  const wall = () => [
    { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611")] } as Usage },
    { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable")] } as Usage },
  ];
  const messages = (pool: Pool) => pool.logs.map(([, message]) => message);

  it("ignores an unsettled claim past the horizon on another account, but not a young one", async () => {
    const pool = await makePool(wall());
    const gmail = pool.accounts[1]!.id;
    await pool.resetClaims.setPending(gmail, { grantId: "launch-2610-fable", requestId: "old", resetsLeftBefore: 1, at: NOW - 11 * 60_000 });
    await pool.send("claude-opus-5");
    expect(pool.claims.map((claim) => claim.body.grant_id)).toEqual(["full-reset-2611"]);
    const young = await makePool(wall());
    await young.resetClaims.setPending(young.accounts[1]!.id, { grantId: "launch-2610-fable", requestId: "young", resetsLeftBefore: 1, at: NOW - 9 * 60_000 });
    expect((await young.send("claude-opus-5")).status).toBe(429);
    expect(young.claims).toEqual([]);
    expect(messages(young)).toEqual([
      `Account Pooler does not auto-claim a usage reset: an earlier claim of launch-2610-fable on erwin@gmail.com is unsettled until ${iso(NOW + 60_000)}.`,
    ]);
  });

  it("marks the wall before an automatic claim is sent, and not for one that never left", async () => {
    let wallAtSend: unknown;
    let ref: Pool;
    const pool = (ref = await makePool(wall(), {
      claim: async () => {
        wallAtSend = await ref.kv.get("reset-wall-claimed");
        return { status: 200, body: { result: "not_limited", resets_left: 1, cleared: [] } };
      },
    }));
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(wallAtSend).toBe(true);
    expect(await pool.kv.get("reset-wall-claimed")).toBe(true);

    // The profile read fails: nothing is sent, and the wall stays unmarked.
    const unsent = await makePool(wall(), { profileFails: () => true });
    expect((await unsent.send("claude-opus-5")).status).toBe(429);
    expect(unsent.claims).toEqual([]);
    expect(await unsent.kv.get("reset-wall-claimed")).toBeUndefined();
    expect(await unsent.resetClaims.pending(unsent.accounts[0]!.id)).toBeNull();
    // Only tech@'s profile read fails: its pick never leaves, and gmail's is the wall's one claim.
    let other: Pool;
    let wallAtOther: unknown;
    const spread = wall();
    spread[1]!.usage = { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [rawGrant("gmail-reset")] };
    other = await makePool(spread, {
      profileFails: (index) => index === 0,
      claim: async () => {
        wallAtOther = await other.kv.get("reset-wall-claimed");
        return { status: 200, body: { result: "not_limited", resets_left: 1, cleared: [] } };
      },
    });
    expect((await other.send("claude-opus-5")).status).toBe(429);
    expect(other.claims.map((claim) => [claim.email, claim.body.grant_id])).toEqual([["erwin@gmail.com", "gmail-reset"]]);
    expect(wallAtOther).toBe(true);
    expect(await other.kv.get("reset-wall-claimed")).toBe(true);
    expect(await other.resetClaims.pending(other.accounts[0]!.id)).toBeNull();
    // A grant refused before any send leaves it unmarked too.
    const blocked = wall();
    blocked[0]!.usage = { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611", { blocking: ["five_hour"] })] };
    blocked[1]!.usage = { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR };
    const refused = await makePool(blocked);
    expect((await refused.send("claude-opus-5")).status).toBe(429);
    expect(await refused.kv.get("reset-wall-claimed")).toBeUndefined();
  });

  it("refuses a claim when the account's pending record does not parse, leaving it as it is", async () => {
    const pool = await makePool([{ email: "tech@equisafe.io", usage: { weekly: 1, grants: [rawGrant("full-reset-2611")] } }]);
    const id = pool.accounts[0]!.id;
    await pool.kv.set(`reset-claim:${id}`, { grantId: "full-reset-2611", requestId: "has spaces", resetsLeftBefore: 1, at: NOW });
    expect(await pool.resetClaims.pending(id)).toBe("unreadable");
    expect(await pool.hub.claimReset(id, "weekly")).toEqual({
      status: "refused",
      reason: `its unsettled-claim record (KV reset-claim:${id}) does not parse, and its request id may be the only safe one to resend; nothing was sent, and the record is left as it is`,
    });
    expect(await pool.kv.get(`reset-claim:${id}`)).toEqual({ grantId: "full-reset-2611", requestId: "has spaces", resetsLeftBefore: 1, at: NOW });
    expect(pool.claims).toEqual([]);
    // An absent record is no pending claim: the claim goes ahead.
    await pool.kv.delete(`reset-claim:${id}`);
    expect(await pool.resetClaims.pending(id)).toBeNull();
    expect(await pool.hub.claimReset(id, "weekly")).toMatchObject({ status: "answered", result: "reset" });
  });

  it("declines an automatic claim while any pending record does not parse", async () => {
    const pool = await makePool(wall());
    await pool.kv.set(`reset-claim:${pool.accounts[1]!.id}`, { broken: true });
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(messages(pool)).toEqual([
      "Account Pooler does not auto-claim a usage reset: the unsettled-claim record of erwin@gmail.com does not parse.",
    ]);
  });

  it("counts the horizon from the last send of an unsettled claim", async () => {
    const pool = await makePool([
      { email: "tech@equisafe.io", usage: { weekly: 1, grants: [rawGrant("full-reset-2611"), fableGrant("launch-2610-fable-6mo")] } },
    ], { claim: () => ({ status: 503 }) });
    const id = pool.accounts[0]!.id;
    expect((await pool.hub.claimReset(id, "weekly"))?.status).toBe("unsettled");
    const first = (await pool.resetClaims.pending(id)) as PendingClaim;
    pool.advance(9 * 60_000);
    expect((await pool.hub.claimReset(id, "weekly"))?.status).toBe("unsettled");
    expect(await pool.resetClaims.pending(id)).toEqual({ ...first, at: NOW + 9 * 60_000 });
    // 11 minutes after the first send, 2 after the last: still unsettled.
    pool.advance(2 * 60_000);
    expect(await pool.hub.claimReset(id, "fable")).toEqual({
      status: "refused",
      reason: `an earlier claim of full-reset-2611 on tech@equisafe.io is unsettled; claim it again to resend it, or wait until ${iso(NOW + 19 * 60_000)}`,
    });
    expect(pool.claims.map((claim) => claim.body.request_id)).toEqual([first.requestId, first.requestId]);
  });

  it("declines the wall spend when a fresh read answers 200 without a usage reading", async () => {
    const pool = await makePool(wall());
    pool.advance(1_000);
    pool.setUsage(1, "malformed");
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(messages(pool)).toEqual([
      "Account Pooler does not auto-claim a usage reset: the usage read of erwin@gmail.com returned no usage reading.",
    ]);
  });

  it("holds a grant unusable now only when the server says why", () => {
    const grant = (extra: Record<string, unknown>) =>
      resetsFromUsage(usagePayload({ weekly: 0.5, grants: [fableGrant("f", { use_requires_limit: false, ...extra })] }), NOW)!.grants[0]!;
    expect(holdsGrant(grant({}), NOW)).toBe(true);
    expect(holdsGrant(grant({ usable_now: false }), NOW)).toBe(false);
    expect(holdsGrant(grant({ usable_now: false, use_requires_limit: true }), NOW)).toBe(true);
    expect(holdsGrant(grant({ usable_now: false, blocking: ["five_hour"] }), NOW)).toBe(true);
    expect(holdsGrant(grant({ usable_now: false, unavailable_reason: "at_five_hour" }), NOW)).toBe(true);
    expect(holdsGrant(grant({ usable_now: false, use_requires_limit: true, paused: true }), NOW)).toBe(false);
  });

  it("sends no Fable traffic toward a grant unusable for no stated reason", async () => {
    const pool = await makePool([
      { email: "a", usage: { weekly: 0.3, fable: 0.1 } },
      { email: "c", usage: { weekly: 0.3, fable: 0.53, grants: [fableGrant("launch-2610-fable", { usable_now: false, use_requires_limit: false })] } },
    ]);
    expect((await pool.send("claude-fable-5")).servedBy).toBe("a");
  });
});

describe("review round 3 regressions", () => {
  const walled = (grants: unknown[]): Usage => ({ weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants });
  const wall = () => [
    { email: "tech@equisafe.io", usage: walled([rawGrant("full-reset-2611")]) },
    { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable")] } as Usage },
  ];

  it("takes an earlier claim a read shows used as the wall's success: serves, and spends no second grant", async () => {
    const pool = await makePool(wall());
    const tech = pool.accounts[0]!.id;
    // Sent 11 minutes ago with no answer: past the horizon, so the pool-wide check lets it through.
    await pool.resetClaims.setPending(tech, { grantId: "full-reset-2611", requestId: "earlier", resetsLeftBefore: 1, at: NOW - 11 * 60_000 });
    // The wall's fresh read still shows tech@ at its limit; the claim's own read shows the reset used.
    let reads = 0;
    pool.setUsage(0, () =>
      (reads += 1) === 1 ? walled([rawGrant("full-reset-2611")]) : { weekly: 0, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] },
    );
    expect(await pool.send("claude-opus-5")).toEqual({ status: 200, servedBy: "tech@equisafe.io" });
    expect(pool.claims).toEqual([]);
    expect(await pool.resetClaims.wallClaimed()).toBe(false);
    expect(await pool.resetClaims.pending(tech)).toBeNull();
  });

  it("dates the wall's fresh reads by the reset reading, not a quota a vendor response moved", async () => {
    const pool = await makePool(wall());
    pool.advance(1_000);
    const gmail = pool.accounts[1]!.id;
    pool.setUsage(1, () => {
      // A response on gmail lands during the read and bumps its quota's observedAt.
      pool.quotas.put({ ...pool.quotas.get(gmail), observedAt: NOW + 1_000 });
      return "malformed";
    });
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims).toEqual([]);
    expect(pool.logs.map(([, message]) => message)).toEqual([
      "Account Pooler does not auto-claim a usage reset: the usage read of erwin@gmail.com returned no usage reading.",
    ]);
  });
});

describe("review round 4 regressions", () => {
  const wall = () => [
    { email: "tech@equisafe.io", usage: { weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611")] } as Usage },
    { email: "erwin@gmail.com", usage: { weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable")] } as Usage },
  ];

  it("stops after a sent claim even when a served response clears the wall record meanwhile", async () => {
    let ref: Awaited<ReturnType<typeof makePool>>;
    const pool = (ref = await makePool(wall(), {
      claim: async () => {
        // An in-flight Claude request completes OK during the claim: the wall record goes.
        await ref.resetClaims.setWallClaimed(false);
        return { status: 503 };
      },
    }));
    expect((await pool.send("claude-opus-5")).status).toBe(429);
    expect(pool.claims.map((claim) => claim.body.grant_id)).toEqual(["full-reset-2611"]);
    expect(await pool.resetClaims.pending(pool.accounts[0]!.id)).toMatchObject({ grantId: "full-reset-2611" });
  });

  it("selects again after a sent claim answered otherwise when its re-read shows an account can serve", async () => {
    let ref: Awaited<ReturnType<typeof makePool>>;
    const pool = (ref = await makePool(wall(), {
      claim: () => {
        // The weekly window rolled over mid-claim.
        ref.setUsage(0, { weekly: 0.1, grants: [rawGrant("full-reset-2611", { usable_now: false, unavailable_reason: "not_limited" })] });
        return { status: 200, body: { result: "not_limited", reason: "below_limit", resets_left: 1, cleared: [] } };
      },
    }));
    expect(await pool.send("claude-opus-5")).toEqual({ status: 200, servedBy: "tech@equisafe.io" });
    expect(pool.claims.map((claim) => claim.body.grant_id)).toEqual(["full-reset-2611"]);
  });
});

describe("review round 5 regressions", () => {
  type Pool = Awaited<ReturnType<typeof makePool>>;
  const walledTech = (): Usage => ({ weekly: 1, weeklyResetAt: NOW + 5 * 24 * HOUR, grants: [rawGrant("full-reset-2611")] });
  const walledGmail = (): Usage => ({ weekly: 1, weeklyResetAt: NOW + 2 * 24 * HOUR, grants: [fableGrant("launch-2610-fable")] });
  const usedTech = (): Usage => ({ weekly: 0.1, grants: [rawGrant("full-reset-2611", { resets_left: 0, usable_now: false })] });

  it("spends no next reset when a claim by hand freed an account during the probe", async () => {
    const pool = await makePool([
      { email: "tech@equisafe.io", usage: walledTech() },
      { email: "erwin@gmail.com", usage: walledGmail() },
    ]);
    // The wall's read shows tech@ walled; by the automatic claim's own read, a claim by hand has
    // spent its reset (that claim's re-read refreshed tech@'s reading).
    let reads = 0;
    pool.setUsage(0, () => ((reads += 1) === 1 ? walledTech() : usedTech()));
    expect(await pool.send("claude-opus-5")).toEqual({ status: 200, servedBy: "tech@equisafe.io" });
    expect(pool.claims).toEqual([]);
    expect(pool.logs.map(([, message]) => message)).toContain(
      "Account Pooler does not auto-claim a usage reset: tech@equisafe.io can serve now.",
    );
  });

  it("sends one claim when a real claim by hand races the probe", async () => {
    let ref: Pool;
    const pool = (ref = await makePool(
      [
        { email: "tech@equisafe.io", usage: walledTech() },
        { email: "erwin@gmail.com", usage: walledGmail() },
      ],
      {
        claim: (index) => {
          if (index === 0) ref.setUsage(0, usedTech());
          return { status: 200, body: { result: "reset", resets_left: 0, cleared: ["seven_day"] } };
        },
      },
    ));
    let manual: Promise<unknown> | null = null;
    pool.setUsage(1, () => {
      manual ??= pool.hub.claimReset(pool.accounts[0]!.id, "weekly");
      return walledGmail();
    });
    const answer = await pool.send("claude-opus-5");
    await manual;
    expect(pool.claims.map((claim) => claim.email)).toEqual(["tech@equisafe.io"]);
    expect(answer.status === 200 || answer.status === 429).toBe(true);
    expect((await pool.send("claude-opus-5")).servedBy).toBe("tech@equisafe.io");
  });

  it("stops an automatic claim just before its POST when another account frees up meanwhile", async () => {
    const pool = await makePool([
      { email: "tech@equisafe.io", usage: walledTech() },
      { email: "erwin@gmail.com", usage: walledGmail() },
    ]);
    const gmail = pool.accounts[1]!.id;
    let reads = 0;
    pool.setUsage(0, () => {
      // During the automatic claim's own read, a claim by hand on gmail lands.
      if ((reads += 1) === 2) pool.quotas.put({ ...pool.quotas.get(gmail), sevenDayUtilization: 0.1, sevenDayStatus: "allowed" });
      return walledTech();
    });
    expect(await pool.send("claude-opus-5")).toEqual({ status: 200, servedBy: "erwin@gmail.com" });
    expect(pool.claims).toEqual([]);
    expect(await pool.resetClaims.wallClaimed()).toBe(false);
    expect(await pool.resetClaims.pending(pool.accounts[0]!.id)).toBeNull();
    expect(pool.logs.map(([, message]) => message)).toContain(
      "Account Pooler does not auto-claim a usage reset: erwin@gmail.com can serve now.",
    );
  });

  it("treats a credential that cannot be prepared at claim time as unsent, and moves to the next pick", async () => {
    let failing = false;
    const pool = await makePool(
      [
        { email: "tech@equisafe.io", usage: walledTech() },
        { email: "erwin@gmail.com", usage: walledGmail() },
      ],
      { secretFails: (index) => index === 0 && failing },
    );
    let reads = 0;
    pool.setUsage(0, () => {
      // After the automatic claim's own read of tech@, its credential fails.
      if ((reads += 1) === 2) failing = true;
      return walledTech();
    });
    await pool.send("claude-opus-5");
    expect(pool.claims.map((claim) => claim.email)).toEqual(["erwin@gmail.com"]);
    expect(await pool.resetClaims.pending(pool.accounts[0]!.id)).toBeNull();
    expect(pool.logs.map(([, message]) => message)).not.toContain(expect.stringContaining("full-reset-2611 on tech@equisafe.io: unsettled"));
    // By hand: refused, nothing sent, no pending record, no wall mark.
    failing = false;
    const solo = await makePool([{ email: "tech@equisafe.io", usage: walledTech() }], { secretFails: () => failing });
    const id = solo.accounts[0]!.id;
    solo.setUsage(0, () => {
      failing = true;
      return walledTech();
    });
    expect(await solo.hub.claimReset(id, "weekly")).toEqual({
      status: "refused",
      reason: "its credential could not be prepared (the secret file is unreadable); nothing was sent",
    });
    expect(solo.claims).toEqual([]);
    expect(await solo.resetClaims.pending(id)).toBeNull();
    expect(await solo.resetClaims.wallClaimed()).toBe(false);
  });
});
