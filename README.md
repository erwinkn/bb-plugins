# BB plugins

A private GitHub collection of BB plugins.

`bb-mcp` exposes authenticated MCP tools for creating, managing, and monitoring
BB coding threads through Executor or a direct client. It uses explicit
project/host scope, isolated worktrees, bounded results, and durable request
records. Child threads, handoffs and execution controls are supported. See
[BB MCP](plugins/bb-mcp/README.md) for setup and the
[product parity inventory](plugins/bb-mcp/PARITY.md) for the remaining roadmap.

`plans` provides plan review with a per-thread
review panel, comments, revision history, and feedback to the original agent. See
[Plans](plugins/plans/README.md) for installation, the agent workflow, and storage limits.

`erwin-activity` adds a status-first thread list: Needs Attention, Unread,
Working, Draft, and Done. It also supports project grouping and spaces, named
project selections shared by every client. See
[Threads](plugins/activity/README.md) for local installation and draft limits.

`erwin-editor` adds a Pierre file editor: a Files panel with a file tree,
BB-matched syntax colors, a code theme picker, and an editable Changes tab.
Both tabs share file buffers and safe saves. See [Editor](plugins/editor/README.md).

`erwin-devin` adds **Devin** as a provider, with a native icon, sign-in
help, executable setting, account usage, and live ACP model catalog. It preserves the provider
ID `acp-devin`. See [Devin provider](plugins/devin/README.md) for configuration,
verification, and migration from a custom ACP entry.

`voice-mode` adds one live voice model, background workers, task and subscription
views, session history, and spoken thread updates. See [Voice Mode](plugins/voice-mode/README.md).

`erwin-provider-usage` supplies the compact usage popup. See [Provider usage
compact](plugins/provider-usage/README.md) for installation and rollback.

`erwin-plugin-nav` hides the ellipsis button on plugin sidebar rows, including
Automations. See [Hide plugin nav menus](plugins/plugin-nav/README.md).

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
6. Keep the PR in draft until the human explicitly requests that it be marked
   ready for review. Passing checks, completed live verification, or a general
   request to finish the work does not authorize this transition. Before marking
   it ready, remove temporary work files from the PR diff and from any content
   sent to review agents. This includes plans, review notes, Markdown documents,
   HTML previews, prototype scripts, and other files created for development
   that the plugin does not need. Keep tests and files required to build, run,
   or use the plugin. Keep repository instructions and documentation changes
   that the user explicitly requested. Check the final PR diff for these files
   before requesting agent reviews, including reviews while the PR is in draft.
   Extra review content consumes credits and costs money. Mark the PR ready only
   after the user's explicit request, this cleanup, and successful live
   verification. Monitor
   checks and review comments while it is in draft and after it is marked ready.
   Address valid findings and push fixes. Update the installed plugin and repeat
   affected checks after each fix. Continue until required checks pass and review
   findings are resolved on the latest commit. No comments yet is not proof of
   a completed review; report unavailable or pending reviews.
7. Give the user the PR and report whether it is draft or ready for review.
   Leave the tested branch installed. The user
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

An existing `path:` installation can move to another path with
`bb plugin install path:<directory> --yes` while retaining its plugin ID and
server-side state. For a branch preview of a plugin with settings, use a stable
Git clone checked out at the pushed feature branch, build there, and move only
that plugin to the clone. Do not use a temporary worktree. Record the clone's
branch and full commit hash beside `bb plugin source`, since BB reports a path
source without a resolved Git commit. Update that clone explicitly for each
preview; `bb plugin update` does not fetch path installations. After merge,
return it to `main` and rebuild, or move it back to its recorded normal path.
A managed Git source switch still needs the upstream API described below.

For example, after confirming that a plugin has no server-side data:

```sh
bb plugin source erwin-devin --json
bb plugin remove erwin-devin
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@BRANCH --plugin erwin-devin --yes
bb plugin source erwin-devin --json
```

After a new push, use `bb plugin update <id> --yes`. After the user
merges, repeat the verified source-switch procedure with `@main`, then check
the resolved commit and the plugin behavior. Recheck the data stores before
each remove/install cycle; a later plugin version may start storing data.

`erwin-activity` stores its space catalog in `bb.storage.kv` (table
`plugin_kv` in `bb.db`), so the exception above no longer applies to it once
a space exists. Before changing its source, run `bb activity spaces-export`
and keep the JSON; after the new source is running, compare it with a fresh
export and restore it with `bb activity spaces-import '<json>'` if needed.
Observed on BB 0.42.1: `bb plugin remove` left `plugin_kv` rows and
`~/.bb/plugins/<id>/data.db` of removed plugins in place, matching its
documented scope (settings, secrets, schedules). Treat that as a courtesy, not
a guarantee; the export is the safety net.


## Desired upstream changes

Record potential BB issues here for later review and filing. Do not open new
issues in the BB repository as part of plugin implementation.

### Update thread permissions and service tier without dispatch

BB 0.42.1 / SDK 0.4.47 accepts model and reasoning overrides in
`threads.update`, but permission mode and service tier only on create/send.
Expose sticky next-turn updates for both, with provider validation and native
host/parent ceilings, without sending a dummy message or restarting work.
The MCP supports those fields on create/send and reports the standalone gap.
Tracked in [BB #3401](https://github.com/get-bb/bb/issues/3401).

### Potential MCP parity API gaps to validate locally

The [parity inventory](plugins/bb-mcp/PARITY.md) identifies three additional
contracts to verify while implementing the remaining adapters:

- Complete tool-output retrieval when event history retains only a preview.
  A bounded, paginated output API should distinguish truncation from missing data.
- Attachment inventory and removal: the current public SDK exposes upload,
  read and copy, but no matching list/delete operations.
- Provider goal controls: establish a typed contract for create/update,
  pause/resume and budget changes instead of synthesizing private events.

These are local candidates, not filed requests. Confirm the exact missing
contract against the installed SDK before preparing an issue later.

### Durable idempotency for thread creation and messaging

BB 0.42.1 / SDK 0.4.47 does not accept caller idempotency keys on public
`threads.spawn` or `threads.send`. BB can commit before a plugin records the
response, leaving an ambiguous crash/reload boundary. Core should atomically
deduplicate requests and expose durable request lookup. The MCP plugin retains
`outcome_unknown` records and requires reconciliation instead of redispatch.
Tracked in [BB #3396](https://github.com/get-bb/bb/issues/3396).

MCP monitoring also reconciles pending plugin prompts through the interactions
API while [BB #3397](https://github.com/get-bb/bb/issues/3397) is outstanding.
Data-preserving source changes remain necessary for this populated plugin;
the related source-rebind request is
[BB #2297](https://github.com/get-bb/bb/issues/2297). Follow the stable-clone
fallback above until a managed Git/path switch exists.

### Hide the options button on plugin sidebar rows

BB 0.42 always shows a hover ellipsis on plugin nav rows. The menu is only
Hide from sidebar and Customize sidebar. Those actions stay available from
right-click and More > Customize sidebar. There is no per-row or global
visibility option.

`erwin-plugin-nav` hides the button with a content script on
`data-sidebar-navigation-item` / `.bb-sidebar-hover-actions`. Automations is
special-cased by BB to `__bb__/automations` but still uses the plugin row.
Thread rows and built-in New thread / Search / Extensions use different
markup and stay unchanged.

This belongs in BB's sidebar nav. A plugin CSS override will break if those
selectors change.

Status: implemented here. No upstream issue filed.
Suggested issue title: `Allow hiding the plugin sidebar options button`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Recursive thread archiving

BB's native archive action archives a thread and its direct children, but not
all descendants. Make this recursive across sidebar actions, other menus, and
keyboard shortcuts. The Threads plugin currently collects the descendant tree
and archives deepest first through public SDK calls. A server-owned operation
should handle concurrent child creation and reparenting consistently, preserve
BB's lifecycle cleanup, and report partial failures.

### Editable plugin diff renderers and Git targets

Allow a plugin to edit a live working file inside BB's native diff viewer.
`experimental_diffRenderer` (BB 0.42.1) passes only patch text, path, display
options, optional complete sides and `Original`: no environment or host
identity, revision target, file hash, or save/refresh actions, so a
replacement can only render. Extend the contract with source and revision
identity and optional live-file read/save/refresh; keep historical and
patch-only callers read-only and `Original` as the fallback. Two smaller gaps:
`commandPaletteAction` has no shortcut field, so ⌘D cannot be pointed at a
plugin's Changes tab, and the diff panel's frame (scope picker, file list) has
no replacement slot.

Add explicit staged and unstaged diff targets and index-content reads. The
current targets are `uncommitted`, `branch_committed`, `all` and `commit`;
`uncommitted` combines index and unstaged changes, and `diffPatch` only reads
patches. Any stage, unstage or revert API should check disk/index generations
and report a stale patch as a conflict.

Expose raw porcelain status or an `unmerged` flag on
`environments.status().workspace.workingTree.files`. SDK 0.4.47 folds `AA`
(both added) into `A`, so a markerless both-added conflict looks like a normal
addition; the editor blocks `U` conflicts and conflict markers but cannot
detect this case.

Pierre 1.4.1 exposes search, replace and find-again only through editor key
commands; the plugin uses a reserved key binding for toolbar search. A public
command method would remove that DOM dependency.

For editor lifecycle support, add plugin tab dirty state, close negotiation,
retitle and line-location delivery to file openers. File removal needs an
expected-hash precondition, and revision reads need file mode metadata so a
restored file can keep its executable bit.

Status: recorded locally on 2026-09-07; no upstream issue filed.
Suggested issue titles: `Pass semantic edit context to plugin diff renderers`,
`Expose staged and unstaged Git targets with guarded patch actions`, and
`Add dirty state and lifecycle controls for plugin editor tabs`.
File separate requests in [BB issues](https://github.com/get-bb/bb/issues).

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

Rechecked on 2026-09-09 for `erwin-editor`: installing the HTML-preview
worktree over its Git `main` installation returned HTTP 422, with
`plugin id "erwin-editor" is already installed ...; remove it first`.
The Editor has saved settings, so this command could not activate the change.
The user then explicitly authorized removal and reinstallation. After backing
up the plugin directory and exporting its settings, installation from the
worktree succeeded with the same `erwin-editor` ID. All seven settings were
restored and verified. This was an explicit exception, not an in-place switch.

Status: no upstream issue filed. Suggested issue title:
`Allow changing a plugin Git ref while preserving plugin data`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).


### Project groups as a native sidebar scope

The Threads plugin's spaces filter only its own list. BB's composer project
picker, notifications, search, and the native sidebar do not know about them,
and the plugin cannot add a new project to the selected space because the SDK
has no project-creation event that identifies the originating client. A native
project-group concept, or at least a client-aware `project.created` event and
a way for a thread-list plugin to scope BB's new-thread project picker, would
let the feature cover the whole product.

Status: no upstream issue filed. Suggested issue title:
`Native project groups (spaces) for sidebar and composer scoping`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).


### Share Pierre's editing API with plugins

Expose `@pierre/diffs/edit` through BB's shared frontend runtime, alongside
`@pierre/diffs` and `@pierre/diffs/react`. The Editor plugin needs Pierre's
editing API, which the current runtime mapping does not expose. Until that
API is available, the plugin ships its own prebuilt Pierre assets in Git.

Sharing the editing API, with a compatible worker/highlighter integration,
would let the plugin use BB's Pierre copy. This would remove the separate
asset bundle and avoid competing custom-element definitions and theme
registries. Verify the editor and worker APIs together before removing the
plugin's bundle.

Status: no upstream issue filed. Suggested issue title:
`Expose @pierre/diffs/edit to plugin frontends`.
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

### Plugin SDK: map the call owner's client to an enrolled machine

Voice Mode exposes machine discovery and optional host selection for hidden
workers. The existing `bb.sdk.system.config().primaryHostId` supplies the default
machine; this replaces the earlier project-count heuristic and resolves the
previous request to expose the primary host.

The remaining gap is caller identity: the frontend SDK does not identify which
enrolled machine, if any, owns a browser or desktop client. Platform and browser
information cannot distinguish two Macs, and the viewed thread's environment
may be on another machine. Expose a host-resolved client identity with an optional
enrolled host ID and documented behavior for remote browsers and unbound devices.
Keep this distinct from authorization to control that machine.

Voice currently supplies a bounded client-reported device descriptor and leaves
its host ID unknown. For computer use, the assistant uses the machine named by
the user or asks which machine to target. This belongs upstream in BB's client
identity and plugin context APIs.

Status: verified against BB 0.42.1 / SDK 0.4.47; no upstream issue filed.
Suggested issue title: `Plugin SDK: expose caller client identity and optional enrolled host`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Mobile: keep an active voice call alive when the screen locks

The plugin no longer hangs up when the phone screen locks: it holds the call,
marks the microphone suspended, and revives it when the app returns to the
foreground. A screen wake lock keeps the phone awake while the call runs. But the
plugin cannot capture or play audio while the BB app is in the background, because
the iOS webview pauses media capture and playback when it hides. A held call
therefore goes quiet under a lock and only resumes on unlock.

For true hands-free use while walking, the BB iOS app should let an active voice
call keep audio in the background, for example with a `voip` or `audio` background
mode and an audio session that stays active. Then a locked phone can still hear
and answer.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Mobile: allow background audio for an active voice call`.
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

### Voice questions and approvals

Voice workers use native BB questions and approvals. Ada reads their IDs, subjects,
and reasons, then uses `threads.interactions.respond` or `resolve` after a later
spoken answer. Archive also requires a spoken preview and later confirmation.
The earlier plugin-waiter workaround and proposed requestInput ID API are no longer
needed for this path.

### Voice background updates

Voice records native worker events in its inbox and groups updates by watched root.
The live model receives them at a quiet boundary. Critical questions, approvals,
and failures stay pending until resolved. There is no hidden coordinator receiving
background messages, so the earlier consume-and-coalesce dispatch proposal is no
longer needed by Voice.

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

### Long-running plugin tool calls: heartbeat Cursor and abort orphaned calls

The Plans plugin blocks `plans_submit` on `bb.ui.requestInput` so a review
works like a native user question. With Codex the call held for 95 s and 63 s
and returned the decision in-turn. With the Cursor ACP provider the call failed
after 60 s with `MCP error -32001: Request timed out`, while the plugin's
`execute` kept running: its `signal` was not aborted, so the interaction stayed
pending and the wait counted as attended. BB fixed the same client timeout for
opencode with progress heartbeats in
[PR #1945](https://github.com/get-bb/bb/pull/1945).

Requested behavior:

- Send MCP progress heartbeats to Cursor's client while a plugin tool call is
  pending, as for opencode.
- Abort the tool call's `signal` when the provider abandons the request
  (timeout, turn end), so plugins can release held interactions.
- Expose a provider capability such as `supportsLongRunningToolCalls` in
  `PluginAgentConfigurationContext`, so plugins can withhold blocking tools
  without a provider id list. The plugin currently keeps a
  `nonBlockingProviders` setting defaulting to `acp-cursor`. On those
  providers it holds the review prompt server-side without blocking and
  delivers the decision as a thread message, because a finished background
  shell command does not wake an idle Cursor agent; only a message does.

Also observed: a thread spawned right after `bb plugin update` still resolved
the previous global-skills snapshot (`/Users/erwin/.bb/runtime/global-skills/
<old hash>/skills/plan-review/SKILL.md`), so the agent read the stale skill.

Verified on 2026-09-07. No upstream issue filed. Suggested issue title:
`Plugin tool calls: heartbeat Cursor's MCP client and abort orphaned calls`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Mobile panel shell: scope `select-none` to the drag handle

On phones BB renders the secondary panel inside
`div.fixed.inset-y-0.right-0 … touch-pan-y select-none`. Every plugin panel
inherits `-webkit-user-select: none` from it. In WebKit (iOS Safari and the
mobile app) that blocks two things inside a plugin: long-press text selection,
and painting of CSS Custom Highlight API ranges, which WebKit treats like
selection and skips under `user-select: none`. Chromium paints them regardless,
so desktop hid the problem. The Plans plugin now sets `select-text` on its
document; a plugin that renders selectable content should not have to know
about the shell's rule.

Requested behavior: keep `select-none` on the drag handle and header chrome
only, or add `select-text` to the panel content slot.

Reproduced on 2026-09-08 in Playwright WebKit 26.6 with the iPhone 15 profile
against BB 0.42.1: `plugins/plans/scripts/mobile-probe.mjs` reports the
blocking ancestor and `--engine-only` shows the same `Highlight` painting
outside a `select-none` subtree and not inside it. No upstream issue filed.
Suggested issue title: `Mobile panel shell applies select-none to plugin
content, blocking selection and CSS highlights in WebKit`. File the request in
[BB issues](https://github.com/get-bb/bb/issues).

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


### Voice operator isolation and managed workspace primitives

Ada uses one live model and hidden root workers. It supports direct messaging,
worker creation, named profiles, and a Tasks view. SDK 0.4.47 can create a managed
worktree through `threads.spawn`, but
has no standalone environment/worktree creation API or hard read-only spawn
mode. Plugin tool selection also does not revoke native coding-agent tools.

Desired upstream additions: standalone managed-workspace creation with typed
results; capability-scoped agent execution (including enforced read-only roles);
and cancellation/idempotency support for thread sends and creation. Until these
exist, role instructions are not a sandbox, unknown sends/creates are not
automatically retried, and worktree creation is coupled to a worker thread.
See [Voice architecture](plugins/voice-mode/docs/architecture.md).

Status: recorded here; no upstream issue filed. Suggested issue title:
`Expose scoped worker capabilities and durable managed-workspace operations`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### `bb plugin dev` does not rebuild on source changes

- **Where:** `bb plugin dev .` in `plugins/plans`, bb 0.42.1, plugin installed
  from a worktree path (`source: path:...`). Plugin declares a frontend
  (`app.tsx`, `app.css`) and a server bundle.
- **Symptom:** the command prints `Watching <path> for plugin "plans"
  (frontend rebuild + reload on change)` and stays running, but editing or
  touching `app.tsx` / `app.css` produces no further output, `dist/` keeps its
  old mtime, and BB keeps serving the previous bundle. Observed twice: once
  when started from a subshell that was reaped, once under `nohup` where the
  process stayed alive (confirmed with `pgrep`) for over a minute.
- **Workaround:** `npm run build` (`bb plugin build`) followed by
  `bb plugin reload plans`. Both work immediately.
- **Status:** not filed yet; not yet reproduced in isolation. Open questions
  for the repro: whether the watcher follows the path under `~/.bb/worktrees`
  (symlink or FSEvents scope), whether it only reacts to files listed in the
  manifest, and whether it needs the plugin's `package.json` scripts. Suggested
  issue title: `bb plugin dev: watcher starts but never rebuilds or reloads`.

### Plugin interactions never emit `interaction.pending`

- **Where:** bb 0.42.1, `server/dist/start-server.js`. `registerProviderInteraction`
  (provider-origin approvals and questions) calls
  `emitPluginInteractionPending` after creating the row. `requestPluginInteraction`,
  the path behind `bb.ui.requestInput`, appends the timeline event and notifies
  `interactions-changed` but never emits the event.
- **Symptom:** the built-in `push-notifications` plugin subscribes to
  `bb.events.on("interaction.pending")`, so no desktop, web, or mobile
  "Waiting for your input" notification is sent for plugin-origin interactions.
  Verified with the Plans plugin's review prompt (`pint_qb9gre97qw`, pending for
  two minutes, no notification), and by reading the built-in `ask-user-question`
  plugin, which uses the same `bb.ui.requestInput` call
  (`ask-user-question/dist/server.js:14098`) and is therefore affected too.
  The sidebar indicator is unaffected: `hasPendingInteraction` is computed from
  the table, and `/api/v1/sidebar-bootstrap` returned `true` with the
  "Needs Attention" icon shown while the prompt was pending.
- **Related:** `latestAttentionAt` only advances on active→idle and →error
  transitions (`statusTransitionNeedsAttention`), so a pending plugin
  interaction does not mark the thread unread either.
- **Fix:** call `emitPluginInteractionPending(thread, interaction)` in
  `requestPluginInteraction` after the row is created, and consider bumping
  `latestAttentionAt` when a pending interaction is created on an idle thread.
- **Status:** filed as [BB #3397](https://github.com/get-bb/bb/issues/3397),
  `Plugin prompts created with bb.ui.requestInput do not emit interaction.pending`.
