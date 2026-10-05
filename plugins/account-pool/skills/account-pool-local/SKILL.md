---
name: account-pool-local
description: "Configure or diagnose Account Pooler accounts, authentication, quota routing, and failover through bb pool-local."
---

# Account Pooler (fork)

Use `bb pool-local` for this plugin's accounts and routes. Inspect current state with
`bb pool-local status --json` and `bb pool-local account list --json` before changing routing.
Use `bb pool-local --help` for available commands.

For account login/import, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or supported login/import flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.

This fork's two independent controls are `claudeMainCacheTtl` (`5m` or `1h`,
default `1h`) and `sessionAffinityIdleMinutes` (whole minutes 1–43200, default
60). Read or change them through `bb pool-local config` and
`bb pool-local config set <key> <value>`, or the Advanced controls in the plugin UI.
Main TTL sets `CLAUDE_CODE_PROMPT_CACHE_TTL` only for routed Claude sessions.
It leaves subagent/background-helper TTL and force flags alone. Inline helpers
(auto-mode classifier and memory-relevance) follow main TTL. `FORCE_PROMPT_CACHING_5M=1` wins over
this main TTL. Never assume a request used one hour merely from the setting.
The builtin pool must stay disabled while the local pool is enabled. Root owns
the state handoff; see this plugin's README for cutover and rollback.

Advisor routes and cache warming are opt-in and off by default. Inspect them with
`bb pool-local advisor`, `bb pool-local warming` and `bb pool-local warming status`;
change them only when the task asks for it. Warming never changes `claudeMainCacheTtl`,
accounts or routing, and its status reports requests and tokens, not costs.

To judge whether warming pays for itself, read `bb pool-local usage report [--since 7d] [--json]`:
requests, cache hit ratio, cold starts, refresh cost, rewrites avoided and quota burn per account,
by day and by settings period. It is read-only; `bb pool-local usage retention <days>` changes
how long the ledger keeps rows.
