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

The Apache-2.0 license of `@pierre/diffs` requires that a distribution keeps the
license and the attribution notices. `dist/pierre/LICENSES.txt` satisfies that,
and the table above names the source for a reader who has only this repository.

No code from other Pierre integrations is copied into this plugin. The bundle
entries in this directory only re-export the published `@pierre/diffs` API.
