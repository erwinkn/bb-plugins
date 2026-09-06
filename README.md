# BB plugins

A private GitHub collection of BB plugins.

`erwin-devin` adds **Devin** as a provider, with a native icon, sign-in
help, executable setting, account usage, and live ACP model catalog. It preserves the provider
ID `acp-devin`. See [Devin provider](plugins/devin/README.md) for configuration,
verification, and migration from a custom ACP entry.

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
