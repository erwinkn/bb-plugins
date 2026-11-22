# ACP providers (OptChat)

A fork of BB's built-in **ACP providers** plugin (`provider-acp`) that runs every
ACP agent on this repository's [shared ACP bridge](../../lib/acp-bridge/README.md),
which adds OptChat: Chat memory's UniiChat turns (a fresh session per message over
the memory view) on Cursor, OpenCode, omp, Grok, Hermes and custom ACP agents.
Plugin id `provider-acp-local`.

Everything else is the built-in plugin as of `~/Code/bb` `8d6347c0e6`: the same
providers (`acp-cursor`, `acp-opencode`, `acp-omp`, `acp-grok`,
`acp-hermes-agent`), the `Custom agents` setting, capability probing, native skill
roots, and OpenCode Go usage. See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for the
user-facing description.

## Install (replaces the built-in plugin)

The provider ids are the built-in's, so only one of the two may be enabled.
Existing threads keep their provider ids and continue on this plugin.

```sh
# 1. Note the built-in's custom agents, if any, to carry them over.
bb plugin config provider-acp --json | jq -r '.values.customAgents // ""'
# 2. Disable the built-in plugin.
bb plugin disable provider-acp
# 3. Install this one from the main checkout (npm ci also installs lib/acp-bridge).
cd ~/Code/bb-plugins/plugins/provider-acp && npm ci
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/provider-acp --yes
# 4. Put the custom agents back, here.
bb plugin config provider-acp-local set customAgents '<the JSON from step 1>'
```

To go back: `bb plugin disable provider-acp-local`, then `bb plugin enable provider-acp`.

Roll it out (and `provider-antigravity`) before a Chat memory that selects the
turn hook for ACP providers: on the built-in bridge, which does not serve the
hook, BB refuses those threads' UniiChat turns.

## Changes from the built-in plugin

- `src/host.ts` exports the shared bridge and its `probeAcpAgent` instead of the
  SDK's `experimental_acpProviderBridge` and `experimental_probeAcpAgent`.
- `src/plugin-id.ts`: the plugin id, used for icon references
  (`provider-acp-local/cursor`, …) and to list only this plugin's providers in its
  usage source.
- Built against the published SDK 0.6.15: `npm` instead of the BB workspace, no
  `paths` into `packages/`, and a default for usage identity fields that SDK types
  as required.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

One native-roots test (`omp > reads PI_CONFIG_FILES…`) fails, upstream too, when
a `.git` directory sits in a parent of the temp directory (this host has
`/tmp/.git`); run the tests with `TMPDIR` pointing elsewhere.
