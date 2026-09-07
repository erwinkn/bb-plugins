# BB plugins

A private GitHub collection of BB plugins.

`erwin-activity` adds a status-first thread list: Needs Attention, Unread,
Working, Draft, and Done. It also supports project grouping. See
[Threads](plugins/activity/README.md) for local installation and draft limits.

`erwin-editor` adds a Monaco file editor: a Files panel with a file tree,
BB-matched syntax colors, a code theme picker, and TypeScript, JSON, CSS,
and HTML language services. See [Editor](plugins/editor/README.md).

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

### Develop locally, then verify the Git branch

Normal installations track Git `main`. A commit SHA, as shown above, can still
be used when a fixed version is needed.

1. Create or reuse a feature branch. Fetch `origin` and rebase it onto
   `origin/main`, preserving other work and resolving conflicts.
2. Install the affected plugin from the local worktree for development, subject
   to the data-preservation rules below. Use `bb plugin dev <plugin-path>` to
   watch files, rebuild, and reload. Run relevant checks and test in BB while
   editing. Keep the worktree available until the plugin uses another source.
3. Build the affected plugin, commit, push the branch to `origin`, and open a
   **draft PR** against `main`. Switch only that plugin to the Git branch.
   Keep its plugin ID and collection entry unchanged. Preserve settings,
   secrets, schedules, and data.
4. Confirm the installed source and resolved commit. Test the changed behavior
   in BB, including desktop and mobile when the UI changes. Record the tested
   commit, checks, and live evidence in the PR.
5. Fix failures, push, and update the branch installation. Verify the new
   resolved commit and repeat the affected tests before proceeding.
6. Mark the draft PR ready for review. Monitor checks and review comments,
   address valid findings, and push fixes. Update the installed plugin and
   repeat affected checks after each fix. Continue until required checks pass
   and review findings are resolved on the latest commit. No comments yet is
   not proof of a completed review; report unavailable or pending reviews.
7. Give the user the ready PR and leave the tested branch installed. The user
   decides when to merge. Do not merge or enable auto-merge.
8. After the user merges, confirm the merge on GitHub, switch the plugin back
   to `main`, and update it. Confirm the resolved commit includes the merge
   and verify that the plugin works without errors. A squash merge has a new
   commit, so the branch SHA is not the final verification target.

Local development avoids a commit and push for each test. The Git installation
check then verifies the version that reviewers and users can install. For a
plugin that is not installed yet, the local commands are:

```sh
bb plugin install path:/absolute/worktree/plugins/PLUGIN --yes
bb plugin dev /absolute/worktree/plugins/PLUGIN
```

Check the installed source before using these commands for an existing plugin.
Local development does not bypass data-preservation rules. If a safe source
switch is unavailable, use the Git-branch workflow for that installation.
Coordinate before replacing an installation another thread is testing.

If the change is abandoned, restore `main`. Switch away from the local source
before deleting its worktree. Testing in the normal BB instance affects the
plugin used for daily work until it returns to `main`.

Use `bb plugin source <id> --json` to inspect the installed source and
`bb plugin update <id>` to fetch updates from its current ref. Updating alone
does not switch the ref back to `main`. Check the current CLI help when changing
refs. Preserve settings and data; `bb plugin remove` deletes plugin settings,
secrets, and schedules and is not a general ref-switch command.

BB 0.42.1 has no in-place Git-ref switch in its CLI or plugin API. Installing
the same plugin ID from a different ref is refused. For a plugin with no
server-side settings, secrets, schedules, or stored data, a remove/install
cycle can be used after verifying those stores are empty. Preserve the plugin
ID and browser storage; never clear client preferences. Check the resulting
source and enabled state. Record the previous source so installation failure
can be rolled back. Do not apply this exception to a plugin with data.

For example, after confirming that `erwin-activity` has no server-side data:

```sh
bb plugin source erwin-activity --json
bb plugin remove erwin-activity
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@BRANCH --plugin erwin-activity --yes
bb plugin source erwin-activity --json
```

After a new push, use `bb plugin update erwin-activity --yes`. After the user
merges, repeat the verified source-switch procedure with `@main`, then check
the resolved commit and the plugin behavior. Recheck the data stores before
each remove/install cycle; a later plugin version may start storing data.


## Desired upstream changes

### Recursive thread archiving

BB's native archive action archives a thread and its direct children, but not
all descendants. Make this recursive across sidebar actions, other menus, and
keyboard shortcuts. The Threads plugin currently collects the descendant tree
and archives deepest first through public SDK calls. A server-owned operation
should handle concurrent child creation and reparenting consistently, preserve
BB's lifecycle cleanup, and report partial failures.

### Share individual threads with guests

Add sharing for individual BB threads, with read-only access as the first
priority. Recipients should be able to open a shared conversation in a browser
without access to other threads, projects, files, or instance settings.

Let the owner preview the shared content, choose whether future messages are
included, and revoke access. Tool output and attachments should require explicit
selection before sharing.

As a later extension, allow guests to log in and send messages to threads for
which the owner grants permission. Identify each sender and keep agent approval
decisions with the owner. Sending messages can trigger agent actions in the
owner's environment, so read and send permissions must be separate and enforced
by the server.

This belongs upstream in BB's authentication, thread permissions, and Connect
support. Verified against BB 0.42.1: `bb connect` describes shared ports as
owner-session-only. The [BB configuration documentation](https://github.com/get-bb/bb/blob/main/docs/configuration.md)
also requires the owner's account session; these URLs are not guest links.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Thread-scoped guest sharing with read-only links and optional messaging`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Favorite models across providers in one selector tab

Add a Favorites tab to the model selector. Users should be able to star models
from different providers and select them from one list without changing provider
tabs first.

Requested behavior:

- Add a star control to each model row. Store favorites by provider ID and model
  ID, since the same model can be available through more than one provider.
- Show saved models together in a Favorites tab, with each model's provider
  name or icon. Selecting a favorite must select both its provider and model.
- Save favorites between sessions and remember the selected tab. Keep reasoning
  level and service tier valid for the selected model.
- Keep unavailable favorites visible with a clear reason and an unstar action.
  Do not silently select a different provider or model.
- Support keyboard navigation and mobile touch controls in both new-thread and
  existing-thread selectors.

Verified on 2026-09-07 against installed BB 0.42.1. The bundled SDK's
`packages/plugin-sdk/src/app-contract.ts` exposes
`experimental_ProviderModelPicker` with a controlled selection, routing,
`allowProviderChange`, alignment, disabled state, and class name. It exposes no
custom tab or favorites option. The frontend registration contract has no
model-selector replacement slot. The installed picker renders provider tabs
and the selected provider's model options.

This belongs in BB's shared model picker and preference storage. A plugin can
render its own picker or modify the DOM through a trusted content script, but
adding a tab to the built-in selector would depend on internal UI details.
If BB wants plugins to supply these lists, add a model-picker tab API that
passes provider/model selections through the host's normal selection logic.

Status: recorded here; no upstream issue filed and no plugin installed.
Suggested issue title: `Add a Favorites tab for models across providers`.
File the request in [BB issues](https://github.com/get-bb/bb/issues), with the
requested behavior above. Check new and existing threads, duplicate model names
across providers, unavailable models, persisted preferences, keyboard use, and
mobile layout.

### Name continuation threads after the issue or feature

Continuing from another thread should produce a task name, not a title such as
`Continue from @thread:thr_esipgqyceh`.

Verified on 2026-09-07 against installed BB 0.42.1. In
`src/services/threads/title-generation.ts`, `shouldGenerateThreadTitle` requires
at least five words. `Continue from @thread:...` has three words, so metadata
generation returns `too-short`. The fallback copies up to 80 characters from
the prompt. Even when generation runs, its input is that shortened prompt,
without resolving the source thread's task. The live continuation
`thr_eqch4zryft` has no generated title and displays its raw continuation
prompt, although its source thread is named `Edit files in sidebar`.

Requested behavior:

- Resolve continuation references before generating the title. Use the source
  task context and the new instructions to name the issue or feature.
- For a continuation with no new task instructions, use the source thread's
  meaningful title as the fallback. Do not apply the five-word threshold to
  this case or expose a raw thread ID as the task name.
- If the new instructions change the task, generate a title for that task
  instead of copying the old title. Preserve names explicitly set by the user.
- Handle unavailable source threads without failing thread creation. Keep the
  fallback useful, and avoid copying another unresolved continuation prompt.

This belongs in BB's thread metadata generation, which also supplies branch
names. The Threads plugin displays BB's stored title and fallback. A sidebar
label override would leave other BB views with the unclear name. The public
SDK has a rename action but no dedicated title-generation hook.

Status: recorded here; no upstream issue filed. Manual sidebar renaming is
available through PR #11, but does not correct automatic naming.
Suggested issue title: `Name continuation threads from the referenced task context`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Change an installed plugin's Git ref without removing its data

Add a source-change operation to BB's CLI and plugin API. It should support
switching between Git and local paths, as well as changing a Git ref. Validate
and build the target before activation, preserve settings, secrets, schedules,
and stored data, and retain a rollback source. This supports local development,
PR-branch verification, and returning to `main` after merge.

Verified against BB 0.42.1: `plugin source` is read-only, `plugin update` keeps
the current ref, and install refuses an existing managed plugin ID from a
different ref. Removal deletes settings, secrets, and schedules.

Status: no upstream issue filed. Suggested issue title:
`Allow changing a plugin Git ref while preserving plugin data`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).


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

## Upstream issues

Problems found while building these plugins whose fix belongs outside this
repository. Each entry records the evidence so it can be filed or re-verified
later. Remove an entry when the upstream fix ships.

### Mobile dictation is unavailable with attachments or active runs

- **Where:** BB 0.42.1 core composer, in the mobile compact layout.
- **Symptom:** dictation is unavailable when the current draft has text or an
  attachment, including an image. While a thread is running, the compact
  submit slot shows **Stop run** or **Steer current run** instead.
- **Cause:** the compact composer renders the microphone only when the draft
  has no text or attachments. A running thread also gives that submit slot to
  its run control. The recorder itself has no text, attachment, or running-turn
  guard.
- **Reproduction:** at a 390x844 viewport, a running thread rendered the
  compact composer without a microphone. The microphone appeared after the
  composer expanded. Clicking it reached microphone permission handling in
  the headless browser, which produced the expected permission error.
- **Fix:** keep dictation as an independent action in the compact composer.
  Dictation should insert the transcript into the current draft. It should not
  steer or submit unless the user selects that action.
- **Status:** not filed yet. Suggested issue title: `Mobile: keep dictation
  available with attachments and active runs`. File the request in [BB
  issues](https://github.com/get-bb/bb/issues).

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
