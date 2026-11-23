# Antigravity provider

Run Google's Antigravity CLI (`agy`) as a BB provider (`acp-antigravity`) with
its own icon, Google sign-in from **Settings → Antigravity**, and on-demand
usage limits.

`host.ts` wraps this repository's [shared ACP bridge](../../lib/acp-bridge/README.md)
(BB's ACP bridge plus OptChat) in `src/bridge.ts`, which answers only
`provider/usage`; every other request, the ACP session traffic and the lifecycle
hooks pass through unchanged. Antigravity is excluded from Chat memory's
UniiChat (OptChat): a fresh `agy` session starts with an empty prompt cache
(51k-65k uncached tokens a turn, measured on agy 1.5.14), so its threads keep
one persistent multi-turn session, which reuses the cache, while still logging
to the shared memory and getting `memory_read` / `memory_zoom`. The bridge's
OptChat path (a fresh session per turn, system prompt through
`_meta.antigravity.systemPrompt.append` on `session/new`, the old session
closed with `session/close`) stays available for other uses but chat-memory no
longer asks for it.
`npm ci` here also installs `lib/acp-bridge` (`postinstall`).

When `agy` ends its turn while a command, a subagent or a timer it started still runs, the bridge
keeps the BB turn open until that work reports and `agy` finishes, instead of leaving the thread
idle while `agy` works on unseen; see
[Antigravity background work](../../lib/acp-bridge/README.md#antigravity-background-work).

## Install / Switch from W628 custom agent

Remove the W628 `antigravity` custom agent entry from the ACP providers plugin
(`provider-acp`, or `provider-acp-local` once it replaces it) first so
the `acp-antigravity` provider ID does not collide, then install this plugin:

```sh
agents=$(bb plugin config provider-acp --json \
  | jq -c '.values.customAgents // "" | if . == "" then [] else fromjson end | map(select(.id != "antigravity"))')
bb plugin config provider-acp set customAgents "$agents"
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/provider-antigravity --yes
```

Existing threads on `acp-antigravity` continue working without changes.

## Notes

- **Usage limits:** the bridge answers `provider/usage` from
  `agy -p /usage --output-format json` (3-minute in-memory cache, one probe at a
  time), so `bb.sdk.system.usageLimits` and the Provider usage plugin list
  Antigravity next to Claude Code and Codex. **Settings → Antigravity** shows the
  same numbers through a cached server RPC.
- **Sign-in:** Spawns `agy acp --login` with `AGY_ACP_FORCE_FILE_STORAGE=1`
  (one process at a time, 5-minute timeout), shows the Google OAuth link, writes
  the pasted code to stdin, and cleans up on completion, cancel, or dispose.
