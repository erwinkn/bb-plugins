# BB plugins

A private GitHub collection of BB plugins.

`bb-mcp` exposes BB through a code-mode MCP for trusted orchestrators:
`bb_execute` runs JavaScript in an isolated worker whose `bb` global mirrors the
complete BB SDK, `bb_read` serves the read-only subset for client auto-approval,
and `bb.ops`/`bb.approve` add durable dispatch receipts and remote approvals.
The token is owner-level — filesystem, terminals and plugin administration are
all reachable. See [BB MCP](plugins/bb-mcp/README.md).

`plans` provides plan review with a per-thread
review panel, comments, revision history, and feedback to the original agent. See
[Plans](plugins/plans/README.md) for installation, the agent workflow, and storage limits.

`sidebar` adds a status-first thread list: Needs Attention, Unread,
Working, Draft, and Done. It also supports project grouping and spaces, named
project selections shared by every client. See
[Threads](plugins/sidebar/README.md) for local installation and draft limits.

`editor` adds a Pierre file editor: a Files panel with a file tree,
BB-matched syntax colors, a code theme picker, and an editable Changes tab.
Both tabs share file buffers and safe saves. See [Editor](plugins/editor/README.md).

`theme` contributes unified BB themes: a colored app palette (tinted tool
glyphs, fuller chat code colors, purple thread pills, heading accents) paired
with each code theme, one pick for chrome and code. Its tests grep the installed
BB bundle for every host selector the stylesheet relies on. See
[Theme](plugins/theme/README.md).

`devin` adds **Devin** as a provider, with a native icon, sign-in
help, executable setting, account usage, and live ACP model catalog. It preserves the provider
ID `acp-devin`. See [Devin provider](plugins/devin/README.md) for configuration,
verification, and migration from a custom ACP entry.

`voice-mode` adds one live voice model, background workers, task and subscription
views, session history, and spoken thread updates. See [Voice Mode](plugins/voice-mode/README.md).

`provider-usage-compact` supplies the compact usage popup. See [Provider usage
compact](plugins/provider-usage-compact/README.md) for installation and rollback.

`remove-plugin-ellipsis` hides the ellipsis button on plugin sidebar rows, including
Automations. See [Hide plugin nav menus](plugins/remove-plugin-ellipsis/README.md).

`scratchpad` adds a shared rich-text document per worktree, with BlockNote
editing, JSON storage outside Git, revision history, and agent tools. See
[Scratchpad](plugins/scratchpad/README.md).

## Install

Use BB 0.43.1 or later. The bb server needs Git, npm, and GitHub access to this
private repository. Configure Git authentication on that machine; do not put a
token in the repository URL.

Replace `COMMIT_SHA` with the full reviewed commit SHA:

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@COMMIT_SHA --plugin devin
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

Plugins that store thread plugin metadata (sidebar, questions, plans,
voice-mode, bb-mcp) require BB 0.43.1; the others work on BB 0.43.0. This
instance runs BB from a global npm install under the user systemd unit
`bb-app.service`; upgrade with `npm install -g bb-app@latest` and
`systemctl --user restart bb-app`, never with `npx bb-app@latest` while the
unit is enabled.

The earlier Hello proof plugin and general branding experiment have been
removed from the current collection. Their prior commits and release tags stay
in Git history.

### Development topology

This repository is developed from the **main checkout** at `~/Code/bb-plugins`
by one **orchestrator thread** (Claude Code) plus short-lived child threads.
There are no permanent per-plugin PM threads, no managed worktrees, and no
feature branches or pull requests for routine work.

- The orchestrator is the only agent that runs Git commands: pull, add,
  commit, push, stash, checkout. Child threads never touch Git.
- The user talks to the orchestrator. For a change to a plugin, the
  orchestrator spawns a child thread on the main checkout with the full task,
  the child investigates, implements, and reports back, and the orchestrator
  verifies, reloads, and commits. The orchestrator does not diagnose or look
  for the solution itself before delegating: the child owns the whole
  problem, from finding the cause to verifying the fix.
- When a child has reported and its work is committed or reverted, the
  orchestrator archives the child thread.
- The orchestrator stays available while a child works, so it can relay
  questions to the user or discuss design points, but by default quick changes
  are hand-off, implement, reload, commit.
- One child per plugin at a time. Parallel children are fine when they touch
  different plugins; the orchestrator sequences commits so each commit is one
  coherent change.

### The daily loop

Every plugin installs from the main checkout's path —
`path:~/Code/bb-plugins/plugins/<name>` — never a `git:` ref. The running plugin
tracks whatever the checkout contains. The checkout stays on `main` at all
times; never check out another branch there, and never run `git rebase` or
`git reset --hard` in it.

1. The user describes the change to the orchestrator.
2. The orchestrator confirms the checkout is clean and on `main`
   (`git status`, `git pull --ff-only`), then spawns a child thread with the
   brief: plugin directory, expected behavior, and verification commands. The
   child works directly in `~/Code/bb-plugins/plugins/<name>` and may run
   `npm run typecheck`, `npm test`, and `npm run build` there. Spawn children
   with `--permission-mode full`: with `accept-edits`, the child's first file
   edits still stop for approval, and permission mode can only be raised
   afterwards through a follow-up message, which queues behind that approval.
3. The child reports back with the files changed and what it verified. It does
   not commit.
4. The orchestrator reviews the diff, runs `bb plugin build
   ~/Code/bb-plugins/plugins/<name>` and `bb plugin reload <name>` (or keeps
   `bb plugin dev <path>` running for live rebuild+reload), and the user checks
   the live behavior — desktop and mobile when the UI changes.
5. If it is good, the orchestrator commits on `main` and pushes to `origin`
   directly. If not, the orchestrator sends follow-up instructions to the same
   child, or reverts the working tree with `git checkout -- <paths>` when the
   change is abandoned.

Keeping the Git state healthy is the orchestrator's job:

- Commit only files that belong to the change; leave unrelated working-tree
  changes alone and ask the user about anything unexpected.
- Never leave a half-applied change in the checkout across sessions: either
  commit it or revert it before ending the turn.
- Run `git pull --ff-only` before each new piece of work. If the pull is not a
  fast-forward, stop and report; do not rebase or reset.
- Do not use `git stash` as long-term storage. Stash only to pull and pop
  immediately.
- Trivial doc and comment fixes may be made by the orchestrator itself without
  a child thread, under the same commit rules.

Larger or riskier changes (cross-plugin refactors, anything the user wants
reviewed before it runs in the daily instance) may still use a feature branch
and a draft PR, but only when the user asks for it. In that case the branch is
created in a separate clone or worktree, never in the main checkout, and the
install stays on the main checkout path until merge.

For a plugin that is not installed yet:

```sh
bb plugin install path:/home/exedev/Code/bb-plugins/plugins/PLUGIN --yes
bb plugin dev /home/exedev/Code/bb-plugins/plugins/PLUGIN
```

Why not `git:`: a `git:` source cannot move in place — switching between
`git:` and `path:` needs a remove/install cycle, which deletes settings and
secrets (`data.db` survives only by courtesy; back it up). Tracking the
checkout path keeps `bb plugin dev` available and makes reload the only step
between an edit and the running plugin.

### Source switches and data preservation

Use `bb plugin source <id> --json` to inspect the installed source and
`bb plugin update <id>` to fetch updates from its current ref — `update` does
not fetch path installations. Check the current CLI help when changing refs.
Preserve settings and data; `bb plugin remove` deletes plugin settings,
secrets, and schedules and is not a source-switch command. Coordinate with
the orchestrator before replacing an installation a child thread is testing.

BB 0.42.1 has no in-place Git-ref switch in its CLI or plugin API, and
installing the same plugin ID from a different ref is refused. Path installs
avoid this entirely: `bb plugin install path:<directory> --yes` moves an
existing `path:` installation in place while retaining its plugin ID and
server-side state.

A remove/install cycle is the fallback for sources that cannot move in
place. It is allowed only for a plugin with no server-side settings,
secrets, schedules, or stored data — verify those stores are empty first,
preserve the plugin ID and browser storage (never clear client preferences),
record the previous source so failure can be rolled back, and check the
resulting source and enabled state. For a plugin with data, back up its data
directory, settings, and secrets beforehand and verify them afterward;
`data.db` surviving removal is a courtesy, not a guarantee.

For example, after confirming that a plugin has no server-side data:

```sh
bb plugin source devin --json
bb plugin remove devin
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@BRANCH --plugin devin --yes
bb plugin source devin --json
```

After a new push to an installed Git branch, use `bb plugin update <id> --yes`.
After the user merges, switch back with `@main`, then check the resolved
commit and plugin behavior. Recheck the data stores before each
remove/install cycle; a later plugin version may start storing data.

For a branch preview of a plugin with settings that must stay on a `git:`
source, use a stable Git clone checked out at the pushed feature branch,
build there, and move only that plugin to the clone. Do not use a temporary
worktree. Record the clone's branch and full commit hash beside
`bb plugin source`, since BB reports a path source without a resolved Git
commit. Update that clone explicitly for each preview. After merge, return it
to `main` and rebuild, or move it back to its recorded normal path. A managed
Git source switch still needs the upstream API described below.

`sidebar` stores its space catalog in `bb.storage.kv` (table
`plugin_kv` in `bb.db`), so before changing its source, run
`bb sidebar spaces-export` and keep the JSON; after the new source is
running, compare it with a fresh export and restore it with
`bb sidebar spaces-import '<json>'` if needed. Observed on BB 0.42.1:
`bb plugin remove` left `plugin_kv` rows and `~/.bb/plugins/<id>/data.db` of
removed plugins in place, matching its documented scope (settings, secrets,
schedules). Treat that as a courtesy, not a guarantee; the export is the
safety net.


## Desired upstream changes

Record potential BB issues here for later review and filing. Never open
issues, PRs, or comments on the BB repository or any other repo without the
user's explicit request or approval in the current conversation — see
AGENTS.md.

### Compact plugin interaction prompts

Verified in BB 0.43.1 / SDK 0.4.87 and the installed frontend bundles (which
omit source maps; the symbols below identify the shipped components):

- `workspace-checkout-display-BY4OfVwL.js`, `F0`, the plugin request renderer
  (`plugin-interaction-shell`): always inserts a paragraph before the renderer.
  It says “Requested by <pluginId>” for cancellable plugin requests, or “The agent
  asks through <pluginId>” for provider requests. The plugin ID comes from the
  interaction origin, not a description or title field.
- The same bundle's `A$`, the shared interaction shell: renders “From <title>”
  when expanded and given `sourceThread`. Its origin link takes up to 40% of the
  header while the expanded heading uses `whitespace-normal`.
- `SplitWorkspaceRoute-DkpKauH2.js`, `Wd`, the propagated-child interaction
  renderer: supplies `sourceThread: {href, title: childTitle}` and the child's
  thread ID. Direct-thread rendering omits `sourceThread`. Changing the plan's
  request title cannot remove either attribution; changing its thread ID would
  change routing and ownership.

On Erwin's phone, that origin link squeezed a shortened heading into five lines,
then “Requested by Plans” repeated attribution below. Plans now hides both rows
with a disposable content-script stylesheet scoped to
`data-request-kind="plans/plan-review"` and the shell's DOM markers, while keeping
the real interaction origin and thread ID. It also ellipsizes the host heading.
This is a tested DOM fallback, not an SDK presentation contract; changed host
markup can bring the labels back. An unstyled host `fieldset` additionally uses
`min-width: min-content`; Plans contains its body's intrinsic width to avoid
mobile overflow.

Requested host change: add compact/provenance presentation options to
`PluginPendingInteractionRegistration`, pass them to the plugin request renderer
and shared shell to omit both attribution elements, and allow an ellipsized
heading with responsive actions. Set `min-width: 0` on the renderer fieldset.
The current request/registration typings expose none of those options.

Status: plugin cleanup implemented here; no upstream issue filed.
Suggested issue title: `Add a compact layout for plugin interaction prompts`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### Provider-independent thread handoffs

Expose a native handoff operation that atomically reuses the source environment,
records the source thread and context boundary, and permits selecting a new
provider/model with a bounded context seed. The source should keep running unless
stopping it is requested separately. Validate project, host, permissions, and
source availability at creation time.

Verified against BB 0.42.1 / SDK 0.4.47: `threads.update` supports same-provider
model/reasoning overrides, but `threads.spawn.sourceThreadId` requires an
`originKind`, whose only supported value is `fork`. Forks require a cloneable
session on the same provider. Voice Mode therefore stores handoff provenance in
its operation receipts and seeds a new root thread with recent messages; the
native sidebar cannot display that relationship.

Status: plugin fallback implemented here; no upstream issue filed.
Suggested issue title: `Add provider-independent thread handoffs with source provenance`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### Update thread permissions and service tier without dispatch

BB 0.42.1 / SDK 0.4.47 accepts model and reasoning overrides in
`threads.update`, but permission mode and service tier only on create/send.
Expose sticky next-turn updates for both, with provider validation and native
host/parent ceilings, without sending a dummy message or restarting work.
The MCP supports those fields on create/send and reports the standalone gap.
Filed automatically as [BB #3401](https://github.com/get-bb/bb/issues/3401)
and closed by the owner on 2026-09-10 as not planned, because the auto-filed
text had not been reviewed. Rechecked 2026-09-12: BB 0.43.1 / SDK 0.4.87 still
has no `permissionMode` or `serviceTier` on `threads.update`. Candidate for
refiling after review.

### MCP code-mode boundary

bb-mcp 0.4 replaced scoped thread-management tools with full-SDK code mode:
the sandbox runs caller JavaScript with the token's owner-level access (files,
terminals, plugin administration — all of `bb.sdk`). The only plugin-side
boundary is the `bb_read` read-only tier for client auto-approval. Remaining
native boundaries are the standalone permission/service-tier update and atomic
idempotency requests noted above and below. No new upstream issue is needed.

### Follow-ups before a scheduled thread's first run

BB 0.42.1 accepts a scheduled first instruction but rejects a follow-up without
an explicit model before that first turn initializes: `no stored execution
model`. Specifying the creation model on the follow-up succeeds (verified in
`pulse-ui`). Core should resolve the model from the queued initial execution
options or normal defaults. The MCP documents the explicit-model workaround.
No upstream issue filed yet; suggested title: `Resolve execution defaults for
follow-ups before a scheduled thread starts` in
[BB issues](https://github.com/get-bb/bb/issues).

### Durable idempotency for thread creation and messaging

BB 0.42.1 / SDK 0.4.47 does not accept caller idempotency keys on public
`threads.spawn` or `threads.send`. BB can commit before a plugin records the
response, leaving an ambiguous crash/reload boundary. Core should atomically
deduplicate requests and expose durable request lookup. The MCP plugin retains
`outcome_unknown` records and requires reconciliation instead of redispatch.
Filed automatically as [BB #3396](https://github.com/get-bb/bb/issues/3396)
and closed by the owner on 2026-09-10 as not planned, because the auto-filed
text had not been reviewed. Rechecked 2026-09-12: BB 0.43.1 / SDK 0.4.87 still
has no idempotency key on `threads.spawn` or `threads.send`. Candidate for
refiling after review.

MCP monitoring also reconciles pending plugin prompts through the interactions
API; [BB #3397](https://github.com/get-bb/bb/issues/3397) was fixed in BB 0.43.0
by [PR #3398](https://github.com/get-bb/bb/pull/3398).
Data-preserving source changes remain necessary for this populated plugin;
the related source-rebind request is
[BB #2297](https://github.com/get-bb/bb/issues/2297). Follow the stable-clone
fallback above until a managed Git/path switch exists.

### Thread- or environment-scoped plugin install sources

BB 0.42.1 maps one plugin ID to one installed source globally, so two threads
cannot live-test the same plugin concurrently — a `path:` move during one
thread's verification affects every client. This is the structural limit the
one-child-per-plugin rule in this repository works around by serializing
verification per plugin. Expose an install-source scope (per environment or
per thread) or a dedicated test channel so parallel work on one plugin is
possible. Related: the source-rebind request in
[BB #2297](https://github.com/get-bb/bb/issues/2297). No upstream issue filed
yet; suggested title: `Scope plugin install sources per environment or
thread`.

### Hide the options button on plugin sidebar rows

BB 0.42 always shows a hover ellipsis on plugin nav rows. The menu is only
Hide from sidebar and Customize sidebar. Those actions stay available from
right-click and More > Customize sidebar. There is no per-row or global
visibility option.

`remove-plugin-ellipsis` hides the button with a content script on
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

Rechecked on 2026-09-09 for `editor`: installing the HTML-preview
worktree over its Git `main` installation returned HTTP 422, with
`plugin id "editor" is already installed ...; remove it first`.
The Editor has saved settings, so this command could not activate the change.
The user then explicitly authorized removal and reinstallation. After backing
up the plugin directory and exporting its settings, installation from the
worktree succeeded with the same `editor` ID. All seven settings were
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
collection now provides `provider-usage-compact` as a local replacement through
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
`acp-devin`, owned by `devin`, with `maintenance.usage: true`. A forced
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

Status: implemented in [Provider usage compact](plugins/provider-usage-compact/README.md).
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

### Detect dev-server ports and offer one-click Connect sharing

BB Connect can already share an HTTP port: `bb connect expose <port>` from a
thread on any enrolled host returns an owner-session URL such as
`https://<host-label>--<port>.<base-domain>` through the getbb.app tunnel, and
`unexpose`/`shares` manage it. Discovery is the gap: nothing notices that a dev
server bound a port, so the user or agent must know the port and run the
command. Agents currently rely on the `share-server-links` skill to expose the
port and hand back a link.

Requested behavior:

- Detect newly listening HTTP ports on enrolled hosts and surface them in the
  UI — for example a share affordance on the terminal that started the server,
  a shares panel, or a notification with a one-click expose action.
- Optionally auto-expose ports bound by processes BB launched, behind a
  per-project or per-host opt-in with an allowlist/denylist.
- Unexpose automatically when the process exits or the port closes, or mark the
  share stale.
- Keep shares owner-session-only by default; any wider audience stays explicit.

Verified on 2026-09-12 against installed BB: `bb connect expose` works and the
instance is paired (`https://erwin.getbb.app`), but there is no port detection
or UI affordance. A plugin could poll `ss`/`lsof` and call the CLI, but native
detection has better process and lifecycle context than port-scanning
heuristics.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Connect: detect listening dev-server ports and offer one-click or automatic sharing`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).

### Thread plugin metadata: change events and frontend access

BB 0.43.1 adds per-thread plugin metadata (`threads.getPluginMetadata` and
`updatePluginMetadata`, seedable on spawn and fork). A metadata update emits
no plugin lifecycle event and no realtime notification, and plugin frontends
cannot read it: thread panel props, sidebar thread rows, and plugin realtime
omit it, so a plugin needs its own RPC plus its own realtime signal. Add a
`thread.pluginMetadata.updated` event and a frontend read path.

Status: recorded 2026-09-12; no upstream issue filed. Suggested issue title:
`Emit an event and expose a frontend read path for thread plugin metadata`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### Synced UI preferences: frontend access for plugins

BB 0.43.0 syncs sidebar preferences through `system.uiPreferences` with
compare-and-swap revisions and a `ui-preferences-changed` realtime message.
Only the backend SDK can read or write them. A plugin frontend has no hook and
no core realtime feed, so a thread-list replacement that wants to honour the
user's grouping and sort must proxy through plugin RPC and poll on focus.

Status: recorded 2026-09-12; no upstream issue filed. Suggested issue title:
`Expose synced UI preferences to plugin frontends`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### Plugin thread lists: nesting primitive and keyboard nesting

BB 0.43.0 adds drag-to-nest in the native sidebar (dnd-kit, `threads.update`
with `parentThreadId`). Plugin thread lists inherit none of it: the plugin
sidebar action API has open, pin, read, rename, archive, and delete, but no
reparent or section move, and there is no shared row DnD primitive. Native
also has no keyboard or mobile "make child of" action.

Status: recorded 2026-09-12; the Threads plugin ports the native behaviour
instead. Suggested issue title: `Expose thread nesting to plugin thread lists
and add a keyboard nest action`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### Enumerable host icon names

`experimental_Icon` renders host icons by name with a fallback, but the SDK
exports no list or literal union of valid names. This collection generates one
from bb source with `scripts/host-icon-names.mjs`. Already reported upstream
as [BB #1859](https://github.com/get-bb/bb/issues/1859), open.

### Heading IDs on host Markdown

BB's `Markdown` renderer emits headings without `id` attributes, and a
same-document anchor link routes to the app root rather than scrolling. The
Editor plugin's preview intercepts the click and matches the anchor to a
heading by a GitHub-style slug of its text; duplicate heading texts collapse
to the first match, and any change to bb's slug rules would silently diverge.
Emitting heading ids (and letting same-document anchors scroll to them) would
let plugins drop the shim.

Status: recorded 2026-09-13; no upstream issue filed. Suggested issue title:
`Markdown: emit heading ids so anchor links can scroll`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### Account Pooler coverage for ACP providers

The bundled Account Pooler proxies only Claude and Codex. Checked 2026-09-12
against bb 0.43.0 and the vendors' documentation: bb can inject environment
into any ACP agent, so a pooler could reach Cursor (documented endpoint and
auth-token overrides; API keys feasible, OAuth refresh undocumented), Grok
Build (API-key mode only), and OpenCode (per underlying provider; ChatGPT
through the existing Codex adapter). Devin has no base-URL or token override,
but Cognition permits copying its credentials file between the user's own
machines, so only credential distribution would work there. Hermes needs an
auth override it does not offer.

Status: recorded 2026-09-12; no upstream issue filed. Suggested issue title:
`Account Pooler: adapters for Cursor, OpenCode, and Grok Build`.
File in [BB issues](https://github.com/get-bb/bb/issues).

### Theming and color hooks

The Theme plugin (`plugins/theme`) colors BB's tool glyphs, chat code blocks,
mention pills, Markdown headings and provider marks through a `bb.themes`
stylesheet and an `experimental_providerIcon` registration. Verified against
BB 0.43.1 / SDK 0.4.87: none of those surfaces has a token or attribute meant
for theming, so `themes/color.css` keys on DOM contracts (`data-icon` glyph
names, `data-timeline-row-id`, `data-plan-step-status`,
`data-markdown-preview`, `.bb-code-highlight`) and
`plugins/theme/host-contract.test.ts` greps the installed bundle for each
string after every BB upgrade. Six host changes would replace those rules:

- **Row kind and status attributes.** In
  `apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx`, on the
  element that already carries `data-timeline-row-id`, add
  `data-timeline-row-kind`, `data-timeline-work-kind` and
  `data-timeline-row-status`. Makes every `[data-timeline-row-id]
  [data-icon="…"]` selector in `color.css` unnecessary and lets a palette tint
  failed rows and turn rows without knowing icon names.
- **Chat code tokens in the documented palette.** Move the sugar-high `--sh-*`
  tokens from `apps/app/src/components/ui/markdown-code-highlight.css` into
  `apps/app/src/components/ui/theme.css` so built-in, custom and plugin
  palettes all carry chat code colors, and ship a vivid variant. Our
  `.bb-code-highlight` override block becomes a plain token block, or goes
  away if the vivid variant is adopted.
- **Per-kind glyph and pill tokens.** Have `TimelineLeadingIcon` in
  `apps/app/src/components/thread/timeline/TimelineRowHeader.tsx` read
  `--glyph-command`, `--glyph-file`, `--glyph-edit`, `--glyph-web`,
  `--glyph-agent`, `--glyph-attention` and `--glyph-error`, and split the
  `--pill-*` tokens in `theme.css` into `--pill-thread-*` and `--pill-file-*`.
  Replaces every glyph rule and the pill block, and closes the gap that file
  pills currently share the purple thread tint because there is one pill
  token set.
- **Role surface tokens.** For the user bubble in
  `apps/app/src/components/ui/ConversationMessageContent.tsx` (`rounded-xl
  border-border-seam bg-surface-recessed`), add `--surface-user-message` and a
  `data-message-role` attribute; `data-message-column` sits on both roles, so
  it cannot distinguish them. We ship no rule for this today because there is
  no hook.
- **Brand tints for bundled providers.** `plugins/provider-pi` declares
  `strings.iconTint`; `plugins/provider-claude-code`, `plugins/provider-codex`
  and the ACP presets in `plugins/provider-acp` do not. Declaring one per
  provider would make the inline marks in `plugins/theme/app.tsx` optional
  rather than the only way to get a colored provider chip.
- **Presentation tint for core rows.** `experimental_timelineRenderer`
  (`packages/plugin-sdk/src/app-contract.ts`) reaches only a provider plugin's
  own row kinds. A `timelineDecorator` slot, or a settings-level tool-row tint
  map, would let a plugin tint claude-code and codex rows without a palette
  pick, replacing the glyph rules for users who keep BB's default palette.

Known gaps that stay until then: glyph names are a code contract, so a BB
redesign that renames a row icon drops that tint silently in the app (only the
contract test notices); settled rows keep BB's `opacity-40`, which mutes the
reasoning tint along with the row; and several surfaces have no hook at all:
timeline row header text and status badges, the user and assistant bubble
roles, the composer model and permission chips, right-panel thread info rows,
the host tab strip, and "Worked for" turn rows.

Status: recorded 2026-09-13; no upstream issues filed. Suggested issue titles:
`Timeline rows: expose kind and status data attributes`,
`Promote the sugar-high --sh-* tokens into theme.css`,
`Per-kind glyph and pill color tokens`,
`User message surface token and data-message-role`,
`Declare iconTint for bundled providers`, and
`Let plugins decorate core timeline rows`.
File in [BB issues](https://github.com/get-bb/bb/issues).

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
  test failed with `null` and passed with `{}`. The plugin's supported hooks
  cannot reach the agent wire — its wrappers see only runtime-to-bridge lines,
  and the SDK's `fs` client capabilities are fixed to `true` — so the `devin`
  plugin instead rewrites the launch spec's `acpLaunchSpec` to spawn
  `devin acp` through a small stdio proxy that repairs that one response
  (`plugins/devin/write-shim.ts`). Optionally report the docs example to the
  ACP project.
- **Status:** filed as [BB #3453](https://github.com/get-bb/bb/issues/3453) on
  2026-09-11, including live confirmation from Devin threads. The earlier
  reproduction used the SDK bridge with a scripted ACP peer. Rechecked
  2026-09-12: SDK 0.4.87 (BB 0.43.1) still answers with `null`. Worked around
  2026-09-13 in the `devin` plugin with a launch-spec stdio shim; the built-in
  ACP provider and other plugins still have the bug.


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
- **Status:** the missing event was fixed in BB 0.43.0 by
  [PR #3398](https://github.com/get-bb/bb/pull/3398) for
  [BB #3397](https://github.com/get-bb/bb/issues/3397); verified 2026-09-12 in
  the 0.43.0 server bundle, where `requestPluginInteraction` now emits it. Not
  fixed: the **Related** item above. `latestAttentionAt` still does not advance
  when a plugin prompt becomes pending on an idle thread, so the thread is not
  marked unread. Kept for that half; suggested issue title: `Mark a thread
  unread when a plugin prompt becomes pending`.


### `threads.interactions.resolve` rejects valid decisions (2026-09-11)

- **Where:** BB SDK `threads.interactions.resolve` via bb-mcp codemode (`bb_execute`) on 0.42.x.
- **Symptom:** For pending approval interactions (`payload.kind: approval`, subjects `tool_use` / `command`), every tried body fails with `HTTP 400: Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'`, including `resolution: 'allow_for_session'` / `'allow_once'` / `'deny'` copied from `payload.availableDecisions`, and object shapes `{ decision }`, `{ kind }`, `{ type }`.
- **Contrast:** CLI `bb thread interactions approve <interactionId> <threadId> --json` succeeds and returns `resolution: { decision: "allow_once", grantedPermissions: null }`.
- **Related CLI mismatch:** `grant --scope session` errors with `Interaction … is tool-use|command and cannot be granted with this command`. `approve` has no `--scope` flag, so `allow_for_session` is advertised in `availableDecisions` but not reachable from the documented CLI for these subject kinds.
- **`respond`:** correctly rejects approvals (`Plugin interaction expected` when `value` is set) — approvals are not plugin forms.
- **Root cause found (bb-mcp 0.4.0):** `grantedPermissions` is a required-but-nullable key on the allow_* resolution variants — sending `{ decision }` without it fails as "Invalid discriminator value" instead of a missing-key error. bb-mcp now ships `bb.approve` which builds the correct shape. Upstream ask remains: a useful error message, plus CLI `grant --scope session` support for tool_use/command subjects.
- **Status:** not filed. Suggested title: `threads.interactions.resolve rejects allow_once/allow_for_session/deny for approval interactions`.

### Terminals SDK input/create arg gaps (2026-09-11)

- **`terminals.input`:** CLI documents `bb terminal send --text … [--enter]`. SDK rejects `text` / `enter` / `data` with `HTTP 400: Required`. Works with `{ terminalId, dataBase64 }` (raw PTY bytes, include trailing newline).
- **`terminals.create`:** `{ scope: { kind: "thread", threadId }, command }` alone returns `HTTP 400: Required`. Succeeds when `cols` and `rows` are also set. Initial `command` did not appear to run (shell MOTD/prompt only); needed a follow-up `input`.
- **Status:** not filed. Suggested titles: `terminals.input should accept text/enter like the CLI`; `terminals.create should not require cols/rows when omitted`.

### `threads.send` permissionMode bump fails without stored execution model (2026-09-11)

- **Symptom:** Follow-up `threads.send` with `permissionMode: "full"` failed on some Pulse review threads (shell-TTL pair) with `no stored execution model` (later also saw HTTP 502 on retry). Other threads in the same batch accepted the mode bump.
- **Status:** not filed. Suggested title: `threads.send permissionMode update fails when execution model is missing`.

### `bb.files.write` via bb_execute fails with Unrecognized key signal (2026-09-11)

- **Where:** BB SDK `files.write` invoked from bb-mcp codemode (`bb_execute`) on 0.42.x.
- **Symptom:** Calls with `{ path, content }` fail with `Unrecognized key: "signal"` because the sandbox injects an `AbortSignal` into SDK args.
- **Resolution (bb-mcp 0.4.0):** this was a bb-mcp bug, not BB — the sandbox injected `signal` into every object arg. Injection is now restricted to SDK methods that declare `signal?: AbortSignal`, so `bb.files.write({ path, content })` works. No upstream issue needed.

### `threads.spawn` silently drops explicit execution fields without `executionInputSources` (2026-09-11)

- **Symptom:** `threads.spawn({ providerId: "claude-code", model: "claude-fable-5-1", reasoningLevel: "high", permissionMode: "full", ... })` accepted the call but ran on the project default (acp-devin / swe-2) — the fields were silently ignored. They only take effect when `executionInputSources` marks each one `"explicit"` (e.g. `{ providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" }`).
- **Ask:** reject explicit fields without a source marker, or default supplied fields to explicit — silently running the wrong provider is a costly footgun for automation.
- **Status:** not filed. Suggested title: `threads.spawn ignores providerId/model unless executionInputSources marks them explicit`.

### Plugins cannot observe undeclared stored settings (2026-09-12)

- **Symptom:** bb-mcp 0.4 removed the legacy scope/ceiling settings (`projectIds`, `hostIds`, `providerIds`, `permissionMode`, rate limits). Upgraded installs silently gain owner-level access, and there is no API to detect it: `bb.settings.define` only serves declared keys and `plugins.getSettings` filters values to the current schema.
- **Ask:** let a plugin read its own stored-but-undeclared setting keys (or a `storedKeys` list) so migrations can warn or adapt.
- **Status:** not filed. Suggested title: `Expose stored-but-undeclared plugin setting keys for migration checks`.

### Host directory listings and file reads do not report symbolic links (2026-09-13)

- **Where:** `bb.sdk.hosts.directory` (host daemon listing) and `bb.sdk.files.read` on BB 0.42.x.
- **Symptom:** The daemon lists a symlink under its target's kind (`file` or `directory`) with no link flag or target, and a file read follows the link without saying so. The editor plugin can mark links only for workspaces on the local host, where it reads the directory itself; on a remote host they show as plain entries.
- **Ask:** add `isSymbolicLink` (and ideally the link target, plus a broken marker for a dangling link) to directory entries, and a `symlinkTarget`/`realPath` to file read results, the way VS Code's file stat carries a `SymbolicLink` type bit alongside `File`/`Directory`.
- **Status:** not filed. Suggested title: `Report symbolic links in host directory listings and file reads`.

### `threads.send` racing a queue-drain turn start returns HTTP 500 (2026-09-13)

- **Where:** BB 0.43.1, plugin SDK `threads.send` (`mode: "queue-if-active"`)
  issued while a queued message was draining onto the same thread.
- **Symptom:** the send fails `HTTP 500` with
  `ThreadLifecycleEventNotAppliedError: no transition for run.started from status active`.
  The dispatch resolved as a turn start while the drain's `run.started` had
  already flipped the thread to `active` inside the same window.
- **Ask:** queue or re-resolve the send instead of 500ing — the caller cannot
  distinguish "permanently refused" from "lost a sub-second race", so every
  queued-mode sender needs its own uncertain-state handling.
- **Observed by:** the questions plugin's outbox marked the submission
  `uncertain` and kept the frozen snapshot, so no data was lost.
- **Status:** not filed. Suggested title: `Queue a send that loses the race
  with a queue-drain turn start instead of returning 500`.

### Codex `thread/resume` does not apply updated `developerInstructions` (2026-09-13)

- **Where:** BB 0.43.1 `provider-codex` → codex app-server `thread/resume`.
- **Symptom:** BB recomposes per-turn instructions (including
  `bb.agents.configure` dynamic contributions backed by
  `thread_plugin_metadata`) and the bridge sends them as
  `developerInstructions` on `thread/resume`, but the resumed codex session
  keeps its original context — the rollout gains no new developer item and the
  model cannot see post-start instruction updates.
- **Impact:** per-thread plugin instructions (via `bb.agents.configure`) only
  reach Codex at `thread/start`; updates set later never surface.
- **Status:** not filed. Suggested title: `Apply updated developerInstructions
  on thread/resume (or document that resume keeps the original context)`.

### Thread-header menu action slot for plugins (2026-09-13)

- **Where:** BB 0.43.1 / SDK 0.4.87, the thread header's ellipsis menu
  (`ThreadActionsMenu`), built from host state only.
- **Ask:** a `threadHeaderMenuAction` (or `threadActions`) slot with the same
  `{ threadId, projectId }` context as `commandPaletteAction`, rendered as
  items before the separator and reused by BB's own sidebar row menu, so the
  Threads plugin can add "Snooze…" and "Unsnooze" where users look first.
- **Workaround:** the sidebar plugin offers snooze in its own row menu and
  hover control; `experimental_threadHeaderAction` would add a separate
  header button, not a menu entry.
- **Status:** not filed. Suggested title: `Add a plugin slot for thread
  header menu actions`.
