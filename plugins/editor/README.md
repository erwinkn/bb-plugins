# bb-plugin-erwin-editor

A Pierre file editor for BB with **Files** and **Changes** tabs. Both tabs use
one predefined code theme and share the same file buffer and save queue.
The canvas, controls, and menus use BB's current interface theme.
Plugin id: `erwin-editor`. Disable the bundled `monaco-editor` plugin before
installing this one.

## Files

Open the right panel, select **+**, then **Files**. The file tree supports
quick open, new files and folders, rename, delete, and opening a file in its
own tab. Its position, width, and last selected file are retained. The New
thread screen also has a Files tab for the project's default checkout.

File links claimed by this plugin open in the same editor. Use `⌘S` to save,
`⌘F` to find text, and `⌘P` for quick open. The toolbar has file history,
path actions, find, and display settings. The editor uses Geist Mono, quiet line
numbers, and compact diff separators. Choose a predefined theme from **Theme…**
in the Files menu or **Extensions → Editor → Code theme**. Both controls save
the same selection for Files and Changes. The default, **Follow BB**, uses BB's
current code colors. Other choices include Pierre, GitHub, VS Code,
Catppuccin, and Tokyo Night. Each uses its light or dark variant to match BB's
mode. A theme without a variant uses Pierre for that mode. Plugin theme
selection does not change BB's global theme.

Conductor's default `conductor-dark` and `conductor-light` themes are custom
palettes defined in its app bundle. This plugin uses bundled predefined themes
instead; no Conductor palette is included.

The editor uses Pierre's text editing and Shiki syntax highlighting. It does
not provide Monaco's completions, diagnostics, hover information, symbol
navigation, rename, formatting, code folding, sticky scroll, minimap, or
language services. Commands and
settings that depended on those features have been removed.

## Changes

Open **+ → Changes**, or run **Editor: open changes** from the command palette.
Choose a file in the change list and select a comparison:

- **Uncommitted:** the working tree against HEAD, including staged and
  unstaged changes and untracked files.
- **All changes:** the working tree against the merge base with a branch.
- **All commits:** HEAD against that merge base; read-only.
- **A commit:** that commit against its parent; read-only.

The scope menu lists branch commits, newest first, with subjects and short
hashes. It shows ten first; **Show more** and **Show less** expand and collapse
the list without closing the menu. **Find commit…** accepts a hash directly.
The list comes from BB's workspace status relative to the comparison base, so
it also works without a published PR. As in BB's own status, commits already
represented in the base branch are omitted. Loading failures offer Retry.
Arrow keys, Home, End, and Escape work in the menu. Long subjects truncate,
with the full returned subject and hash available in the tooltip.

The tab offers side-by-side and unified layouts, word wrap, unchanged lines,
file navigation, refresh, and opening the working file in Files. A comparison
with no changed lines shows file contents, so pure renames and empty added
files can still be edited. Narrow panels
use the unified layout and switch between the list and comparison.

For a working-tree comparison, edit the new side and save with `⌘S` or the
save action. Edits use the same session as Files. A focused view owns editing;
other views show its current text. The old side is always read-only.
Deleted files, binary files, type changes, oversized comparisons,
and detected conflict contents cannot be edited in Changes. A file that moves
on disk during loading must be refreshed before editing.

Panel links accept `{ target, path }`, where `target` has type `uncommitted`,
`all`, `branch_committed`, or `commit`. Branch targets may include
`mergeBaseBranch`; commit targets require `sha`. The tab validates these values.
BB's built-in diff tab remains available.

### Revert actions

Hover changed lines and select the **Revert** control at the right edge of the
comparison, or place the cursor in a hunk and choose **Revert hunk at cursor**
from the file toolbar menu. The control appears only beside changed lines and
reverts the hunk that contains them. Pierre applies the change as an edit:
Undo works, and the normal save or auto-save setting applies. Reverting all
lines in a new file leaves an empty file.

Right-click a file in the Changes list (or press the Menu key or Shift+F10 on
a focused row) to **Revert** a modified file, **Restore** a deleted file, or
**Delete** a new file. The list marks new files with a green plus and deleted
files with a red minus. New-file deletion
always asks for confirmation. Replacing unsaved edits also asks first. Whole
file actions take effect on disk immediately and update shared editor sessions.

These actions restore the left side of the selected working comparison: HEAD
for Uncommitted, or the merge base for All changes. Saved commit comparisons
stay read-only. The Git staging area is unchanged; staged changes can remain
in Git even after the working file is restored. Renames, copies, file type
changes, binary files and oversized files do not have revert actions yet.
Restoring a deleted text file restores its contents, not its previous executable
permission bits.

Revert checks both the baseline hash and the live file hash. Writes use CAS;
restore creates only an absent path. Actions share the session save queue and
keep text typed while a remote action runs. Deletion stops queued auto-save
from recreating the file. BB's remove API has no hash precondition: deletion
checks the hash immediately before a non-recursive, root-confined remove, but
cannot make that check and removal atomic against an external process.

## Saves and drafts

Saves compare the file's content hash with the last read hash. If another
process changes the file, the save stops. Reload the file or explicitly choose
to overwrite it. A save in progress does not discard text typed after it began.
Undo back to the saved text clears the unsaved state. Undo history lasts for
the mounted editor; switching files starts a new history.

Unsaved drafts are stored in this browser. A draft from the current disk
version is restored when the file opens. A draft from an older version is kept
for an explicit restore or discard decision. The UI reports when browser
storage cannot retain a draft. Drafts do not sync between devices.

Clean open files check for external changes on focus and at intervals while
BB is visible. Files with unsaved edits keep those edits and report the changed
base. BB does not yet expose tab-close negotiation to plugins, so durable
drafts provide recovery when a tab or window closes.

## Settings

Extensions → Editor:

| Setting | Default | Notes |
| --- | --- | --- |
| Font size | 12 | 9 to 24; Geist Mono with BB monospace fallback |
| Code theme | Follow BB | Predefined theme shared by Files and Changes |
| Wrap long lines | off | Shared by Files and Changes |
| Show line numbers | on | Shared by Files and Changes |
| Auto save | off | `onBlur` or `afterDelay`; the delay is one second |
| File tree side | right | Also controls the Changes list position |

Existing editor preferences are retained. The former `codePalette` preview
setting is replaced by `Code theme`, which starts at Follow BB.

## Install and develop

```sh
cd plugins/editor
npm install --include=dev
npm run build:pierre
npm run typecheck
npm test
bb plugin build
```

Normal Git installation:

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin erwin-editor
```

Follow the repository's draft-PR and branch-install procedure for changes.
Do not remove an existing installation to change its source: removal deletes
plugin state. See the repository README for source migration limits in BB.

`bb plugin dev` rebuilds the plugin app. The lazy Pierre bundle is separate.
The server builds `dist/pierre` on first use when it is missing or older than
its entry files, build script, package manifest, or lockfile. Run
`npm run build:pierre` to build it in advance. Runtime dependencies include
esbuild because Git installations build the assets on demand. If npm policy
blocks the esbuild platform binary, run the build command in the installed
plugin directory and resolve the reported installation error.

## Layout

- `app.tsx` registers file openers, Files, Changes, and palette actions.
- `components/PierreSurface.tsx` adapts the lazy vanilla Pierre runtime to BB's
  React UI. `pierre-bundle/` and `scripts/stage-assets.mjs` build its ESM assets
  and syntax worker. The lazy bundle does not include a second React runtime.
- `components/ui/` and `lib/portal-scope.ts` contain the BB 0.42.1 dropdown
  and responsive overlay source, shared with this repository's provider-usage plugin.
- `components/Workbench.tsx` and `EditorPane.tsx` provide the Files UI.
  `DiffWorkbench.tsx` and `EditableDiffPane.tsx` provide Changes.
- `lib/file-session.ts` holds buffers, file hashes, save queues, draft storage,
  and ownership shared by both views.
- `lib/pierre-theme.ts` adapts BB's active code theme. `lib/languages.ts`
  defines file patterns and grammar selection.
- `server.ts` resolves file sources, reads and writes through the BB SDK,
  lists and reads Git comparisons, and serves the Pierre assets.

## Upstream needs

BB needs tab dirty indicators, close negotiation, and file-tab retitling.
File removal needs an expected-hash precondition. Git discard needs a public
host-routed operation with explicit worktree/index scope, and revision reads
need file mode metadata to restore executable files.
Replacing BB's native diff renderer with safe editing also needs environment
and save context in that slot. Pierre needs public programmatic search commands;
the current adapter uses its keyboard command path.

See the [investigation](../../docs/investigations/pierre-editor/README.md) for
API evidence and the migration rationale. The [verification report](../../docs/investigations/pierre-editor/verification.md)
records installed checks and remaining device-test limits.
