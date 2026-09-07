# bb-plugin-erwin-editor

A Monaco editor for BB with a **Files** panel, syntax colors that match BB's
own code renderer, and TypeScript, JSON, CSS, and HTML language services.
Plugin id: `erwin-editor`. It replaces the bundled `monaco-editor` plugin;
disable that one before you install this one.

## What it adds

- **Files panel.** Open the right panel, select **+**, then **Files**. The
  editor sits next to a file tree (on the right by default, like Cursor and
  super.engineering; a setting moves it left). The tree collapses (`⌘B`),
  resizes by drag, and remembers its width and the last file per workspace.
  Hover the tree header or a folder for **refresh**, **new file**, and
  **new folder**; names are typed inline. Right-click a row for **Rename…**
  (inline) and **Delete…** (inline confirmation; folders report their file
  count). On the New thread screen, **Files** browses the project's default
  checkout. Hidden files and directories are listed, as in other editors;
  only VS Code's default excludes (`.git`, `.hg`, `.svn`, `.DS_Store`,
  `Thumbs.db`) are hidden. `node_modules` and symlinked directories appear
  collapsed and list one level at a time as you expand them. Workspaces on another host go through
  BB's own lister, which drops hidden entries.
- **Toolbar.** Back and forward through the files you opened, the path
  (click to copy), then `⋯` (save, discard, reload, open in new tab, copy
  paths, and toggles for line numbers, word wrap, minimap, auto save, format
  on save), find in file, and the tree toggle. Toggles persist as plugin
  settings.
- **Editor tabs.** BB opens claimed file types in this editor instead of its
  read-only preview: file links in chat, the panel file search, and
  `bb thread open`. The same toolbar and tree are there.
- **Quick open** with `⌘P` inside the editor or tree: fuzzy search over the
  workspace file list. `⌘` + click, or **Open in new tab** in the tree's
  context menu, opens a file as its own host tab.
- **One surface with BB.** Files tokenize with Shiki's TextMate grammars
  and BB's current VS Code theme document, the same inputs BB's preview uses,
  so token colors match BB's. The editor chrome (background, gutter, line
  highlight, widgets, scrollbars) takes BB's own surface colors, and icons
  are BB's Hugeicons at BB's size, so the editor reads as part of the panel.
  Like BB's preview there are no indentation or bracket guides, no bracket
  colors, and no current-line band (the active line number is the cue).
  Theme and light/dark switches apply live. The `⋯` menu's **Theme…**
  picker sets BB's code theme, so BB's previews, the diff view, and the
  editor all follow it. Its entries are dark/light pairs the plugin
  contributes to BB as app themes (they also appear in `bb theme list`):
  BB's own Pierre family (soft, vibrant) and Shiki's bundled VS Code themes,
  all with BB's default palette. Moving through the list previews the theme
  in the editor before BB switches.
- **Language services.** Completions, hover, signature help, go to
  definition, rename, formatting, and outline for TypeScript, JavaScript,
  JSON, CSS/SCSS/Less, and HTML. The TypeScript checker sees only the open
  file, so unresolved imports are expected; diagnostics default to syntax
  errors only (see settings). `.tsx` files use the TSX grammar and share the
  one TypeScript worker.
- **Safe saves.** `⌘S` writes the file with a content hash check. If the
  file changed on disk since you opened it, the save stops and offers
  **Reload** or **Overwrite**. Switching files with unsaved changes offers
  **Save and open**, **Discard and open**, or **Cancel**.
- **Editor polish.** Sticky scroll, smooth caret, BB's mono font, and 70
  grammars (Astro, Svelte, Vue, TOML,
  Zig, Nix, Prisma, Haskell, OCaml, Gleam, Elixir, Makefile, Dockerfile, …).
- **Quick palette commands** (`⌘⇧P`, type "Editor:"): save, quick open,
  toggle tree, format, go to symbol, go to line, fold and unfold, sort lines,
  copy path.

## Settings

Extensions → Editor:

| Setting                | Default  | Notes                                                   |
| ---------------------- | -------- | ------------------------------------------------------- |
| Font size              | 13       | 9 to 24                                                 |
| Wrap long lines        | off      | Also in the `⋯` menu                                    |
| Show line numbers      | on       | Also in the `⋯` menu                                    |
| Show minimap           | off      | Also in the `⋯` menu                                    |
| Auto save              | off      | `onBlur` saves when the editor loses focus; `afterDelay` one second after typing stops. The `⋯` toggle switches off/afterDelay |
| Format on save         | off      | Uses Monaco's formatter where one exists (TS, JS, JSON, CSS, HTML) |
| TypeScript diagnostics | syntax   | `semantic` adds type errors minus module-resolution codes |
| File tree side         | right    |                                                         |

## Install

Development installation (this checkout):

```sh
cd plugins/editor
npm install --include=dev
npm run build:monaco
bb plugin disable monaco-editor
bb plugin install .
```

`bb plugin dev` rebuilds `dist/app.js` on save. The Monaco/Shiki bundle in
`dist/monaco` is separate: the server builds it on first use when it is
missing or older than `monaco-bundle/`, `scripts/stage-assets.mjs`, or
`package.json`, and `npm run build:monaco` builds it up front.

Git installation from this repository:

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin erwin-editor
```

A git install runs `npm install --omit=dev --omit=optional`, so `esbuild`,
`monaco-editor`, `shiki`, and `@shikijs/langs` are runtime dependencies. On
a machine whose npm policy blocks esbuild's install script, `--omit=optional`
also skips esbuild's platform binary; the first file open then fails with a
message naming `npm run build:monaco`. Run that command once in the installed
plugin directory (`bb plugin source erwin-editor` prints it).

## Develop

```sh
npm run typecheck
npm test
npm run build
```

Layout:

- `app.tsx` registers the file opener, the two Files panel actions, and the
  palette commands.
- `components/Workbench.tsx` is the split layout (tree, editor pane, quick
  open, dirty-switch guard). `EditorPane.tsx` owns one Monaco editor and the
  save state machine. `FileTree.tsx`, `QuickOpen.tsx`, `Toolbar.tsx`.
- `lib/shiki-monaco.ts` tokenizes Monaco models with Shiki and maps colors
  back to theme scopes; `lib/monaco-theme.ts` converts BB's theme document
  into a Monaco theme; `lib/bb-tokens.ts` resolves BB's surface colors from
  live CSS (composited on a canvas) for the editor chrome.
- `lib/languages.ts` is the one table of Monaco id, Shiki grammar, and file
  patterns. `monaco-bundle/editor.js` must list a loader for every grammar
  it names; `lib/languages.test.ts` checks that.
- `server.ts` resolves workspaces, reads and writes files through
  `bb.sdk.files`, lists the tree, and serves the editor bundle through a
  `files.createPreview` lease.

Why the bundle is separate: `bb plugin build` emits one file without code
splitting, so Monaco (about 5 MB) would parse at app boot for everyone, and
its workers could not be emitted. `scripts/stage-assets.mjs` builds
`dist/monaco` with esbuild code splitting instead: `editor.js`, one chunk per
grammar, and five workers, all loaded on demand.

## Not yet

- Live reload when the agent edits an open file (needs a workspace watch).
- Git gutter and an editable diff view against HEAD or the base branch.
- Review comments on lines that the agent can read.
- A file opened from the tree inside an editor tab keeps that tab's original
  title; plugins cannot retitle a host tab yet.
