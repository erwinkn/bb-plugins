Keep a Claude Code or Codex thread running when one account hits its limit. The Account Pooler puts every account you own behind a local hub and picks the account for each request.

## What you get

- A pool of Claude and Codex accounts, added by importing the login already on the machine, signing in through the browser, or pasting an Anthropic API key.
- Accounts run one after another in priority order, with ties following the order added. New conversations stay on the current fallback even when an earlier account recovers. Existing conversations keep their own account until it becomes unavailable.
- Drag handles set the account order within each provider in settings (keyboard: Space to pick up, arrow keys to move, Space to drop, Escape to cancel), with the same operation available through `bb pool-local account reorder <claude|codex> <id>...`.
- Live limit windows per account and model family in the plugin's settings page, and the same numbers from `bb pool-local status`.
- A routing switch per provider and a bypass per thread, so one thread can go straight to its own credentials.

## How it works

The hub runs inside BB and serves an Anthropic Messages endpoint and an OpenAI Responses endpoint. With routing on, BB hands the Claude Code or Codex process a base URL that points at the hub and a token scoped to that machine, and the provider reports **Proxied** in its health row. An account is skipped for a request when it is at or above the switch threshold or in error. The threshold defaults to 98 percent of a window. Account secrets stay in the BB data directory on the server machine, and the hub refreshes them in the background.

The pool waits once on the same account for short temporary rate limits. Longer holds return Retry-After for pinned conversations while new conversations can advance. A model-family limit detours requests for that family without moving the session’s main pin or the provider cursor. The pool commits a new account after a successful response; a failed attempt across every account retains the previous binding. The current account and session pins survive hub restarts. Session pins expire after a configurable idle period, 60 minutes by default, with the 4,096 most recently used pins retained.

The pooler owns its upstream HTTP connections and uses HTTP/1.1, so a broken HTTP/2 session in the server's shared fetch dispatcher does not strand pooled requests. The transport honors standard proxy environment variables and is disposed on plugin unload. This does not add request replay; existing account-fallback rules still apply. Pooled request connection failures log a known error code when available, without request bodies, credentials, URLs, or raw exception messages.

## Requirements

Accounts you own and are permitted to use this way.

This plugin is experimental. Routing behavior, stored data, and the CLI can change between releases.

## For agents

`bb pool-local account add|list|remove|enable|disable|priority|reorder`, `bb pool-local status`, `bb pool-local routing <claude|codex> [--off]`, `bb pool-local config`, `bb pool-local config set`, `bb pool-local token rotate`, and `bb pool-local bypass <thread-id>`. `list` and `status` take `--json`.

The local fork requests `1h` for Claude main conversations by default through
`CLAUDE_CODE_PROMPT_CACHE_TTL`. Main TTL accepts `5m` or `1h`; affinity accepts
whole idle minutes from 1 to 43200. The controls live in Advanced settings and
`bb pool-local config`. Subagents and background helpers retain their separate
TTL controls. Inline auto-mode classifier and memory-relevance helpers follow
main TTL.
`FORCE_PROMPT_CACHING_5M=1` takes precedence. Only one pool may be enabled.
Root owns the data handoff and rollback documented in README.md.
