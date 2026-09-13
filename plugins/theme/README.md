# Theme

Unified BB themes: one colored app palette paired with each code theme, so a
single pick in Settings → Appearance (or `bb theme set`) sets both BB's chrome
and its code colors, plus colored provider marks that show whenever the plugin
is enabled. Plugin id: `theme`.

BB allows one palette at a time, and a palette carries its own code theme pair.
This plugin therefore ships one `bb.themes` entry per code pair, all pointing at
the same stylesheet, `themes/color.css`. The editor plugin used to carry these
pairs on an empty stylesheet; they now live here, and the editor's diffs and
file views follow whichever pair is active through `experimental_useCodeTheme`.

## Themes

Ids are `plugin:theme:color-<pair>`; the Pierre family comes first:

| Id suffix | Name | Dark / light code theme |
| --- | --- | --- |
| `color-pierre` | Pierre | pierre-dark / pierre-light (BB's default pair) |
| `color-pierre-soft` | Pierre Soft | pierre-dark-soft / pierre-light-soft |
| `color-pierre-vibrant` | Pierre Vibrant | pierre-dark-vibrant / pierre-light-vibrant |
| `color-github`, `-default`, `-dimmed`, `-high-contrast` | GitHub … | github-* pairs |
| `color-vs-code`, `color-one` | VS Code, One | dark-plus / light-plus, one-dark-pro / one-light |
| `color-catppuccin-*`, `color-ayu*`, `color-everforest`, `color-gruvbox-*` | | |
| `color-kanagawa-*`, `color-material*`, `color-min`, `color-night-owl` | | |
| `color-rose-pine*`, `color-solarized`, `color-vitesse*`, `color-slack` | | |
| `color-tokyo-night`, `color-dracula-soft`, `color-aurora-x`, `color-synthwave-84` | | dark-only pairs use pierre-light |
| `color-horizon`, `color-snazzy` | | light-only pairs use pierre-dark |

The full list is `lib/theme-pairs.ts`. After editing it, run `npm run sync` to
rewrite `package.json`; `manifest.test.ts` fails while the two disagree.

```sh
bb theme list                          # shows the plugin entries
bb theme set plugin:theme:color-pierre
bb theme show
```

## Palette roles

The neutral ramp (`--canvas`, `--ink`, borders, text tiers) is untouched. Color
goes on glyphs, code tokens, pills and heading accents, never on prose. Six
roles, six hues, each with a light and a dark value, exposed as `--bbp-*`
tokens so other plugins can reuse them with a fallback
(`var(--bbp-command, var(--timeline-accent))`):

| Role | Hue | Token | Where it shows |
| --- | --- | --- | --- |
| Files, reads, listings, searches, links | blue 250 | `--bbp-file` (= `--timeline-accent`) | FileText, Folder, Search, File glyphs; active plan step; h1/h2 accent |
| Commands, tools, extensions | teal 200 | `--bbp-command` | Terminal, Puzzle glyphs |
| Web fetch | cyan 230 | `--bbp-web` | Globe glyph |
| Edits | amber 50 | `--bbp-edit` (= `--warning-text` / `--warning`) | EditFile glyph |
| Plans, skills, approvals, questions | amber 80 | `--bbp-attention` | ListTodo, Zap, Lock, CircleQuestion glyphs |
| Done, passing | green 155 | `--bbp-done` | completed plan steps |
| Errors, failed | red 22–28 | `--bbp-error` (= `--destructive-text`) | AlertCircle glyph, failed plan steps |
| Agents, delegation, threads | purple 295 | `--bbp-agent` (= `--pr-merged`) | UserRoundPlus/UserRound glyphs, mention pills; AiBrain01 at a receded mix |

Chat code blocks get a fuller sugar-high palette on `.bb-code-highlight`
(rose keywords, green strings, blue types, teal properties, purple calls, amber
JSX text) while identifiers, punctuation and comments keep BB's neutral tiers.
Mention pills lean purple through the documented `--pill-*` tokens; BB has no
per-kind pill token yet, so file pills share the tint. Compaction and
context-clear glyphs stay neutral on purpose. Settled rows keep BB's dimming, so
their tint recedes with them.

Light glyphs sit at oklch L≈0.50–0.55 (at least 3:1 on white), dark glyphs at
L≈0.72–0.78. Check both modes in BB's Theme Preview plugin after changes.

## Provider marks

BB draws provider logos as `currentColor` masks, so the model and provider
pickers, the metadata panel and the sidebar thread rows show every agent in
gray. `app.tsx` registers `experimental_providerIcon` for each agent provider
configured on this install, with the provider's official mark drawn inline
(`lib/provider-marks.tsx`). The artwork is taken verbatim from BB 0.43.1's
bundled provider plugins (`plugins/provider-*/icons/*.svg` in the BB source)
and, for Devin, from `plugins/devin/assets/devin.svg`; only the color changes.
The host draws the marks wherever it draws a provider icon and wherever a
plugin renders `experimental_ProviderIcon`. The composer chip shows BB's
lightning glyph instead of the provider while fast mode is on. Disabling the
plugin restores BB's masks.

| Provider id | Artwork | Color token | Value | Fallback without the palette |
| --- | --- | --- | --- | --- |
| `claude-code` | Anthropic spark | `--bbp-brand-claude` | Anthropic terracotta `#D97757` | `--warning-text` |
| `codex` | OpenAI knot | `--bbp-brand-codex` | OpenAI green `#10A37F` | `--success` |
| `acp-cursor` | Cursor cube | `--bbp-brand-cursor` | `--ink` (monochrome brand) | `--foreground` |
| `acp-grok` | xAI mark | `--bbp-brand-grok` | `--ink` (monochrome brand) | `--foreground` |
| `acp-opencode` | opencode squares | `--bbp-brand-opencode` | `--ink` (monochrome brand) | `--foreground` |
| `acp-devin` (our plugin) | Devin knot | `--bbp-brand-devin` | `--ink` (monochrome brand) | `--foreground` |

Both brand accents clear 3:1 on the white canvas and more on the dark one, so
they are used as-is in both modes. Cursor, xAI, opencode and Devin ship
monochrome marks and no accent is known to us, so they render at full ink
strength (black on light, near-white on dark) rather than an invented hue;
to add one, set the token's light and dark values in `themes/color.css`.
BB's `pi` provider already declares its own violet tint, and the
`acp-hermes-agent` / `acp-omp` presets are not configured here, so those keep
BB's artwork. `provider-icons.test.tsx` renders every mark, checks the
fallback tokens exist in both of BB's mode blocks, and computes each color's
contrast against BB's light and dark canvases (3:1 minimum).

## Upgrade check

`themes/color.css` styles host surfaces through BB DOM contracts: the
`.bb-code-highlight` class and its `--sh-*` tokens, `data-icon` on icons,
`data-timeline-row-id` on rows, `data-plan-step-status` on plan steps,
`data-markdown-preview` on rendered Markdown, and the `--pill-*` tokens. Each
block in the stylesheet names the BB 0.43.1 source file it relies on.

`lib/host-contract.ts` lists those contracts with exact strings from the
installed app bundle (including the row-kind → glyph mappings, such as
``case`file-change`:return`EditFile` ``), the provider-icon slot lookup, and
the agent provider ids declared by BB's bundled provider plugins.
`host-contract.test.ts` locates the running BB install (`BB_APP_DIR`, then the
`bb` binary, then the global npm root), greps `app/dist/assets/*.js` and
`*.css` (and `server/dist/builtin-plugins/provider-*/dist/*.js` for the ids)
for every string, and also checks that the stylesheet tints exactly the glyphs
the list pins.
`manifest.test.ts` checks that every entry's stylesheet exists and every code
theme name is one the installed BB ships as a chunk. After a BB upgrade, run
`npm test`; a failure names the BB source file to re-read and the string that
disappeared. Without a BB install the bundle checks are skipped.

## Layout

- `package.json` holds the generated `bb.themes` list, the empty server
  entry BB requires, and the `app.tsx` frontend entry.
- `themes/color.css` is the palette and every host-surface rule, including
  the `--bbp-brand-*` tokens.
- `app.tsx` registers the provider marks from `lib/provider-marks.tsx`.
- `lib/theme-pairs.ts` is the pair catalog, `scripts/sync-manifest.mjs`
  writes it into the manifest, `lib/host-contract.ts` and `lib/bb-install.ts`
  back the tests.

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin install path:/home/exedev/Code/bb-plugins/plugins/theme --yes
bb plugin reload theme
```
