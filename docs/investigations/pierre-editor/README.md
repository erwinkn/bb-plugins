# Pierre editor and editable diff feasibility

Investigation date: 2026-09-07. BB 0.42.1, Plugin SDK 0.4.47, editor at `36125a7`, Pierre Diffs 1.4.1.

A production editable diff tab is feasible as plugin work. I recommend adding it to `erwin-editor`, with shared file sessions and the existing Monaco editor available. Replace Monaco only after a separate test phase proves input quality and the user accepts the language-service changes.

BB already uses Pierre for its built-in read-only diffs. Its `experimental_diffRenderer` slot supports replacement of diff bodies today. It does not give a renderer enough context to save files safely. Editing inside that viewer needs an upstream contract change. Replacing the whole built-in Git panel is a larger upstream change, separate from replacing its renderer.

This investigation changed only local documentation and compile-probe files. It did not change an installed plugin or run a save, stage, revert, commit, push, or PR operation.

## Evidence and limits

The installed executable reports BB 0.42.1. The editor's installed source is `path:/Users/erwin/Code/bb-plugins/plugins/editor`, not a Git installation. It was left as found. The package pins SDK 0.4.47 and Monaco 0.56.0. The current worktree was clean at the start.

I read the installed SDK declarations, installed frontend bundles, installed server transport and host-daemon code. [identity.json](identity.json) records the paths and SHA-256 hashes. For readable BB source, I also used the local BB source checkout at `/tmp/bb-dictation-inspect-0906`, commit `accd5595926b080a1e17d1ea9b2fa2d7d0505ac6`. That checkout is supporting evidence, not proof of the installed version. The important renderer props, Git target semantics and watch bridge were checked in the installed bundles too.

I read the [Conductor report](/Users/erwin/.bb/personal-workspaces/env_48cf93f8hr/conductor-analysis/README.md). Its 1.3-era reconstruction is evidence of a working integration design, not production source or proof of the current API. I checked the published 1.4.1 package from the [npm registry](https://registry.npmjs.org/@pierre/diffs/1.4.1). It was the latest version returned during this investigation. The public [documentation](https://diffs.com/docs) exceeded the web reader's size limit, so exact API claims below use the published declarations and JavaScript. See also the [upstream repository](https://github.com/pierrecomputer/pierre).

The isolated probe passed TypeScript checking and browser bundling. No browser, physical mobile, IME, remote-host, filesystem-watch or live BB editing test ran. Those remain release gates. Source inspection establishes API feasibility; it does not establish input quality or production reliability.

## Current editor

The useful unit to preserve is the workbench and save system, not just its text renderer.

| Area | Current implementation and effect on the proposal |
| --- | --- |
| Entry points | [app.tsx](../../../plugins/editor/app.tsx:155) registers a file opener, an existing-thread Files action, a New thread Files action and palette commands. File links, file search and `bb thread open` can reach the opener. It does not register a diff renderer. |
| File access | [server.ts](../../../plugins/editor/server.ts:305) resolves workspace, host and thread-storage sources. It confines paths and passes the host to `bb.sdk.files`. Text reads have an 8 MiB edit limit. Preserve these boundaries. |
| Saves | [EditorPane.tsx](../../../plugins/editor/components/EditorPane.tsx:118) serializes saves, uses `expectedSha256`, keeps edits made during a write dirty, and offers reload or explicit overwrite after conflict. Reload checks that typing did not occur during the read. Format-on-save runs through Monaco. |
| Dirty state | A Monaco alternative version identifies the saved state. Undo to that version can mark the buffer clean. This must become a renderer-independent content/session state. Models are disposed when changing files. There is no persisted draft store. |
| Navigation | [Workbench.tsx](../../../plugins/editor/components/Workbench.tsx:214) guards internal navigation with Save and open, Discard and open, or Cancel. It checks dirty state again after save. File history, quick open, tree actions and view state must survive the change. Host tab close and component unmount are not covered by a public dirty-close guard. |
| Commands | [editor-commands.ts](../../../plugins/editor/lib/editor-commands.ts:84) directly calls Monaco actions. Save, quick open and tree toggle can be retained. Format, outline, go-to-line, folds, sort lines and the Monaco palette need adapters, replacement UI or explicit removal. |
| Theme | `experimental_useCodeTheme` supplies BB's theme document. The editor uses Shiki plus a Monaco theme adapter. Preserve `ThemePicker`, contributed themes and BB setting updates. Pierre can consume registered Shiki themes, but shadow-root CSS and editor chrome need separate mapping. |
| Mobile layout | The workbench switches at 420 px. The tree occupies the pane and selecting a file hides it. Desktop has a resizable tree. This verifies responsive layout code only. It does not prove touch editing, virtual keyboard or IME support. |
| Change detection | Done since the watch commit: a `bb.host` module watches each workspace root an open panel uses through `experimental_watch`, and the server publishes one `files-changed` realtime signal per batch. Open files re-read, the tree and the change list refresh, and a poll remains as the backstop. Before that, an agent edit was detected at save through the hash check or by manual reload. |
| Assets | The current server uses stable `/api/v1/plugins/<id>/http/monaco` routes. The README still describes a preview lease, but the implementation has moved past that. The loader imports code and workers on demand. Preserve the stable-route approach. |

Recent editor work is PR #8 and its review fixes. `git log --all -- plugins/editor` includes save ordering, stale async results, dirty-buffer navigation, hidden-file listing, symlink confinement and theme matching. These fixes are requirements for a rewrite. The live thread list also showed the idle Files editor continuation and an idle dedicated code-review investigation in `env_u6hu5phwvy`. That worktree had a local README change and no review plugin implementation in its file list. No other worktree was modified. Coordinate shared comments and review navigation before implementing a second review UI.

## BB integration choices

| Question | Dedicated side-panel tab | Replace BB's diff renderer |
| --- | --- | --- |
| Supported registration | `threadPanelAction`, `layout: 'flush'`, with JSON params and required `threadId`. Add a palette action and toolbar entry. | `experimental_diffRenderer`, selected through BB's renderer preference. One provider wins; `Original` delegates back to BB. |
| Scope | Plugin owns its file list, target selector, editor, save state and navigation. It is a closable action tab, not a new native fixed Git tab. | Changes file bodies reached through `DiffHost`, including environment diffs, timeline diffs and plugin `experimental_Diff` calls. It does not replace the surrounding list, header, target controls or native tab. |
| Data | Resolve the thread's environment, then call `environments.diffFiles`, `diffPatch` and `diffFile` through plugin RPC. | Receives only `patch`, `path`, `view`, `overflow`, `showLineNumbers`, optional complete old/new text and `Original`. |
| Editable working files | Feasible with a separate live read and its hash, followed by `files.write`. | No environment/host identity, target type, hash, editability flag, save callback or refresh callback. A path and full text cannot establish a writable target. |
| Staged and commit views | Commit and branch views are supported. Separate index and unstaged targets need a plugin host adapter or new SDK targets. | Inherits the caller's supplied patch, but cannot identify whether it is a historical snapshot or a live file. Keep read-only without a new contract. |
| Links | JSON action params can carry environment, target, path and line. `openThreadPanel` opens the same plugin's action. `experimental_FileLink` and file-open navigation reach live files. | Retains BB's outer navigation. The renderer slot does not provide a semantic diff deep-link target or a way to redirect native Git-tab navigation. |
| Host actions | Plugin must implement any new staging or revert controls and their refresh policy. | Existing outer controls stay with BB. BB's selection-to-chat callback goes to `Original` but is not passed to the replacement. A custom renderer can lose this behavior. |

Exact installed frontend evidence: [DiffHost bundle](/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/app/dist/assets/DiffHost-BdhrSvIl.js) constructs the replacement props listed above. Its `Original` receives `onSelectionAddToChat`; the replacement does not. [BbDiff bundle](/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/app/dist/assets/BbDiff-DQbinN6o.js) renders Pierre `FileDiff`, sets split/unified display, theme and line selection, and validates complete text against the patch before context expansion. Readable counterpart: [DiffHost.tsx](/tmp/bb-dictation-inspect-0906/apps/app/src/components/code/DiffHost.tsx:57).

The installed [SDK app declaration](/Users/erwin/Code/bb-plugins/plugins/editor/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts:647) confirms the narrow renderer contract. `useBbContext` or a route lookup cannot repair it reliably: multiple panes and historical timeline diffs can share the same ambient thread. A trusted content script that replaces DOM nodes, reads React internals or calls private caches would be fragile. Do not use that route.

### Git data and mutations

The public environment target union contains `uncommitted`, `branch_committed`, `all` and `commit`. It has no `staged` or `unstaged` target. `diffPatch` is a read operation despite its name. It returns patch text and truncation status; it does not apply a patch.

The installed daemon implements `uncommitted` as `git diff HEAD`, plus untracked-file handling. It therefore combines staged and unstaged changes relative to HEAD. `branch_committed` compares merge base to HEAD. `all` compares merge base to the working tree. `commit` uses `git show --format= --no-ext-diff <sha>`. The readable [workspace implementation](/tmp/bb-dictation-inspect-0906/packages/host-workspace/src/workspace.ts:1848) agrees with the installed `daemon-bundle.mjs`.

The [SDK environment implementation](/tmp/bb-dictation-inspect-0906/packages/sdk/src/areas/environments.ts:264) calls BB's environment diff routes. The installed `server/dist/start-server.js` contains the same transport. This is a real supported data path, not an inference from method names. `diffFile` returns content and encoding, not a CAS hash. Always obtain the writable side and hash from `files.read`; compare it with the diff snapshot before enabling edit.

No public environment stage/unstage/revert methods appear in SDK 0.4.47. No such controls were found in the inspected native Git diff components. Pierre's accept/reject hunk UI is not Git index support. For separate staged views, a plugin host module could execute bounded Git commands on the correct host: index-to-worktree with `git diff`, HEAD-to-index with `git diff --cached`, and index content with `git show :path`. This is plugin-owned Git integration, not a native renderer hook. An upstream API is preferable if BB and several plugins need it.

Do not enable editing of index or commit snapshots as if they were working files. Offer an explicit open-working-file action. Keep binary, deleted, conflicted, truncated and unsupported files read-only at first. Treat rename paths and new files explicitly. Staging or reverting a hunk needs the exact disk/index generation and a stale-patch check. A draft is not the current disk diff. First ship saves; add Git mutations only with explicit target and conflict tests.

### File watches and panel lifecycle

A watch does not require a new BB API. SDK 0.4.47 has `ExperimentalHostRpcContext.experimental_watch`. It emits changes, rescan-required and watch-error events and has a disposable subscription. The installed `bb-plugin-host-worker.mjs` connects it to the host watcher. Add a host module to run on the workspace host, forward signals through the plugin server and publish invalidation to clients. Re-read after events; never trust an event as the new file contents. On reconnect or rescan-required, compare the file hash again. Poll on focus as a fallback.

Keep dirty drafts when a watch reports a change. Reload clean sessions only after checking their current generation. Store drafts independently of mounted panes because BB can unmount panel content. A shared session key must include host, environment/root and path. Keep the diff baseline identity separate from the writable file session. This also prevents two tabs from independently overwriting the same draft.

BB does not expose a tab dirty marker, close veto or retitle operation in the checked contract. Persisting drafts can prevent loss without those APIs. Better host close UX belongs upstream. File opener props also do not carry the line location accepted by the general file-navigation API; verify line reveal through the opener before promising full deep-link parity.

## Pierre 1.4.1 as an editor

The current factory is `(editorType, options, editStateKey) => new Editor(editorType, options, editStateKey)`. `onItemEditChange` receives `(event, item)`, with text in `event.file.contents`. `onItemEditComplete` receives a completed session and accepts an accept/reject decision. Completion means ending an edit session, not saving to disk. Do not wire it to automatic save.

| Capability | Finding and implementation effect |
| --- | --- |
| Plain files and diffs | `CodeView` supports file and diff items with `edit: true`. Diff editing changes the new side. Split and unified are options. Build complete diffs from full sides for editing; do not edit a partial patch as a whole document. |
| Undo and drafts | `Editor` has undo/redo and `getFile`. `getEditStateKey` and `EditStateManager` retain draft/history in memory. These are not durable storage. Keep save generations, hashes and persistence in the plugin. Do not feed every change directly back into controlled items; the API warns of update loops. |
| Find/replace | Current search code has find, replace, replace-all support through edit application, case, whole-word and regex options. This is present in 1.4.1, not an assumed Monaco-only gap. Test regex cost, multiline text and keyboard ownership. |
| Editing input | Source handles beforeinput, paste, composition, selections and Safari-specific layout. It uses contentEditable in a shadow root. Presence of code is not proof of mobile or IME correctness. Test CJK, accents, emoji, dictation, touch selection and keyboard resize on physical devices. |
| Large files | Virtualized rendering and editor viewport integration are present. The full document, diff computation and search still cost memory/time. Keep the 8 MiB limit initially, plus line-length and diff-size limits. Test a single long line as well as many short lines. |
| Syntax | Shiki JS and WASM engines are supported, with worker APIs. JS avoids WASM initialization but must be tested for grammar behavior. Worker output, grammar chunks and WASM must load from authenticated same-origin plugin routes. |
| Language services | No equivalent of our configured TS/JS, JSON, CSS and HTML service stack was found. Marker and edit-prediction APIs do not provide semantic completion, hover, signatures, definitions, rename, outline or formatting. These need adapters/services or continued Monaco use. |
| Other Monaco features | Minimap, language folding, sticky scroll, Monaco palette and existing command IDs have no direct verified replacement. Some line movement and comment commands exist. Rebuild or hide unsupported controls; do not keep inert menu items. |
| Theme | Use BB's current code-theme document and CSS palette, register it with Pierre, and update light/dark mode. Test selection, search, added/deleted rows and shadow-root typography. Do not assume using the same theme name makes editor chrome match. |
| License | The published package declares Apache-2.0 and includes `LICENSE.md`. Keep license and applicable notices in distribution. Audit bundled dependency notices too. Do not copy Conductor's application code. |

The existing Monaco language services are limited to open-file context, so they are not a full project language server. They are still useful functionality that a Pierre-only replacement would lose.

## Isolated probe and bundle cost

[probe.tsx](probe.tsx) checks the 1.4.1 factory, editable diff item, change event and completion callback against real package types. [measure.mjs](measure.mjs) bundles it with React external, ESM splitting, minification and an ES2022 target. It separately bundles a syntax worker. [measurement.json](measurement.json) contains the result.

The probe emitted 399 files totaling 11,145,474 bytes, or 2,121,723 bytes when each file was gzip-compressed. The entry file alone was 791,974 bytes, gzip 229,145. The separate worker was 834,966 bytes, gzip 302,010. These are build outputs, not measured first-open traffic. Entry imports add chunks, and most language/theme chunks are lazy. The package archive's unpacked size is 7,388,009 bytes; that number excludes dependencies and is not a browser payload estimate.

This proves the current API compiles and the package can be bundled for the browser. It does not prove mounting, saving, mobile input or BB asset delivery. A production build should restrict grammar/theme loading where practical and retain a separate lazy asset bundle. Do not import Pierre directly into BB's single-file plugin entry and assume it will reuse BB's private Pierre copy. Duplicate custom-element registration and worker/highlighter globals need a mounted compatibility test, especially because BB's renderer may use a different Pierre version.

To repeat in a disposable directory, copy the probe and measurement script there, install the exact versions below, then run the commands. This does not require plugin installation.

```sh
npm install --ignore-scripts --no-audit --no-fund @pierre/diffs@1.4.1 shiki@4.4.3 esbuild@0.28.2 react@19.2.3 react-dom@19.2.3 typescript@5.9.3 @types/react@19.2.14 @types/react-dom@19.2.3
npx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --jsx react-jsx probe.tsx
node measure.mjs
```

The probe declares no worker provider and is not a finished app. The worker build checks packaging only. Actual BB CSP headers, authenticated worker fetches, WASM execution and Connect behavior remain untested. Existing BB and editor use of Pierre/Shiki/workers is supporting evidence, not a substitute for those tests.

## Implementation phases

1. Extract shared sessions before changing the engine. Add `lib/file-session.ts` and focused tests. Move content, saved hash, save queue and reload/conflict rules out of `components/EditorPane.tsx`. Add durable draft storage with a versioned key and recovery UI. Adapt `Workbench.tsx` and `lib/editor-commands.ts` to engine capabilities. Preserve current Monaco behavior. Test simultaneous tabs, typing during save, failed save, undo to saved text, rename/delete and unmount recovery.
2. Add an isolated Pierre engine behind an explicit local development choice. Add `components/PierrePane.tsx`, `lib/pierre-loader.ts` and a separate asset entry/build path in `scripts/stage-assets.mjs` and `server.ts`. Pin 1.4.1 initially. Reuse `ThemePicker.tsx`, `Toolbar.tsx`, `lib/themes.ts` and `lib/bb-tokens.ts`. Test mounting beside native BB diffs, lazy worker URLs, theme changes, find/replace, IME, selection, undo and large files. Keep Monaco as the default until this passes.
3. Add `components/DiffWorkbench.tsx`, `components/EditableDiffPane.tsx` and `lib/diff-target.ts`. Register a flush thread action in `app.tsx`. Add typed, bounded RPC reads in `server.ts` for target/file lists and complete sides. Start with editable uncommitted files and read-only commit/branch views. Use `files.read` for the live new side and hash. Add previous/next file, split/unified, open-file and save actions. Mark unavailable/binary/truncated files clearly. Persist target params, validate them on load, and keep scope changes from resetting drafts.
4. Done: a host watch module, its manifest entry and client invalidation. Tested on the local host with creation, edit and deletion, and with a symlinked root; remote hosts, disconnects and agent edits during typing still need a device test. Add separate staged/unstaged views only after a host Git adapter or upstream API exists. Defer stage/revert controls until stale index/disk and partial-hunk tests pass. Commit snapshots stay read-only.
5. Extend BB upstream if editing inside native diffs remains a priority. Add semantic origin, target/revisions, editability, live read/save/refresh and selection-to-chat contracts to the renderer. Apply it at `DiffHost` and its environment/timeline callers. Historical callers must default to read-only. Update SDK types, runtime forwarding, Plugin Guide and `docs/api_to_audit.md`. A renderer plugin can then use the same session layer without inferring context from the route.
6. Decide whether to replace Monaco after the feature comparison and real device tests. A Pierre-only editor is technically feasible, but full parity requires separate language-service work. Keep both engines if completion, formatting, outline and navigation remain important. Do not turn a diff-view feature into an unplanned language-server project.

Release validation must cover desktop BB, narrow desktop panes, physical iOS and Android, local and remote workspaces, new/deleted/renamed/binary files, CRLF and missing final newline, initial and merge commits, partially staged files, stale hashes, failed writes, draft recovery and two views of the same file. Measure first-open bytes, typing latency, diff recomputation and memory. Use SDK tests for contracts and real BB checks for lifecycle and delivery. Apply the repository's normal branch-install and draft-PR workflow only in a later authorized implementation task.

## Upstream requests

The root [README](../../../README.md) records the requests locally. No external issue was filed.

- Extend `experimental_diffRenderer` with semantic source/target identity and optional editing capabilities. Include host-owned refresh and selection-to-chat actions. Preserve read-only fallback for timeline snapshots and callers with patch-only data.
- Add explicit staged and unstaged targets plus index content. If BB exposes stage/unstage/revert actions, require generation checks and return conflict outcomes. Do not overload the current read-only `diffPatch` method.
- Add plugin tab dirty state, close negotiation, retitle and location delivery to file openers. Durable plugin drafts remain necessary even with close negotiation.

The recommended first deliverable is the dedicated editable diff tab. It has a supported entry point and sufficient data access, and it can preserve the current editor while the Pierre engine is tested. Native diff editing is feasible after the upstream contract change. A full Monaco overhaul is feasible only with explicit acceptance or replacement of the lost language and editor features.
