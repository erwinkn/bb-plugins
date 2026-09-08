# Third-party notices — Pierre editor bundle

`dist/pierre` is a browser bundle built by `scripts/stage-assets.mjs` from the
packages below. The build writes the full license texts of every package it
included to `dist/pierre/LICENSES.txt`. Keep that file with the bundle when you
distribute a built copy of this plugin.

| Package | Version | License |
| --- | --- | --- |
| `@pierre/diffs` | 1.4.1 | Apache-2.0 |
| `@pierre/theme` | 2.0.0 | see `dist/pierre/LICENSES.txt` |
| `@pierre/theming` | 1.0.1 | see `dist/pierre/LICENSES.txt` |
| `shiki` and `@shikijs/*` | 4.x | MIT |
| `diff` | 9.0.0 | BSD-3-Clause |
| `hast-util-to-html` and its `hast`/`unist` dependencies | — | MIT |
| `lru_map` | 0.4.1 | MIT |
| `@fontsource-variable/geist-mono` | 5.3.0 | OFL-1.1 |

The Apache-2.0 license of `@pierre/diffs` requires that a distribution keeps the
license and the attribution notices. `dist/pierre/LICENSES.txt` satisfies that,
and the table above names the source for a reader who has only this repository.

The panel bundle (`dist/app.js`) also includes the file-type icon sprite and
name resolver of `@pierre/trees` 1.0.0-beta.6 (Apache-2.0), the set BB's own
file trees use. Its license text is in `node_modules/@pierre/trees/LICENSE.md`.

No code from other Pierre integrations is copied into this plugin. The bundle
entries adapt the published `@pierre/diffs` API and load the licensed Geist Mono font.
