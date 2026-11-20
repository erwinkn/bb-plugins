# Antigravity provider

Run Google's Antigravity CLI (`agy`) as a BB provider (`acp-antigravity`) with
its own icon, Google sign-in from **Settings → Antigravity**, and on-demand
usage limits.

`host.ts` re-exports BB's published ACP bridge (`experimental_acpProviderBridge`)
as is—no bridge wrapper or protocol interception.

## Install / Switch from W628 custom agent

Remove the W628 `antigravity` custom agent entry from `provider-acp` first so
the `acp-antigravity` provider ID does not collide, then install this plugin:

```sh
agents=$(bb plugin config provider-acp --json \
  | jq -c '.values.customAgents // "" | if . == "" then [] else fromjson end | map(select(.id != "antigravity"))')
bb plugin config provider-acp set customAgents "$agents"
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/provider-antigravity --yes
```

Existing threads on `acp-antigravity` continue working without changes.

## Notes

- **Usage limits:** BB's global usage popup reads `provider/usage` only from
  inside a provider bridge. To keep the bridge unwrapped and simple, usage is
  served by a cached server RPC (`agy -p /usage --output-format json`, 3-minute
  in-memory cache) and displayed in **Settings → Antigravity**.
- **Sign-in:** Spawns `agy acp --login` with `AGY_ACP_FORCE_FILE_STORAGE=1`
  (one process at a time, 5-minute timeout), shows the Google OAuth link, writes
  the pasted code to stdin, and cleans up on completion, cancel, or dispose.
