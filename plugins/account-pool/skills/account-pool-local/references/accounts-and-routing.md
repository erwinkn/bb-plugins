The local Account Pooler uses a separate plugin identity. Root must complete
the state handoff before activation. The following commands manage its accounts
and routing after activation; inspect status before any change:

```sh
bb plugin enable account-pool-local
bb pool-local account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool-local account login-complete --session <id> --code-stdin
bb pool-local account add --provider codex --login
bb pool-local account login-poll --session <id>
bb pool-local account add --provider claude --import
bb pool-local account add --provider codex --import
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool-local account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb pool-local account add --provider claude --api-key <key> [--label <text>] [--priority <n>]
bb pool-local account list [--json]
bb pool-local account remove <id>
bb pool-local account enable <id>
bb pool-local account disable <id>
bb pool-local account priority <id> <n>
bb pool-local account reorder <claude|codex> <id>...
bb pool-local account refresh <id>
bb pool-local account reset <id> <fable|full|weekly|session>
bb pool-local account reset-auto <id> <grant-id> [--off]
bb pool-local status [--json]
bb pool-local routing <claude|codex> [--off]
bb pool-local config
bb pool-local config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold|claudeMainCacheTtl|sessionAffinityIdleMinutes> <value>
bb pool-local token rotate --machine <id-or-name>
bb pool-local bypass <thread-id> [--off]
```

Claude `--login` starts a PKCE session, prints a browser URL and session ID,
then exits. Pipe the manual callback code to `account login-complete` with that
session ID within ten minutes. Codex `--login` prints a device verification
URL, one-time code, session ID, and an `account login-poll` command that waits
for authorization. The Claude code stays out of process arguments, and either
browser may be on a different machine from the bb server. Newly added or
enabled accounts are available without a plugin reload. With an
enabled account whose secret file remains readable and valid, matching Claude
Code or Codex sessions receive the pool route and a distinct secret token for
their machine.
Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; bb applies them as in-memory app-server config.
Codex image generation and editing use the same authenticated pool route.
Tokens are never printed. `status` prunes tokens for unenrolled machines and
shows token timestamps plus recently routed threads whose machines need a
local Claude login before the pool can be disabled safely. Rotation keeps the
prior token valid for ten minutes. Agents should pipe API keys to
`--api-key-stdin`;
`--api-key <key>` is an unsafe compatibility form that exposes the key in
process arguments, shell history, and agent transcripts. Prefer `--import` for
an existing Claude Code login. The CLI Codex import path reads
`~/.codex/auth.json` on the bb server host. OAuth quota refreshes on add or
enable and every five minutes while an account is idle. Use
`bb pool-local account refresh <id>` to request an immediate refresh for one account.
Account tables add columns for observed model-family buckets; JSON status
exposes their utilization, reset, status, observation time, and source under
`familyWeekly`. Selection skips an account whose requested family is spent
while retaining it for other families. A present `metadata.user_id` account
UUID is aligned with the selected OAuth account. Use `bb pool-local config` to
inspect the full routing configuration and
`bb pool-local config set <key> <value>` to update one value. The upstream URL keys
are QA-only overrides; `switchThreshold` must be greater than 0 and at most 1.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. Claude accounts are gated on their 7-day and
per-family weekly windows only: the Pooler no longer tracks Claude's 5-hour
window, and a missing one never makes an account unknown or ineligible. A 429
carrying Anthropic's overall rejection (Claude's 5-hour window while Anthropic
still enforces it, say), on native, advisor or warming traffic, takes the whole
account out of rotation until the later of the reset Anthropic names and
Retry-After; native requests and their sessions move to the next eligible
account. A 429 only a weekly window rejects stays with that window. Codex keeps its 5-hour and weekly windows. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after the configured idle period, 60 minutes by default,
and the pool retains the 4,096 most recently used pins.

## Usage resets

Each Claude usage read also lists the account's usage-reset grants (the program
behind Claude Code's `/limit-reset`): kind (`fable`, `full`, `weekly`,
`session`), resets left, and whether a claim would be accepted now or why not
(`blocked by five_hour`, `paused`, `none left`). `bb pool-local account list`
shows them in its Resets column, and JSON status under `resets`. An account
whose program read is refused shows `ineligible (<reason>)`; `cli_version`
there means the pinned CLI user agent in `src/usage-resets.ts` needs a bump.

`bb pool-local account reset <id> <kind>` spends one reset: it reads the
account's grants afresh, claims the first usable grant of that kind, then reads
usage again so the holds it lifted release. It refuses, sending nothing, when
no grant of that kind is usable, and says why. An ambiguous answer (a 5xx, a
lost connection) leaves the claim unsettled; claiming again resends it with the
same request id, so the reset is spent at most once. Never run it unless the
user asks.

`bb pool-local account reset-auto <id> <grant-id>` flags one grant for
automatic use (`--off` clears the flag; status marks it `auto`). The Pooler
spends a flagged grant itself only when no Claude account can serve any model,
none frees up on its own within an hour, no claim sent in the last 10 minutes is unsettled, and a fresh read
shows the grant usable and blocked by nothing; once per wall, until an account
serves again. Its decisions are lines in `bb plugin logs account-pool-local`.
Nothing is spent automatically without a flag.

Fable requests prefer one account while it can serve them: among accounts
holding a Fable reset with resets left, the one whose Fable limit is the most
used, so that reset gives back the most when spent. The detour never moves a
session's pin or the provider cursor; with no such account, selection is
unchanged.

Drag an account’s handle in Account Pooler settings (or focus the handle and use
Space, arrow keys, and Space again), or
`bb pool-local account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `bb pool-local account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.
