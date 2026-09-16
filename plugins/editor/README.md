# bb-plugin-editor

A Pierre file editor for BB with **Files** and **Changes** tabs that share one
code theme, one file buffer and one save queue. Plugin id: `editor`.
Disable the bundled `monaco-editor` plugin before installing this one.

## Files

Open the right panel, select **+**, then **Files**. The tree supports quick
open (`⌘P`), new files and folders, rename, delete, and opening a file in its
own tab; its side, width and last file are retained. The New thread screen has
the same tab for the project's default checkout. File links this plugin claims
open in the same editor. `⌘S` saves, `⌘F` finds.

A symbolic link shows VS Code's ⤷ badge at the end of its row, and its hover
text names the target; one whose target is missing shows ? instead and opens
to a notice naming the missing target. The link is otherwise the file or
folder it points at: opening it reads the target and saving writes through to
it. Links whose target lies outside the workspace are
not listed. On a remote host BB's directory listing does not report links, so
they show as plain entries there.

Icons come from `@pierre/trees`, the set BB's own trees use, tinted by file
kind with the `theme` plugin's roles: TypeScript and JavaScript blue, Rust,
Python and Go amber-orange, stylesheets purple, JSON and YAML amber, shell and
tooling files teal, images cyan, Markdown and plain text untinted. Each tint
is `var(--bbp-<role>, var(<BB token>))`, so without a BB Color palette the
icons fall back to BB's own tokens in both modes. The editor uses
Geist Mono and Shiki highlighting through Pierre; there are no language
services (completions, diagnostics, folding, minimap). **Theme…** in the Files
menu and **Extensions → Editor → Code theme** save one selection for both
tabs. **Follow BB** (default) uses BB's current code colors; the other choices
(Pierre, GitHub, VS Code, Catppuccin, Tokyo Night, …) use their light or dark
variant to match BB's mode and never change BB's global theme. To change BB's
global code theme (and give the app a colored palette at the same time), pick
one of the `theme` plugin's entries in Settings → Appearance; with **Follow
BB** the Files, Changes and diff views then use that pair through
`experimental_useCodeTheme`. The editor itself contributes no `bb.themes`.

A `.md` file opens as a rendered preview; the pencil button switches to the
editor and back, per file, for the page's life. The preview follows the shared
buffer. For a thread's workspace or storage, BB's document binding resolves
relative images and links from the document's directory. Elsewhere (a host
path, or a project checkout with no thread) relative images load through a
short-lived lease for the workspace root; relative links to files under the
root open in the same pane. In Changes, the eye button in the file row
renders the new side, and its links open in the Files tab.

HTML files (`.html` and `.htm`) open with BB's built-in preview in file tabs.
The same pencil button switches to the editor. This preview shows the saved
file and reloads after a save; Markdown continues to show unsaved edits.
Other text files open in the editor. Opening HTML from the workspace tree
uses a separate file tab so BB supplies a preview for that exact file.
If BB does not supply a preview, the file stays in the editor.

## Changes

Open **+ → Changes** or run **Editor: open changes**. Pick a file and a
comparison: **Uncommitted** (working tree vs HEAD, including untracked
files), **All changes** (working tree vs the merge base with a branch), **All
commits** (HEAD vs that merge base, read-only) or **a commit** (vs its parent,
read-only). The scope menu lists branch commits newest first, ten at a time
with **Show more**, and **Find commit…** accepts a hash. Panel links accept
`{ target, path }` with target types `uncommitted`, `all`, `branch_committed`
(optional `mergeBaseBranch`) and `commit` (`sha`).

Side-by-side or unified, word wrap, unchanged lines, file navigation and
refresh are in the toolbar. Narrow panels use unified and switch between list
and comparison. For a working-tree comparison the new side is editable and
uses the same session as Files; a focused view owns editing and other views
follow. Deleted, binary, oversized and conflicted files are read-only.

**Revert.** Hover changed lines for the revert control at the right edge, or
use **Revert hunk at cursor** in the file menu; Pierre applies it as an
undoable edit. Right-click (long-press on touch) a list row to **Revert** a
modified file, **Restore** a deleted one, or **Delete** a new one; the list
marks these with a green **A** and a red **D**. Deleting a new file or
replacing unsaved edits asks first. Whole-file actions write the selected
comparison's left side (HEAD or the merge base), check both the baseline and
the live hash, use CAS writes, and leave the Git index alone. Renames, copies,
type changes, binary and oversized files have no whole-file action; restore
does not recover the executable bit; BB's remove API has no hash precondition,
so deletion checks the hash immediately before a non-recursive remove.

## BB's own diffs

The plugin registers `experimental_diffRenderer`, so the diffs BB draws from
a patch — timeline tool rows, the environment diff panel's bodies (⌘D), other
plugins' `experimental_Diff` — render with this viewer at the plugin's theme
and font. BB keeps its frame (row header, scope picker, file list) and its
split/wrap/line-number choices. These diffs are read-only: the slot carries a
patch and, in the panel, both sides, but no environment or save context. When
the sides agree with every hunk, the separators expand unchanged lines from
them; timeline rows carry no sides. Non-patch text, a render failure, or the
**Draw BB's diffs** setting hand the request back to BB's renderer.

## Saves and drafts

A save compares the file's hash with the last read; if the file changed, the
save stops with Reload or Overwrite. Typing during a save is kept. Undo back
to the saved text clears the unsaved state; undo history lasts for the mounted
editor. Unsaved drafts are stored in this browser: a draft of the current disk
version is restored on open, one of an older version waits for an explicit
restore or discard, and the UI says when storage cannot keep one.

The host module keeps a native watch on each workspace root an open panel
uses; each batch reaches the page as one realtime message that re-reads the
named open files, reloads the tree on add or remove, and refreshes the change
list. A clean file takes the new text; a dirty one keeps its edits and reports
the changed base. A poll every 30 s (5 s for an unwatchable root) and on focus
is the backstop; a lost connection or restarted host worker re-reads
everything.

## Settings

Extensions → Editor:

| Setting | Default | Notes |
| --- | --- | --- |
| Font size | 12 | 9 to 24; Geist Mono with BB monospace fallback |
| Code theme | Follow BB | Shared by Files, Changes and BB's diffs |
| Wrap long lines | off | Shared by Files and Changes |
| Show line numbers | on | Shared by Files and Changes |
| Auto save | afterDelay | `off` or `onBlur` too; delay is 400 ms |
| File tree side | right | Also the Changes list side |
| Draw BB's diffs | on | Off hands timeline and panel diffs back to BB |
| Syntax highlighting size limit (KB) | 1024 | Bigger files stay editable without syntax colors; 0 disables highlighting |
| Syntax highlighting line limit | 20000 | Files with more lines open without syntax colors |
| Editor size limit (KB) | 8192 | Bigger files open read-only; the server never sends more anyway |
| Editor line limit | 2000000 | Files with more lines open read-only as plain text |
| Editor line-length limit | 4000000 | A file with a longer line opens read-only as plain text |
| Word-wrap line-length limit | 50000 | Longer lines are never wrapped; wrapped long lines are quadratic to edit |

Files open in three tiers measured against the real Pierre bundle: full editor,
editor without syntax highlighting (highlighting is what makes a multi-MB file
slow to become editable), and read-only plain text with an "Open in editor
anyway" escape. See `lib/editor-limits.ts` for the measurements behind the
defaults.

## Install and develop

```sh
cd plugins/editor
npm ci --include=dev --include=optional
npm run build
npm run check:assets
npm run typecheck
npm test
```

Install with
`bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin editor`
and follow the repository's draft-PR and branch-install procedure for changes.
`assets/pierre/` contains the committed browser editor, worker, language and
theme chunks, font, and license notices. Installation and first use serve
these files without rebuilding them. esbuild is a development dependency.

After changing `pierre-bundle/`, the asset build script, or its dependencies,
run `npm run build:pierre` and commit the generated changes too.
`npm run check:assets` rebuilds into a temporary directory and checks that its
output matches the shipped files. `bb plugin dev` rebuilds the app; run the
Pierre build separately when its inputs change.

### Checking the UI from a driven browser

Pierre's `CodeView` and `FileDiff` render from `requestAnimationFrame`. A tab
that reports `document.visibilityState === "hidden"` (a background tab, an
occluded window, most automation sessions) never fires it, so a surface sits at
`data-pierre-status="loading"` with an empty host for as long as the tab stays
hidden, however long you poll. It is not a plugin fault and it does not
reproduce for a person looking at the page.

Before reading `data-pierre-status`, the rendered rows, or the "Loading the
comparison…" overlay, force a frame: take a screenshot, bring the tab to the
front, or confirm with

```js
new Promise((r) => requestAnimationFrame(() => r(document.visibilityState)))
```

that the promise resolves. A check that reports "stuck loading" without doing
this is reporting the browser, not the plugin. This cost an hour of bisecting
once.

## Layout

- `app.tsx` registers the file opener, Files, Changes, palette actions and the
  diff renderer.
- `components/PierreSurface.tsx` wraps the lazy vanilla Pierre runtime
  (`pierre-bundle/`, built by `scripts/stage-assets.mjs`) for a pane;
  `PierreDiffBlock.tsx` wraps Pierre's plain `FileDiff` for `BbDiffRenderer.tsx`,
  with `lib/bb-diff.ts` parsing BB's patch and checking its sides.
- `Workbench.tsx`/`EditorPane.tsx` are Files; `DiffWorkbench.tsx`/
  `EditableDiffPane.tsx` are Changes. They share `Toolbar.tsx`,
  `ResizeHandle.tsx` and `MarkdownPreview.tsx`.
- `lib/file-session.ts` holds buffers, hashes, save queues, drafts and view
  ownership. `lib/pierre-theme.ts` adapts BB's code theme; `lib/file-icons.ts`
  resolves `@pierre/trees` icons and maps their tokens to colour roles.
- `server.ts` resolves sources, reads and writes through the SDK, lists and
  reads Git comparisons, and serves the Pierre assets. `host.ts` watches files.

Upstream needs are recorded in the repository README.
