# Devin provider

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
`Devin`; the icon does not add permanent text beside an icon-only tab.

The declaration retains the previous generic ACP capabilities, permission modes,
and model catalog scope. The model response supplies precise reasoning options.
Fork, manual compaction, and managed CLI installation are not
advertised. This plugin does not implement or claim those capabilities.

## Account usage

The plugin implements BB's `provider/usage` maintenance request on the execution
machine. The shared BB usage UI can show daily and weekly percentage bars and
reset times. For accounts with an ACU limit, it can also show billing-cycle ACU
usage. It respects Devin's flags that hide daily or weekly quotas.

For each refresh, the handler starts the resolved `devin acp` executable with
an empty private `XDG_CACHE_HOME` and without bb's bridge runtime variables,
sends only ACP `initialize`, and reads the fresh `user_status` protobuf cache
written by that process. Overlapping refreshes share one probe. It then stops the
process and removes the temporary cache. It does not create a session, send a
prompt, copy credentials, or read an old shared cache. Devin handles its own
login, account selection, and request authentication.

Devin's direct account-status requests need additional CLI metadata. Keeping the
request inside Devin avoids copying that private authentication logic. The cache
format is internal and can change; an unsupported format or ambiguous account
cache produces an error rather than a guessed value. This was verified with
Devin CLI 3000.6.14 on macOS. The same XDG layout is used on Linux; Windows has
not been verified.

The probe has a 15-second deadline and a 2 MiB cache limit. It stops its child
process and removes its temporary files on success or failure. Missing executable
and failed probes use BB's standard usage states. Errors contain no native CLI
output, cache contents, or credentials. A failed login is reported as a usage
error with a `devin auth status` hint; the plugin does not infer login state from
terminal text. Absent quotas do not become empty or exhausted bars.

Extra-usage balances are not shown: BB's shared window contract requires a limit
and percentage, and a remaining balance alone does not supply them. ACUs are
not converted into an assumed dollar price.

## Session usage

Devin exposes `/session-stats` (alias `/stats`) through ACP. This is separate from
account quota. The shared SDK bridge handles standard ACP `usage_update` events
as context-window usage. It does not map Devin's custom token, credit, and ACU
metadata into BB's conversation totals. The published ACP bridge has no event
translation hook for a plugin to add that mapping. This plugin keeps the shared
bridge and does not patch its output or scrape the terminal.

See the [Devin command reference](https://docs.devin.ai/cli/reference/commands#session-statistics).

## Verify

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

The tests check provider identity, launch schema, settings validation and
registration, public imports, quota decoding, error states and the sessionless CLI probe, usage
request routing, and the canonical bridge protocol against a local
scripted agent. The bridge test runs in its own process because its stdout
capture must not intercept the Node test runner's binary transport.

`@get-bb/plugin-sdk` is a runtime dependency: bb bundles its public ACP bridge
into `dist/host.js` during Git installation. The host daemon downloads and runs
that artifact. The plugin starts no agent process while importing its code.

The native SVG mark is a vector adaptation of the Devin documentation favicon
used in the earlier local plugin. This is a personal provider integration, not
an official Cognition plugin.

## Model choices

The plugin reads `devin models list --format json`. It groups variants by the
CLI's model family and context size. BB shows the supported effort choices next
to the model. The bridge maps the selection to an exact native variant ID before
it starts or resumes an ACP session or sends a turn. It does not build a model
ID from a guessed suffix. Existing threads with native variant IDs keep those
IDs; the variants remain in the selected-only catalog.

`Devin default` uses the CLI's configured default. The JSON catalog does not
report that setting, so the plugin does not choose a paid model on your behalf.
A catalog lookup runs for at most 15 seconds with a 2 MiB output limit. A failed
lookup produces an error and is not cached.

### Catalog cache

Each bb thread runs its own bridge process, and the model picker runs in a
separate maintenance process. Without a shared cache, every thread start paid
one `devin models list` call (about 0.9 to 1.1 seconds on the verified machine).
The bridge therefore stores the last catalog JSON it received in the plugin's
persistent bridge data directory that bb supplies (`plugins/<id>/bridge-data`
under the bb data directory), in `model-catalog.json`. All bridge processes of
this plugin on the machine share that file; environments do not get separate
copies. Writes go to a temporary file first and are then renamed, so a
concurrent reader never sees a partial file. Each entry carries the start time
of its probe; a writer does not replace an entry from a later-started probe of
the same identity, so concurrent bridges converge on the newest catalog. If the
sign-in or executable changes while a probe runs, that result is discarded and
the lookup runs once more under the current identity.

Rules for a grouped selection (`devin-family:` model IDs):

- A cached catalog younger than one hour resolves the selection directly.
- Between one hour and 24 hours, the cached catalog resolves the selection and
  the bridge refreshes the file in the background. Bridge shutdown aborts that
  refresh; a failed refresh keeps the old file.
- Older, missing, corrupt, oversized, or foreign-identity data blocks for a
  live lookup, which then rewrites the file.
- A group, effort, or Fast combination that the cached catalog does not contain
  blocks for a live lookup. The live catalog decides; a still-missing choice
  fails with the same clear error as before. The cache never selects another
  model or effort.
- Reloading the model list always runs a live lookup and rewrites the file.
- The `Devin default` row and native variant IDs bypass the catalog as before.

The cache entry is bound to an identity fingerprint: a SHA-256 of the resolved
executable's real path, size, and modification time, of a SHA-256 digest of
the Devin credentials file that `devin auth status` reports
(`$XDG_DATA_HOME/devin/credentials.toml`, default `~/.local/share`), and of
`devin.org_id` from `~/.config/devin/config.json`. The credentials file is
hashed in memory only; no credential content, and no digest of the key alone,
is stored or logged. A CLI update, a new sign-in, a sign-out, or an
organization change gives a different fingerprint and the old entry is ignored,
even when the rewritten file keeps its size and timestamps.
When the fingerprint cannot be computed (no credentials file, `WINDSURF_API_KEY`
set in the bridge environment, or an executable that is not found), the bridge
persists nothing and keeps the last catalog in its own process for 60 seconds,
as the previous version did. Windows credential paths are not verified, so
Windows currently gets only that process-local reuse.

Measured on the verified machine with the real CLI, one separate process per
run: a cold selection took 941 to 953 ms and ran one catalog command; with a
cache written by another process it took 6.1 to 6.2 ms and ran none, and
resolved the same native model ID. This removes only the plugin's catalog
step. Starting the `devin acp` session and the model's first response are
unchanged.

BB exposes Fast per provider, not per model. The control can therefore appear
for a model without a Fast variant. A grouped selection with an unavailable
effort or Fast combination fails with a clear message; it does not silently use
another variant. Model descriptions state whether the group has Fast variants.
The native Default row and saved native variant IDs retain native behavior.

Context sizes stay separate. Unknown effort values, such as `Minimal`, stay as
native model rows because BB has no matching effort value. Duplicate or ambiguous
variants also stay visible as native rows. This keeps each native choice available
without mapping it to a different effort. The CLI model JSON and variant labels
are version-dependent; this was verified with CLI 3000.6.14 on macOS.
