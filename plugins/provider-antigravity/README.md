# Antigravity provider

Run Google's Antigravity CLI (`agy`) as a BB provider (`acp-antigravity`) with
its own icon, Google sign-in from **Settings → Antigravity**, and on-demand
usage limits.

`host.ts` wraps this repository's [shared ACP bridge](../../lib/acp-bridge/README.md)
(BB's ACP bridge plus OptChat) in `src/bridge.ts`, which answers only
`provider/usage`; every other request, the ACP session traffic and the lifecycle
hooks pass through unchanged. In a Chat memory UniiChat scope, each turn runs in
a fresh `agy` session whose system prompt (BB's instructions plus the memory
view) goes through Antigravity's `_meta.antigravity.systemPrompt.append` on
`session/new`; the session it leaves is closed (`session/close`).
`npm ci` here also installs `lib/acp-bridge` (`postinstall`).

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
