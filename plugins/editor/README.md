# bb-plugin-erwin-editor

A Monaco editor for BB with a **Files** panel, syntax colors that match BB's
own code renderer, and TypeScript, JSON, CSS, and HTML language services.
Plugin id: `erwin-editor`. It replaces the bundled `monaco-editor` plugin;
disable that one before you install this one.

## What it adds

- **Files panel.** Open the right panel, select **+**, then **Files**. A
  file tree sits on the left and the editor on the right, like Cursor. The
  tree collapses (`⌘B`), resizes by drag, and remembers its width and the
  last file per workspace. On the New thread screen, **Files** browses the
  project's default checkout.
- **Editor tabs.** BB opens claimed file types in this editor instead of its
  read-only preview: file links in chat, the panel file search, and
  `bb thread open`. The tree toggle works there too.
- **Quick open** with `⌘P` inside the editor or tree: fuzzy search over the
  workspace file list. `⌘` + click, or **Open in new tab** in the tree's
  context menu, opens a file as its own host tab.
- **Colors that match BB.** Files tokenize with Shiki's TextMate grammars
  and BB's current VS Code theme document, the same inputs BB's preview uses,
  so colors match token for token. Theme and light/dark switches apply live.
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
- **Editor polish.** Sticky scroll, bracket pair colors, indent guides,
  smooth caret, BB's mono font, and 70 grammars (Astro, Svelte, Vue, TOML,
  Zig, Nix, Prisma, Haskell, OCaml, Gleam, Elixir, Makefile, Dockerfile, …).
- **Quick palette commands** (`⌘⇧P`, type "Editor:"): save, quick open,
  toggle tree, format, go to symbol, go to line, fold and unfold, sort lines,
  copy path.

## Settings

Extensions → Editor:

| Setting                | Default  | Notes                                                   |
| ---------------------- | -------- | ------------------------------------------------------- |
| Font size              | 13       | 9 to 24                                                 |
| Wrap long lines        | off      |                                                         |
| Show minimap           | off      |                                                         |
| Auto save              | off      | `onBlur` saves when the editor loses focus; `afterDelay` one second after typing stops |
| TypeScript diagnostics | syntax   | `semantic` adds type errors minus module-resolution codes |

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
  into a Monaco theme and derives chrome colors the document omits.
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
- Renaming, creating, and deleting files from the tree.
- Hidden files never appear in the tree; BB's path listing excludes them.
- A file opened from the tree inside an editor tab keeps that tab's original
  title; plugins cannot retitle a host tab yet.
