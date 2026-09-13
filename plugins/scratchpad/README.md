# Scratchpad

One shared BlockNote document per BB environment, opened from **+ →
Scratchpad** in the right panel (there is no button in the thread header).
Threads using the same environment share notes. Separate environments have separate notes,
even if they happen to point to the same physical directory.

Edit rendered text with the formatting menu, Markdown shortcuts, or `/` menu.
Headings, checklists, nested lists, quotes, tables, dividers, colors, and code
blocks are supported. Media uploads are not included. Changes autosave after
650 ms; Ctrl/Cmd+S saves immediately. The panel follows BB's light/dark theme.

Code blocks are highlighted with BB's active code theme, light or dark, the
same colours as the chat and the editor plugin (`experimental_useCodeTheme`).
The language is the fence name, so ```` ```ts ```` or a Markdown append with a
fenced block sets it; there is no language menu on the block. Supported:
TypeScript, TSX, JavaScript, JSX, JSON, JSONC, YAML, TOML, shell (`sh`,
`bash`, `zsh`), Python, Rust, Go, CSS, SCSS, HTML, Markdown, SQL, diff and
Dockerfile, with their usual short names (`grammars.ts`). Other names render
as plain text. Highlighting only decorates the view: the stored JSON, the
`language` prop included, is unchanged. Shiki and its regex engine load the
first time a code block is on screen, and each grammar is fetched once from
the plugin server's HTTP routes rather than shipped in the app bundle. A
theme change re-creates the editor so existing blocks repaint; the current
text is kept, the cursor position is not.

JSON is stored in BB's plugin SQLite database at
`<bb-data-dir>/plugins/scratchpad/data.db`, outside the worktree and Git.
A scratchpad has a 1 MB / 2,000-block limit. The latest 100 saved revisions are
retained. History previews earlier versions and restores them as new revisions.
Retiring a worktree does not delete its notes. Use `bb scratchpad list` and
`bb scratchpad export <environment-id>` to recover retired notes.

## Shared editing and recovery

Every write checks the expected revision in a database transaction. An agent or
another browser cannot silently overwrite a stale draft. A clean panel follows
remote changes; a dirty panel keeps its draft and offers **Review latest**,
**Use latest**, or **Save my draft instead**. The last option explicitly
replaces the latest document, with another revision check. Both saved versions
remain in history. This version detects conflicts; it does not merge concurrent
keystrokes automatically.

Unsaved drafts persist in sessionStorage for this browser tab and thread, so
reloads can recover them. Recovery against a newer server version opens a
conflict. Closing the browser tab ends that recovery store; a storage warning
means it could not retain the draft. The document remains in the database after
saving. Realtime signals refresh open panels, backed by polling every 10 seconds
and refresh on reconnect/focus. A moved thread's old panel cannot save into the
previous environment: close and reopen Scratchpad to follow the new environment.

**Export JSON** includes the current draft and preserves document structure.
**Export Markdown** exports saved content and may lose richer formatting. These
exports create files only when requested; normal notes never create a workspace
file. Back up the plugin database before uninstalling or destructive migration.

## Agents and CLI

Tools: `scratchpad_read` (paginated JSON and Markdown), `scratchpad_append`, and
`scratchpad_edit` (replace/delete one block and its children). Every mutation
requires `expectedRevision` from a read. Agent scope comes from the calling
thread, not an agent-supplied environment ID. Native tools become available on a
new provider session; the CLI works immediately after installation.

```sh
bb scratchpad get --json
bb scratchpad append 'A useful finding' --revision 0
bb scratchpad edit BLOCK_ID 'Updated finding' --revision 1
bb scratchpad history
bb scratchpad restore 0 --revision 2
bb scratchpad list
bb scratchpad export ENVIRONMENT_ID
```

Use `--thread <id>` when calling outside the desired thread. JSON exports are
bounded by BB's CLI output limit. The editor and agents use the same store and
schemas; no browser needs to remain open for an agent to read or edit notes.

## Development

Requires BB 0.43.1 / Plugin SDK 0.4.87 and Node 22 or later.

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install path:/absolute/worktree/plugins/scratchpad --yes
bb plugin dev /absolute/worktree/plugins/scratchpad
```

`npm test` covers the store and RPC (`server.test.ts`), the save queue
(`session.test.ts`), the grammar catalogue against the installed Shiki
packages (`grammars.test.ts`), the theme conversion (`code-theme.test.ts`) and
the app's entry points (`app.test.ts`).

BlockNote 0.54.2 (core, React, Ariakit, server utilities) is MPL-2.0. Shiki
4.4.3 (`@shikijs/core`, `@shikijs/engine-javascript`, `@shikijs/langs`) is MIT.
No XL packages or hosted collaboration service are used. Agent Markdown
conversion uses BlockNote's server utilities; JSON is always the stored format.
