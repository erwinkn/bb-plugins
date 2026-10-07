# Account Pooler (fork)

A local fork of BB 0.43.1's Account Pooler 0.1.0. It requests a configurable
Claude main-conversation cache TTL and retains eligible session/account bindings
for a configurable idle period. The builtin package stays intact.

| Control | Default | Accepted values | Effect |
| --- | --- | --- | --- |
| `claudeMainCacheTtl` | `1h` | `5m`, `1h` | Contributes `CLAUDE_CODE_PROMPT_CACHE_TTL` to routed Claude sessions |
| `sessionAffinityIdleMinutes` | `60` | Whole minutes, 1 through 43200 | Idle expiry for Claude and Codex session pins, including inherited pins |

Change them in the plugin's Advanced controls, or use:

```sh
bb pool-local config
bb pool-local config set claudeMainCacheTtl 1h
bb pool-local config set sessionAffinityIdleMinutes 60
```

The controls are independent. A 60-minute affinity matches a one-hour cache;
30 minutes remains selectable for the native baseline behavior. A longer
binding never makes an exhausted, disabled or invalid account eligible. Model
family detours retain the main pin and provider cursor. Long temporary limits
still hold pinned sessions; short limits retain native pacing. The 4096-pin
capacity, OAuth refresh, streaming and retry policies are inherited unchanged.
Reducing the idle duration takes effect on the next selection and service start.
Increasing it cannot recover a binding already evicted or pruned.

## Claude TTL precedence

Claude Code v2.1.242 or later supports the explicit main control. The pool
contributes it alongside the proxy URL and auth token, before the provider
constructs the Claude subprocess. The provider merges the contributed environment
into its session environment; it does not infer subscription eligibility first.
The proxy forwards the client's cache markers and `anthropic-beta` header without
rewriting their TTL. It cannot guarantee that an upstream accepts or serves 1h.

[Claude Code's documented precedence](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself)
is force-five-minutes, bucket environment variable, bucket setting, applicable
subagent frontmatter, global one-hour flag, then automatic defaults. In particular:

- `FORCE_PROMPT_CACHING_5M=1` overrides this fork's requested main TTL for both buckets.
- This fork's main environment entry overrides an inherited main environment
  value and the `promptCacheTtl` setting once BB resolves it into the session.
- `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and `subagentPromptCacheTtl` remain
  separate. This fork sets neither and changes neither global force flag.
- `ENABLE_PROMPT_CACHING_1H=1` can still affect the separate helper bucket. A main `5m` entry takes
  precedence for the main bucket.
- Disabled caching, unsupported clients/providers and other plugins' environment
  contributions can prevent the intended result. BB keeps the first contributor
  for a duplicate variable name, so never enable both pools together.

Native BB worker threads are separate Claude main conversations. Subagents and
background helpers use the separate bucket. Inline helpers, including the
auto-mode classifier (`auto_mode`) and memory-relevance helper
(`memdir_relevance`), follow the main TTL and its write cost. The fork changes
neither helper routing nor the client's bucket selection. Plugin reload alone
does not prove an already-running Claude process received the new environment.

## Advisor routes

Two token-auth routes let the Advisor plugin send one bounded review request
through a pooled subscription account:

- `POST /api/v1/plugins/account-pool-local/http/advisor/v1/messages` → Anthropic `/v1/messages`
- `POST /api/v1/plugins/account-pool-local/http/advisor/v1/responses` → Codex `/responses`

Both are off until turned on in Settings or with
`bb pool-local advisor set <claude|codex|maxUtilization> <on|off|value|null>`.
Their settings live in their own kv record, `advisor-config`, so the native
`config` record keeps its five keys and a rollback to a build without advisor
routes loads unchanged. An invalid `advisor-config` turns only the advisor routes
off, with its error in Settings, `bb pool-local status` and the 403 body.

Each request makes at most one vendor POST: no retry, failover, 429 wait or
refresh-and-resend. Only enabled OAuth accounts below
`min(maxUtilization ?? switchThreshold, switchThreshold)` are picked. Advisor
traffic never marks an account error, never sets a hold, never forces a credential
refresh and never waits behind native credential repair; it records quota headers
and `lastUsed` (`advisor`). The Pooler keeps only allowed caller headers, names the
client `bb-advisor`, adds the OAuth beta, refuses compressed bodies (415) and bodies
over 256 KiB (413), and drops a `token` query parameter. A declared
`Content-Length` over the cap is refused unread, and a streamed body is read only
until it passes the cap. Every response it returns carries
`x-account-pool-dispatch: none|sent`.

A new numeric `maxUtilization` must not exceed the current `switchThreshold`. A
stored value that a later, lower threshold left above it stays stored and is
clamped; route toggles and other updates keep working, so a route can always be
turned off. Validation errors are plain text, the same in Settings, the CLI and
RPC: for example `maxUtilization: Must be at most 1.`,
`routes: Unrecognized key: "gemini"` or `Must be at most switchThreshold (0.8).`
`advisor.set` and `warming.set` validate in their handlers, so RPC callers get
this text rather than BB's generic `rpc input validation failed`.

### Advisor contract

The caller (the Advisor plugin) authenticates with BB's plugin token in the
`x-bb-plugin-token` header, never `?token=`. It sends an uncompressed JSON body of
at most 262,144 bytes, pins its own model and checks the response's model; the
Pooler never rewrites `model`. Caller headers kept: Claude `accept`,
`content-type`, `anthropic-version`, `anthropic-beta` (minus `claude-code-*`);
Codex `accept`, `content-type`. `sent` is stamped just before the vendor fetch
starts; a response without the header came from BB itself (its own 401/404/503 or
`500 plugin route failed`) and may have executed.

| Status | Dispatch | Meaning |
| --- | --- | --- |
| 403 | none | Route off, or `advisor-config` invalid (the body says which) |
| 415 | none | `content-encoding` other than none or identity |
| 413 | none | Body over 256 KiB, declared or read |
| 429 | none | No eligible account (off, error, held, at reserve, API key only) |
| 503 | none | Pooler not accepting, or no credential ready without native repair |
| 499 | none or sent | Caller aborted; `sent` means it may have executed |
| 503 | sent | Pooler stopped mid-request |
| 502 | sent | Vendor unreachable after the send started |
| vendor status | sent | The vendor's response, passed through |

Errors use the vendor's error shape (Anthropic
`{type:"error",error:{type,message}}`). RPC: `advisor.get` →
`{routes, maxUtilization, effectiveMaxUtilization, error}`, `advisor.set(partial)`.

## Cache warming

Off by default. When on, the Pooler keeps a waiting Claude thread's prompt cache
entry alive by re-sending the thread's last native request with `max_tokens: 0`
and `stream` removed, on the same account, shortly before the entry expires.
Anthropic documents this as a keep-alive: it refreshes the entry and bills a cache
read, with no output tokens. It is not a thread message, turn or agent run.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `off` | `off`: nothing observed, no extra env. `observe`: record and plan only. `warm`: send keep-alives |
| `roles` | all four | Which threads may be warmed: `coordinator`, `worker`, `reviewer`, `standalone` (BB threads outside any Initiative, and adhoc Initiative threads) |
| `maxWaitMinutes` | 60 | No refresh once a wait is this old, whatever the odds (5–240) |
| `maxBackgroundWaitMinutes` | 20 | No refresh once a thread waiting on a background task has waited this long (5–240); `maxWaitMinutes` still applies if lower |
| `pauseStopsWarming` | `true` | No refreshes while the thread's Initiative is paused (an agent default, D357) |
| `families` | `opus` | Model families whose requests can start a lease; a request in any family ends one |
| `safetyMarginSeconds` | 60 | Refresh this long before expiry |
| `maxRefreshesPerHour`, `maxConcurrentRefreshes`, `maxLeases`, `maxLeaseBodyKiB`, `refreshTimeoutSeconds` | 100, 2, 8, 4096, 60 | Global bounds |
| `quotaReserve` | 0.9 | Stop warming an account at this fraction, never above `switchThreshold` |
| `historyLimit`, `historyMinutes` | 200, 60 | Decisions kept for status |

Change them in Settings or with `bb pool-local warming set <key> <value>`;
`bb pool-local warming status` shows leases, refreshes and recent decisions. The
record is `warming-config`, separate from native `config`; an invalid record turns
warming off visibly. A record from the fixed-window model (T141 replaced
`coordinatorMinutes`, the other `*Minutes` windows and `maxRefreshesPerLease`)
is migrated at startup and saved: those keys are dropped, and a
`maxRefreshesPerHour` at the old default of 60 becomes 100, since warming every
linked thread needs more (the Oct 5–7 back-test peaked at 96 an hour). A record saved
since keeps whatever budget it sets, 60 included.

Timing comes from observed requests, never from BB turn ends:

- The wait starts when the session's last native request completes.
- `coveredUntil` = start of the last request that wrote or read the entry + its TTL.
  The TTL is the last `cache_control` breakpoint actually sent, not
  `claudeMainCacheTtl`.
- A refresh is due at `coveredUntil - safetyMargin`. A refresh that reads the whole
  native prefix moves `coveredUntil` to its own start + TTL. Only a native request
  ends the wait.

**Whether a refresh pays** (`src/warming-economics.ts`). At every due time the
Pooler reads what the thread waits on from BB's thread list: a pending question,
a tool mid-turn (the thread is active), a background command or agent after the
turn, or nothing. In units of the cached prefix C, a refresh costs 0.1 (a cache
read) and a resume after expiry costs 1.15 more than a warm one (a 1.25 write
instead of a 0.1 read; 1.9 for a 1h entry). The entry already lasts until wait
age c; n refreshes from age a keep it until a + (n−1)·step + TTL. With S(t) the
chance that a wait lasts longer than t, those n refreshes are worth

    net(n) = 1.15 × (S(c) − S(a + (n−1)·step + TTL)) − 0.1 × Σ_{j<n} S(a + j·step)

so only resumes after the current expiry count as savings. The Pooler refreshes
while some n gives a positive net. It decides again at every refresh, so
refreshes already spent never count, and a wait that usually ends a few steps
later is warmed through the steps in between. C cancels out.

- Mid-turn, the turn resumes when its tool returns; with a background command or
  agent running, the thread resumes when it reports back. Both are warmed
  whatever the odds: mid-turn until `maxWaitMinutes`, on a background task until
  `maxBackgroundWaitMinutes` (in the Oct 5–7 ledger, most background tasks that
  ran longer than 20 minutes never led to a resume). A lease whose background
  task ended without a resume stops at its next due time.
- For a pending question or an ended turn, S comes from observed waits of the
  same state and role: a built-in history from the ledger of 2026-10-05 to 10-07,
  plus the Pooler's own `usage_warming` rows of the last 7 days (at most the
  newest 20,000, through an index), read again at most every 10 minutes. A role
  with few waits is shrunk toward its state's (5 pseudo-waits); past every
  observed wait the thread is assumed not to resume.
- A waiting-state read that takes over 10 seconds counts as unknown and ends the
  lease, and whatever a refresh's checks wait on, the lease ends when its entry
  expires.

Example: a worker runs a 9-minute test suite. Its last request completes at
12:00:30 and the thread stays active, so refreshes go out at 12:04 and 12:08 and
the 12:09:30 request reads the cache. Had it run the suite in the background
and ended its turn, the same refreshes go out while the suite runs; if the suite
ends and the thread does not resume, the next due time ends the lease.

Pi (`@earendil-works/pi-coding-agent` 1.0.4, `core/cache-warmer.js`) makes the
same comparison one refresh at a time: refresh while P(resume before expiry) ×
miss cost − warm cost ≥ $0.05, with P = 1 while the agent runs and a measured
0.15 when idle, and 60/30-minute caps. The Pooler adds the lookahead and odds per
waiting state and role, calibrated from its own history.

**Attribution.** Nothing is added to a thread's environment, in any mode. Each
request's `metadata.user_id` carries Claude Code's session id, which BB records as
the `providerThreadId` of the thread's `thread/identity` event when the session
starts, before its first request. The Pooler links a thread to its session from
the latest such event:

- when a request arrives on a session no thread is linked to, it asks BB in the
  background which running thread (`threads.listRunning`) reports that session.
  A lookup never delays the request. It is bounded: one pending per session, at
  most two at once, a 5-second deadline with its own signal, at most one per
  session every 30 s, and all are aborted on unload. It links only when every
  identity read succeeded and exactly one thread reports the session. This links
  a thread mid-turn, on its first turn, and after a reload;
- on every `thread.active` and `thread.idle` event for a claude-code thread;
- immediately before every keep-alive, to confirm the link.

`threads.context` is not used: it names the session only in the snapshot BB takes
when a turn ends, so it could not link a thread before its first turn ended, and
it carried no session at all mid-turn, which refused every mid-turn refresh.
Leases are keyed by session. A session no thread reported, or one that two
threads reported, never warms.

**Roles.** They come from the Initiatives plugin's token-auth read,
`GET /api/v1/plugins/initiatives/http/context/v1/thread?threadId=<thread>`: Initiatives
context contract v1.1, thread route. Initiatives documents it in
[its README](../initiatives/README.md#read-only-context-for-other-plugins). A plugin
that is installed but disabled answers 503 without a v1 body, which is unknown
context and warms nothing.

| Initiatives context | Warming |
| --- | --- |
| Active coordinator | `coordinator` |
| Active worker or reviewer, whatever its assignment's phase | `worker` / `reviewer` |
| Adhoc Initiative thread, or `membership: null` (a linked BB thread outside any Initiative) | `standalone` |
| Stopped, retired or former member | none |
| Archived Initiative; paused Initiative while `pauseStopsWarming` is on | none |
| Error, timeout, oversize, other version or thread, unknown value | none, with the reason |

The assignment's phase does not matter: a worker's next brief arrives as a
message in the same conversation, so a pending or undelivered assignment keeps
the prefix in use (the fixed-window model gave those 0 minutes), and an accepted
or reported worker that has ended its turn is judged by how often idle workers
resume.

**Admission.** A finished request takes a lease slot, and keeps its body, only
after its session is linked to a thread and the thread's role may be warmed.
Until then it waits without a slot: at most `maxLeases` requests wait (a newer
one replaces the oldest), each for at most 60 s or until its first due refresh. A
1h entry that already outlasts `maxWaitMinutes` is skipped before any read.

**Send-time checks.** Classification may use a 30 s cached read of the
membership; `null` and unknown results are never cached. Immediately before every
keep-alive, after credential preparation, the hub re-checks two things with
fresh, uncached reads: BB still links the thread to the lease's session, and
Initiatives still gives the thread a role that may be warmed. The current mode
and model families are checked before and after those reads. A settings change,
retirement, Stop, replacement, pause or new session since classification refuses
the send. This also applies to the dry runs in `observe`.

**Cancellation.**
- Any native request in the same session, in any model family, ends its lease and
  aborts a pending or in-flight refresh. So does a request on another session
  linked to the same thread, or one whose `parent_session_id` names the session.
- A completion starts a lease only once no other request of its session is in
  flight, whatever their families. A newer request that already finished blocks it
  only if that request could have leased itself (no `parent_session_id`, an
  enabled family): its prefix is the fresher one. A finished helper in another
  family does not, so when the final Opus request and a Haiku helper overlap, the
  Opus request leases whichever of the two started first. Nor does an
  eligible request that ended without a usable response (aborted, cut off or
  non-2xx). The newest usable eligible completion skipped while other requests
  of its session still ran is held, and once nothing is in flight it leases if
  one of those requests failed and none newer succeeded (two successes keep the
  earlier rule: nothing leases). A held completion passes every lease gate
  first, keeps a body only in warm mode, counts in `retainedBodyBytes`, is
  capped at `maxLeases` held at once and expires when its refresh would be
  due. Skips name the case: a newer request in flight, one that finished
  first, or (on the resumed lease) a newer or older one that failed. A lease
  already ended by a newer start is not reopened (D372).
- `thread.active` ends every lease and admission of the thread before its
  session is read again, because a new session may not have reported its
  identity yet.
- A settings change ends at once the leases its new mode or families no longer
  allow, including an in-flight refresh. Thread archival or deletion and reload
  cancel leases at once.
- Initiatives records no coordinator Stop, and BB's public thread record has no Stop
  flag. A stopped coordinator mid-wait is judged by its waiting state like any
  other thread.

Every lease end, and every finished request whose wait goes unwarmed (no
parent-less session, a family not enabled, no cache breakpoint, a body too
large, …), is written to the ledger's `usage_warming` table with its reason, so a
cold rewrite can be traced to the decision behind it.

Keep-alives go only to the lease's account and never mark, hold or repair it. A
body that `max_tokens: 0` rejects (`thinking.type: enabled`, a forced
`tool_choice`, `output_config.format`) is not leased. Unknown usage, a cache miss
on refresh, an ineligible account, or any bound ends the lease with a visible
reason.

**Subagents and same-session helpers (limitation).** Claude Code 2.1.287 sets
`metadata.user_id.parent_session_id` from its agent-team context
(`getParentSessionId`), so it marks a teammate session, not an ordinary Task
subagent or helper. Task subagents and helper requests appear to share the main
session id and carry no parent, and nothing in the request tells them apart. The
Pooler does not try to identify them:

- Every same-session request ends the lease, including a helper sent after the
  turn's final main request. Claude Code 2.1.287 has helper sources that can run
  then: `tool_use_summary_generation`, `generate_session_title`,
  `prompt_suggestion` and `extract_memories`. If BB's sessions send one after the
  final main request, that turn gets no warming. This is conservative and not
  solved.
- If a subagent's or a forked helper's request in an enabled family is the
  session's last to finish, its body becomes the lease body. A refresh of it is
  still a `max_tokens: 0` cache read with no output, but it keeps that request's
  prefix warm instead of the main one.

Root's live checks: whether real Task subagent requests carry the main session
id, and which helper `querySource` traffic, if any, follows the final main request
in the same session.

Leases keep the exact request body only in memory, only in `warm` mode, and drop
it when they end. Status shows hashes, token counts and requests only; it makes no
dollar estimate. `scripts/copy-pool-state.py` does not carry `advisor-config` or
`warming-config` into a new install.

## Usage ledger

The Pooler keeps a durable record in its SQLite database so a report can tell
whether cache warming saves more quota than it costs:

- `usage_requests`: one row per upstream model request (native, warming refresh
  or advisor; Claude `/v1/messages` and Codex POST routes, not `count_tokens` or
  `GET /v1/models`). A retried attempt gets its own row. Columns: start time,
  kind, provider, session key, BB thread and Initiative role when already known,
  account, model and family, the tail breakpoint's cache TTL, HTTP status,
  latency, input, output, cache read and cache write (5m, 1h) tokens, and the
  idle gap since the session's previous native request on the same model. Codex
  rows carry OpenAI's cached tokens as cache reads.
- `usage_quota`: a row per account each time its observed 5h, 7d, per-family
  weekly or Codex window utilization or reset time changes.
- `usage_settings`: `claudeMainCacheTtl` and the warming settings, recorded at
  startup and after every change, so a report can split periods by setting.
- `usage_warming`: one row per warming lease that ended and per finished request
  whose wait went unwarmed: session, thread, model, role, what the thread waited
  on at the first refresh decision, when the wait started, prefix tokens, TTL,
  refreshes sent, and the reason. Economic warming calibrates from these rows;
  a review attributes cold rewrites with them.

Rows hold counts, ids and times, never a request or response body. Every
dispatched attempt gets a row, including one that failed to connect or was
canceled after it was sent (status and usage empty). Recording only queues in
memory; a later event-loop turn reads at most 8 MiB of request bodies (shutdown
and a report read them all) and writes at most 500 rows per table through the
ledger's own SQLite connection, which never waits for a lock: when another
writer holds it, the rows stay queued and retry a second later. Queues are
bounded and drop their oldest row, counted. A failed write is logged (at most
once a minute) and counted, and never reaches the request. Rows older than the
retention (default 30 days) are pruned hourly, 500 rows at a time.

```sh
bb pool-local usage report [--since 7d|24h|90m|2026-10-05] [--json]
bb pool-local usage retention [<days>]
```

The report shows totals, each settings period and each UTC day: requests by
kind, Claude cache hit ratio, cache-write tokens by TTL, cold starts after an
expired TTL (rewrites, and hits kept warm by a refresh), refresh tokens, an
estimate of the net saving, and each account's utilization burn per observed
window (Claude 5h, 7d and per-family weekly; Codex windows by length).
Cold starts are judged per session and model, from successful requests only (a
failed attempt or refresh never counts as cache activity): a native request that
came more than the previous entry's TTL after the previous one either rewrote the
prefix or, if a refresh ran in between and it read more than it wrote, counts as
a rewrite avoided. A report that starts mid-session is seeded from the activity
just before `--since`. The
estimate weighs tokens at API price ratios to uncached input (cache read 0.1×,
5m write 1.25×, 1h write 2×, output 5×), the closest public proxy for
subscription quota. Subagents share their main session id, so a subagent on the
main model can hide a cold start but never invents one. The thread and role
columns are filled only while warming links sessions (any mode but `off`); since
T141 a session is linked from its first request, and a linked thread outside any
Initiative is labelled `standalone`.

## Request-path cost

The Pooler runs on BB's server event loop, which every BB request and plugin
shares, and Claude Code and Codex request bodies are often several MB. No step
of the request path parses, re-serializes or decodes a body whole.
`src/json-scan.ts` walks the bytes once and reads only what routing, warming and
the ledger compare: `model`, `metadata.user_id`, cache breakpoint TTLs,
`thinking.type`, `tool_choice.type` and whether `output_config.format` is set.
It accepts exactly the bodies `JSON.parse` accepts. Strings are checked 64 KiB
at a time while the body arrives (about 0.15 ms per chunk), so the walk that
follows skips them with a native search. The account rewrite and the warming
re-send edit bytes in place, so Anthropic receives the client's bytes except
the edited field. A body holding a number that `JSON.parse` and
`JSON.stringify` would write differently (`1.0`, `1e400`, `-0`) is
re-serialized whole instead, as before. On a 4 MB body: parse 1.2 ms, rewrite
0.2 ms, and a 3.7 ms describe (2.2 of it SHA-256) when the response ends.

```sh
npx tsx scripts/bench-request-path.ts            # 20 concurrent 3-8 MB requests
npx tsx scripts/bench-request-path.ts --rewrite  # each one rewrites the account
npx tsx scripts/bench-request-path.ts --stages   # each step on 1, 4 and 8 MB
```

`src/request-path.test.ts` fails when any step handles a body over 64 KiB whole,
including a large output schema, and pins the pre-scanner results for bodies
that are not JSON and for non-canonical numbers.

## Source and identity

[UPSTREAM.json](UPSTREAM.json) records the installed artifact hashes, original
source hashes and vendored UI hashes. The pinned upstream is
[get-bb/bb at 267938526dfcbc0edb228ce827b5bec202c1af97](https://github.com/get-bb/bb/tree/267938526dfcbc0edb228ce827b5bec202c1af97/plugins/account-pool).
All backend source-map contents match that release exactly before local edits.
The release is MIT, copyright 2026 Michael Yong. [LICENSE](LICENSE) preserves it.
The development dependency is pinned to SDK 0.4.87. The manifest requires BB
>=0.43.1 and a minimum SDK 0.4.87 within major 0: BB treats the engine string as a
same-major floor, so it also accepts newer 0.x SDKs. This corrects A90's claim
that the runtime engine was an exact pin; the original A90 evidence stays intact.
Because provider environment hooks are experimental, recheck them after every
BB update using the commands below. There is no additional runtime version guard.
Backend Zod 4.3.6 matches the installed bundle. The fork pins Undici 7.30.0
instead of native 7.28.0 because npm audit reports advisories fixed in newer
7.x releases, including [this maintainer advisory](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3).
This is an explicit dependency delta; exploitability of the native pool was not
established. Transport source and HTTP/1.1 policy stay native; all six native transport tests
pass with 7.30.0. [UPSTREAM.json](UPSTREAM.json) records all 15 npm advisory IDs,
GHSA IDs, affected 7.x ranges and patched versions. In particular,
[WebSocket decompression](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v)
and [WebSocket handshake](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5)
are patched in 7.29.1. This HTTP/1.1 dispatcher does not instantiate WebSocket,
WebSocketStream or BalancedPool, or install cache/retry interceptors. Advisory
presence alone does not establish reachability through this pool. The production
audit reports zero advisories; the full audit retains one low, development-only
esbuild advisory (GHSA-g7r4-m6w7-qqqr, Windows development server). Private
workspace dependencies are replaced by package-local vendored UI.

BB reserves builtin IDs and refuses a path plugin named `account-pool`. This fork
uses `bb-plugin-account-pool-local`, with plugin ID `account-pool-local`, CLI
`pool-local`, and skill `account-pool-local`. Its HTTP mount is
`/api/v1/plugins/account-pool-local/http`; the Codex base appends `/v1`.
RPC names and realtime topics stay native because BB namespaces them by plugin ID.
The browser status cache has its own `account-pool-local:status` key. The wire
header `x-bb-account-pool-token` intentionally stays compatible. There is no new
listener port, standalone service or BB core modification.

Storage maps as follows, with account IDs, host IDs and affinity keys unchanged:

| Native state | Local state |
| --- | --- |
| `bb.db` `plugin_kv` rows under `account-pool` | Same keys/values under `account-pool-local` |
| `plugins/account-pool/data.db` | `plugins/account-pool-local/data.db`, same migrations/quota/pin/cursor schemas |
| `plugins/account-pool/secrets/` | Copied to `plugins/account-pool-local/secrets/`, same filenames and account references |
| KV `config` | Native keys plus parsed defaults for the two local controls |
| Native settings/schedules | None declared; the handoff refuses unexpected rows |

Sharing the live directories would create two OAuth/state writers. The handoff
copies state instead. It never edits builtin code or plugin registration rows.

## Root-owned cutover

These commands are a reviewable procedure for the coordinator. This worker did
not execute them against live state. Choose a quiet window: no running Claude or
Codex turns, background provider requests, pending automatic starts or active
pool HTTP requests. Coordinate admission externally; the helper cannot prove
quiescence. Keep both pools disabled during the handoff and verify CLI disable
has completed. Do not remove either plugin or clear browser state.

```sh
bb plugin source account-pool --json
bb pool status --json
# Repeat for every affected idle Claude/Codex thread on every host.
bb thread stop THREAD_ID --json
bb plugin build /home/exedev/Code/bb-plugins/plugins/account-pool
bb plugin disable account-pool
bb plugin list --json
python3 /home/exedev/Code/bb-plugins/plugins/account-pool/scripts/copy-pool-state.py \
  --data-dir /home/exedev/.bb \
  --from account-pool --to account-pool-local \
  --backup-dir /home/exedev/.bb/pool-handoffs/W49-cutover \
  --quiescent
pool_handoff_since_ms="$(python3 -c 'import time; print(time.time_ns() // 1000000)')"
bb plugin install path:/home/exedev/Code/bb-plugins/plugins/account-pool --yes
bb plugin source account-pool-local --json
bb plugin list --json
bb pool-local config
bb pool-local status --json
bb pool-local account list --json
```

Use a fresh backup path. The copy must precede first install, which loads/enables
the path plugin. If the fork is already installed, disable it first. An existing
fork state directory or KV namespace makes the helper refuse by default; inspect
it before an explicit `--replace-target`. That option backs up the previous target.
The helper copies SQLite using its backup API, carries all native KV rows,
copies secrets with restrictive permissions, and rejects linked credential files.
It outputs counts and paths, never values. It refuses enabled pool registrations,
unexpected settings/schedules, missing source state and reused backup paths.

Compare account counts/IDs, provider routing flags and bypasses to the preflight;
inspect quota/pin/cursor persistence without printing credentials. Confirm the
builtin stays disabled. `bb thread stop THREAD_ID --json` is the supported action
that releases an idle resident runtime without clearing its provider session or
history. Apply it to **every affected session on every host**, including hidden
threads, while they are idle with no background work or scheduled starts. A
successful CLI response alone is not proof for an offline host: release can be
best-effort when that host is unavailable. Keep such a host excluded from traffic
until it reconnects, then repeat stop and verify its next resolution.

The next ordinary user turn (composer send, or root-authorized
`bb thread tell THREAD_ID "USER_AUTHORIZED_NEXT_MESSAGE"`) re-runs
`resolveThreadRuntimeCommandConfig` and `experimental_contributeEnv`, passes fresh
`resumeContext.contributedEnv` to the host, and resumes the **same** stored provider
session ID. There is no standalone `bb thread resume`/dry-start command. Do not
invent a test prompt or clear/recover the thread just to migrate its environment.

Before cutover, record each affected BB thread ID, environment host ID and provider
session ID using the checker below with `--plugin-id account-pool --main-ttl native --since-ms 0`. After its first authorized normal turn starts, run on the **server's**
data directory (it contains diagnostics for all hosts):

```sh
python3 /home/exedev/Code/bb-plugins/plugins/account-pool/scripts/check-session-env.py \
  --data-dir /home/exedev/.bb \
  --thread-id THREAD_ID --host-id HOST_ID \
  --expected-session-id ORIGINAL_PROVIDER_SESSION_ID \
  --plugin-id account-pool-local --main-ttl 1h \
  --since-ms "$pool_handoff_since_ms"
```

Repeat for each inventoried host/session; use the actual configured `5m` or `1h`.
Require exit 0 with `freshEnvEvent`, `hostMatches`, `providerSessionMatches`,
`routeMatches` and `mainPolicyMatches` true. Missing, masked, stale or wrong-host
metadata fails closed. Bypassed or disabled-provider sessions should retain their
native route and are excluded from the migrated-session inventory. The checker
selects only that thread's latest `provider.env-resolved` event and whitelisted
nonsecret fields inside SQLite; it never retrieves auth values, request headers,
raw event payloads or conversation events. Output is safe identifiers, event
metadata, booleans and enum TTL policy only. It detects a force-5m conflict for a
requested 1h and main-cache disabling flags.

The native runtime emits this diagnostic after the provider accepts its fresh
start/resume configuration. Source tracing links Claude's merged environment to
SDK session construction and Codex's pooled base to app-server model-provider
configuration. This proves configuration resolution, not actual outgoing markers
or cache serving. BB has no supported CLI to pause between fresh session
construction and its first inference; the check becomes available during that
first authorized turn, before admitting further queued/automatic work. If root
requires verification **before any inference**, activation is blocked on a small
upstream dry-resume/inspect action that constructs the session without submitting
a turn and exposes only route/TTL metadata. Do not claim that pre-inference gate
exists today. No compatibility alias is registered at the reserved builtin HTTP
mount while the builtin is disabled. The public SDK cannot atomically swap both
plugins and every resident process.

A serving experiment is a separate check: observe a one-hour cache write, then
reuse the same prefix after five minutes and before one hour. Static tests and
builds establish neither one-hour serving nor quota/dollar savings.

## Root-owned rollback

After activation, OAuth refresh may rotate credentials. Restore current fork
state to the builtin instead of blindly enabling its old credential copy.
Quiesce affected sessions again, disable the local pool, and keep both disabled:

```sh
# Repeat for every affected idle session, including remote/hidden threads.
bb thread stop THREAD_ID --json
bb plugin disable account-pool-local
bb plugin list --json
python3 /home/exedev/Code/bb-plugins/plugins/account-pool/scripts/copy-pool-state.py \
  --data-dir /home/exedev/.bb \
  --from account-pool-local --to account-pool \
  --backup-dir /home/exedev/.bb/pool-handoffs/W49-rollback \
  --quiescent --replace-target
pool_handoff_since_ms="$(python3 -c 'import time; print(time.time_ns() // 1000000)')"
bb plugin enable account-pool
bb plugin source account-pool --json
bb plugin list --json
bb pool config
bb pool status --json
bb pool account list --json
```

Reverse copy strips the two local config keys so the native strict schema accepts
its config. It preserves fresh account/host credentials, routes, bypasses, quotas
and cursor. Native startup again prunes pins at 30 idle minutes. Stop each idle
runtime as above, then use its next authorized normal turn to resume the same
provider session. Repeat the checker for each host/session using
`--plugin-id account-pool --main-ttl native` and the rollback timestamp. It requires
the builtin route and verifies the local main-TTL contribution is gone; native
automatic TTL is reported as unknown unless an explicit/force environment value
is present. Native settings and subscription eligibility can also affect that
policy, so absence of the fork override does not prove a native five-minute TTL.
The same lack of a pre-inference dry-resume gate applies to rollback. Leave the local fork
disabled with its source/state intact. Backups contain secrets; retain them with
restricted access until root decides retention.

The helper keeps the previous target directory at `backup/target-original` and
its KV rows at `backup/target-kv.json`, plus a source snapshot and source KV rows.
Ordinary exceptions roll back the KV transaction and restore the previous target
when it was moved. Filesystem rename and SQL commit are not crash-atomic together.
If interrupted or the host crashes, keep both pools disabled and inspect those
artifacts before recovery; do not rerun with the same backup path or enable a
pool on an uncertain store. Cross-filesystem backup renames are unsupported and
fail without committing the KV transaction.

## Verification

```sh
npm ci --legacy-peer-deps
npm run typecheck
npx vitest run src/packaging.test.ts src/server.test.ts \
  -t 'packages only|loads handed-off|resolves distinct secret machine|local fork controls|session affinity|fills defaults|reads and updates one full config|applies config threshold changes'
npx vitest run src/request-body.test.ts src/provider-adapter.test.ts src/store.test.ts src/upstream-transport.test.ts
npx vitest run src/json-scan.test.ts src/request-path.test.ts src/ledger.test.ts
npx vitest run app.test.tsx -t 'validates and saves main TTL|edits Advanced config fields'
npx vitest run src/advisor-config.test.ts src/advisor-transport.test.ts \
  src/warming.test.ts src/warming-server.test.ts src/cache-usage.test.ts \
  src/thread-context.test.ts feature-settings.test.tsx
python3 -m unittest discover -s scripts -p 'test_*.py'
npm run build
```

The test fixtures are disposable and contain synthetic credentials only. The
native affinity controls explicitly select 30 minutes, preserving their original
expiry assertions. New fake-clock tests exercise default 60, longer 90, shorter
updates, idle-boundary expiry, independent sessions and inherited pins on reload.
Packaging tests use actual native stores, then load the handed-off data through
the fork's Claude/Codex environment hooks, RPC, CLI and HTTP handlers.

SDK 0.4.87's import scanner mistakes ordinary `"import"` source labels for module
imports. The packaging test parses actual references with TypeScript before
applying the SDK's import policy at their original package-relative paths. No
private imports are exempted. `npm ci --legacy-peer-deps` avoids npm 10's optional
peer-resolution crash; all peers needed by these tests are declared explicitly.
Live activation, resident process propagation and a serving experiment remain
root-owned checks.

## After a BB update

Keep admission controlled until these focused checks pass, on the server build
and any affected host's provider version. These commands inspect metadata or use
synthetic source tests; they do not touch pool data or start a provider:

```sh
bb --version
bb plugin types /home/exedev/Code/bb-plugins/plugins/account-pool --check
cd /home/exedev/Code/bb-plugins/plugins/account-pool
npx vitest run src/packaging.test.ts src/server.test.ts \
  -t 'loads handed-off|resolves distinct secret machine|local fork controls'
npm run typecheck
bb plugin build /home/exedev/Code/bb-plugins/plugins/account-pool
```

Compare `builtWith.bbVersion`, `builtWith.pluginSdkVersion` and `sdkVersion`
in `dist/server.meta.json` and `dist/app.meta.json` to the running BB and its SDK,
rather than assuming the engine enforces an exact pin.
If `types --check` reports a mismatch, stop this procedure and let root review the
SDK update; do not automatically repin dependencies. On the next authorized turn,
repeat the per-host/session checker with a fresh timestamp. Metadata/tests alone
do not prove an updated provider/client still serves one-hour caches.

## Upstream candidates

The two configuration controls could move into BB's builtin Account Pooler,
removing the need for a fork. BB also lacks a supported state-preserving
builtin-to-path replacement and an atomic switch of every resident provider's
environment. A dry-resume/inspect action is also needed if activation must verify
resolved env before any inference. Those are host responsibilities; this fork documents the gap and
uses a distinct identity instead. SDK import auditing would benefit from a
TypeScript parser rather than a regex. Cache warming links threads to Claude
sessions from each thread's latest `thread/identity` event, looked up across
running threads when an unknown session sends a request. A `providerThreadId`
field on the thread DTO, or a thread-to-session lookup, would make that one read;
a waiting-state field (background commands, pending question) on `threads.get`
would spare the list read per refresh; and a native Stop signal on the public
thread record would let a coordinator Stop end warming.
No external issue or comment was filed.
