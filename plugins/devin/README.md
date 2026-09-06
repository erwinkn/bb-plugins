# Devin CLI provider

Run Devin CLI as a bb provider through the public ACP bridge. The plugin owns
the `acp-devin` provider ID, native icon, display name, sign-in help, and executable
setting. Models come from the installed Devin CLI account. No model IDs or
credentials are stored in this repository.

Install Devin CLI and sign in on each machine that will run it:

```sh
devin auth login
```

See the [official Devin CLI documentation](https://docs.devin.ai/work-with-devin/devin-cli).
The default launch is `devin acp`. If needed, set an absolute executable path:

```sh
bb plugin config erwin-devin set command /absolute/path/to/devin
```

The executable must exist on the execution machine. The setting is shared across
hosts; use `devin` on PATH when hosts use different installation paths. Changing
it re-registers the provider for future operations. Sign-in state stays with Devin.

## Migrate a custom ACP entry

Only one plugin can own `acp-devin`. Complete the build and tests before changing
the live registration. Keep the old custom entry in a private local backup; it
may contain machine paths or credentials and must not be committed.

1. Check current and archived threads for provider ID `acp-devin`. Let active
   work finish before switching. Keep the same provider ID and model IDs.
2. Save the existing `provider-acp` customAgents setting privately. Remove only
   the entry whose slug is `devin` through the supported plugin settings API.
   Preserve all other custom agents. Do not disable the entire ACP plugin.
3. Install `erwin-devin` and set its command to the previous executable path.
   The current plugin supports the normal `acp` argument and inherited process
   environment. If the old entry has custom arguments, env, cwd, or dialect
   options, adapt and test those requirements before removing it.
4. Verify `bb provider list` reports `acp-devin` owned by `erwin-devin`, then
   inspect `bb provider models acp-devin` and run a small test conversation.
5. Disable the earlier `erwin-provider-branding` and `devin-branding` icon
   plugins after the native provider works. Keep their source/settings for rollback.

If installation or model discovery fails, disable `erwin-devin` and restore only
the original Devin custom entry. Do not overwrite other agents added meanwhile.
No automatic installation hook edits another plugin's settings.

The same provider ID preserves saved references without database edits. Existing
session continuation still depends on Devin's ACP session support. The migration
performed for this PR found no current or archived Devin threads to rewrite.
The conformance test verifies bridge start, turn, release, and resume against a
scripted ACP peer; it does not prove a real old Devin session can be resumed.

## UI and capability limits

The native icon is declared on the provider, so bb can serve it before any
frontend plugin loads. There is no separate app bundle or DOM modification.
bb controls compact picker tabs and model/header text. The provider name is
`Devin CLI`; the icon does not add permanent text beside an icon-only tab.

The declaration retains the previous generic ACP capabilities, permission modes,
and model catalog scope. The model response supplies precise reasoning options.
Fork, manual compaction, usage reporting, and managed CLI installation are not
advertised. This plugin does not implement or claim those capabilities.

## Verify

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

The tests check provider identity, launch schema, settings validation and
registration, public imports, and the canonical bridge protocol against a local
scripted agent. The bridge test runs in its own process because its stdout
capture must not intercept the Node test runner's binary transport.

`@get-bb/plugin-sdk` is a runtime dependency: bb bundles its public ACP bridge
into `dist/host.js` during Git installation. The host daemon downloads and runs
that artifact. The plugin starts no agent process while importing its code.

The native SVG mark is a vector adaptation of the Devin documentation favicon
used in the earlier local plugin. This is a personal provider integration, not
an official Cognition plugin.
