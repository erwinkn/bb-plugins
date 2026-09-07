# BB plugins

A private GitHub collection of BB plugins.

`erwin-activity` adds a status-first thread list: Needs Attention, Unread,
Working, Draft, and Done. It also supports project grouping. See
[Threads](plugins/activity/README.md) for local installation and draft limits.

`erwin-devin` adds **Devin** as a provider, with a native icon, sign-in
help, executable setting, account usage, and live ACP model catalog. It preserves the provider
ID `acp-devin`. See [Devin provider](plugins/devin/README.md) for configuration,
verification, and migration from a custom ACP entry.

`voice-mode` adds real-time voice calls, session history, and spoken thread
updates. See [Voice Mode](plugins/voice-mode/README.md).

`erwin-provider-usage` supplies the compact usage popup. See [Provider usage
compact](plugins/provider-usage/README.md) for installation and rollback.

## Install

Use BB 0.42.1 or later. The bb server needs Git, npm, and GitHub access to this
private repository. Configure Git authentication on that machine; do not put a
token in the repository URL.

Replace `COMMIT_SHA` with the full reviewed commit SHA:

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@COMMIT_SHA --plugin erwin-devin
```

Follow the migration steps first if a custom ACP entry already owns
`acp-devin`. The collection index is `.bb/plugins.json`; the package lives in
`plugins/devin`. Git installation builds source on the bb server. Generated
bundles are not committed.

## Develop

Use the local BB CLI, Node.js 22 or later, and npm:

```sh
cd plugins/devin
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

The earlier Hello proof plugin and general branding experiment have been
removed from the current collection. Their prior commits and release tags stay
in Git history.

## Desired upstream changes

### Usage popup: compact header and visible provider tabs

The original popup belongs to BB's built-in `provider-usage` plugin. This
collection now provides `erwin-provider-usage` as a local replacement through
BB's footer API. The same layout changes can still go upstream in BB's
`plugins/provider-usage` source.

The original built-in frontend has an `overflow-x-auto` provider tab list. Each tab is
`h-10 w-8`, while the machine selector and action buttons are `h-7` or `size-7`.
The machine selector shows a name up to `max-w-32` wide. This leaves too little
room for the tabs. The extra bar below the active-tab underline is the horizontal
scrollbar. Devin is the fourth provider, after Codex, Claude Code, and Cursor,
and is hidden in that overflow in the reported screenshot.

Requested changes:

- Replace the machine-name trigger with a machine icon. Keep the current machine
  name in a tooltip and accessible label, and keep full names and connection
  states in the selection menu.
- Align provider tabs, machine selection, and refresh on one row with consistent
  control heights, icon alignment, and spacing. Keep one clear active-tab marker.
- Fit all four current provider tabs at the reported popup width without a
  horizontal scrollbar. At narrower widths or with more providers, keep every
  provider reachable through an explicit overflow control or another accessible
  layout. Do not just hide the scrollbar and leave tabs clipped.
- Remove the `Collapse provider usage` button. Verify that clicking outside and
  pressing Escape dismiss the popup, and that the machine menu remains usable.
- Keep provider discovery based on `capability: "usage"`; do not hard-code a
  provider list or add a separate Devin usage request.

Verified on 2026-09-06 against the running app: `bb provider list` reports
`acp-devin`, owned by `erwin-devin`, with `maintenance.usage: true`. A forced
`provider-usage` `getUsage` RPC for the connected machine returned all four
providers and valid Devin usage with `status: "ok"`, a plan label, and a weekly
window. The backend already loads usage-capable providers through
`bb.sdk.providers.list` and `bb.sdk.system.usageLimits`. The frontend renders
that list without a provider allowlist. Devin needs a layout fix, not another
provider implementation.

Acceptance checks: long machine names, all four current providers, additional
providers, narrow popup widths, keyboard tab selection, machine switching,
refresh, outside-click dismissal, Escape, and visible focus indicators. Verify
that Devin's existing usage window renders when its tab is selected.

Status: implemented in [Provider usage compact](plugins/provider-usage/README.md).
No upstream issue filed. The built-in plugin can be enabled again to roll back.
Live checking also found that BB handles Escape but does not handle outside
clicks for footer disclosures. Our plugin adds a scoped listener for that action;
the same behavior should be added to the upstream footer.
Suggested issue title: `Usage popup: compact machine selector, align controls, and expose overflowing provider tabs`.
File the request in [BB issues](https://github.com/get-bb/bb/issues), with the
reported screenshot and the evidence above.

### Hide unused providers from selection menus

Add a per-provider visibility setting to BB's provider and model selection menus.
Users should be able to hide providers such as Pi or Hermes without disabling
other providers or preventing existing threads from using them.

Verified on 2026-09-06: Pi has its own `provider-pi` plugin and can be disabled
separately. Hermes is `acp-hermes-agent`, registered by `provider-acp` alongside
Cursor, Grok Build, and OpenCode. The installed ACP plugin exposes `customAgents`
but no per-provider disable setting. BB's general settings expose provider order
and a default provider, but no visibility list.

This belongs in BB's core provider selection settings. Hiding a provider should
remove it from new selections while preserving existing threads and its stored
configuration. Keep visibility distinct from provider registration and plugin
activation.

Status: Pi disabled locally at the user's request; Hermes remains available.
No upstream issue filed.
Suggested issue title: `Allow hiding individual providers from selection menus`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Mobile: choose Steer or Queue from the Send button

When Steer is the default send action, desktop users can press Command+Enter
to queue a message. Mobile users need a touch control for the same choice.

Allow a long press on Send to open a menu with **Steer now** and **Queue next**.
A normal tap should keep the configured default. Opening or dismissing the
menu must not send the message. A visible menu arrow could also expose the choice.

This belongs in BB's core composer. Both actions already exist, but the plugin
API has no dedicated way to change the built-in Send button's behavior.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Mobile: long-press Send to choose Steer or Queue`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Dictation: choose Stop and insert or Stop and send

Currently, stopping dictation inserts the transcript into the message draft.
Sending requires waiting for transcription to finish, then pressing Send.

Provide two actions while recording:

- Secondary: **Stop and insert** transcribes into the draft for review.
- Primary: **Stop and send** transcribes, then sends the completed draft with
  its attachments automatically, without a second click.

Show transcription progress and allow cancellation. Send only after successful
transcription; a cancelled or failed transcription must not send the message.

This belongs in BB's core composer. The plugin API does not expose recording
controls or transcription completion, and its composer submission API supports
scheduled sending only.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Add Stop and send to voice dictation`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Plugin interactions: expose the pending row id

Voice Mode asks questions through `bb.ui.requestInput`. In SDK 0.4.47 this
returns the answer promise but does not expose the pending interaction id.
The plugin currently looks up its own payload with `threads.interactions.list`.
An API that exposes the id before the answer arrives would remove that lookup.

Correction to the earlier note: the SDK does expose `threads.interactions.respond`
and `threads.interactions.resolve`. We have not established which plugin-owned
and native interaction kinds accept these calls in the live runtime. The current
spoken-answer path resolves the plugin waiter and cancels the native row; that
workaround is an implementation choice, not proof that BB has no response API.
Validate those existing methods before requesting an additional answer API.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Plugin interactions: expose the pending requestInput row id`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Quiet handling of plugin-owned background messages

Voice Mode coalesces watched-thread events in its own inbox. Native messages
sent to its hidden thread still pass through BB dispatch. SDK 0.4.47 exposes
`message.dispatch` with proceed, wait, and reject decisions. Waiting creates a
queued row; rejection shows its message to the user. The SDK explicitly has
no handled-by-plugin decision and no message amendment.

A scoped consume-and-coalesce option for plugin-owned background messages
would let Voice retain material results without a new agent turn, a pending
queue row, or a visible rejection. It must preserve direct user messages and
explicit Send-now actions. This is a proposed BB capability; Voice does not
currently intercept native messages.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Allow quiet coalescing of plugin-owned background messages`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Native UI command results for plugins

Voice Mode now uses local SDK navigation, composer bindings, and file previews.
In SDK 0.4.47, `toThread`, `toProject`, and sidebar `open` return no result.
Sidebar `open` ignores unknown IDs and may fall back from a split to ordinary
navigation. File preview returns an acceptance boolean, not rendering status.
It also depends on the calling surface: BB 0.42.1 gives the app overlay a
default handler that returns false, while page-level surfaces supply a preview
handler. Voice binds the active page capability instead.
Voice can observe route and composer state, but cannot derive every native
placement or preview outcome from these return values.

A request-scoped result from native UI methods could report the resolved target,
actual placement, and an unavailable or cancelled outcome. File preview could
separately report accepted and loaded. This would remove plugin-specific waits
and avoid claims based only on dispatch. It should remain local to the calling
client and preserve BB's native permission and navigation rules.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Return scoped outcomes from native plugin UI actions`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

## Upstream issues

Problems found while building these plugins whose fix belongs outside this
repository. Each entry records the evidence so it can be filed or re-verified
later. Remove an entry when the upstream fix ships.

### bb SDK answers `fs/write_text_file` with `result: null`

- **Where:** `@get-bb/plugin-sdk` 0.4.47, `provider-bridge-acp`,
  `handleFsWriteTextFile` calls `responder.result(null)` after a successful
  write. bb 0.42.1.
- **Symptom:** in Devin threads (CLI 3000.6.14), every `write` and `edit` tool
  result reads `Failed to write file '<path>': Parse error`, although the file
  is written with the full intended content. `read` results are unaffected.
- **Cause:** the ACP schema (`schema.json` v1.21.0) defines
  `WriteTextFileResponse` as `type: object` with one optional `_meta`
  property; `null` is not allowed. Devin's Rust ACP decoder (public
  `agent-client-protocol` `util.rs`, `json_cast`) maps a typed decode failure
  to `Error::parse_error()`, JSON-RPC `-32700` "Parse error". The message is
  produced locally in the agent; no `-32700` error appears on the wire. The
  ACP prose page "File System" shows `"result": null` in its example, which
  contradicts the schema and is the likely origin of the SDK behavior.
- **Fix:** in the SDK, return `{}` (`responder.result({})`). A strict local
  test failed with `null` and passed with `{}`. The plugin cannot work around
  this: its wrappers see only runtime-to-bridge lines, and the SDK's `fs`
  client capabilities are fixed to `true`. Optionally report the docs example
  to the ACP project.
- **Status:** not filed yet. Direct confirmation against a real Devin turn is
  still open; the reproduction used the SDK bridge with a scripted ACP peer.
