# Pierre editor verification

Tested on 7 September 2026 with BB 0.42.1, SDK 0.4.47, and Pierre 1.4.1.
The initial implementation was tested at `b86f63d`. The styling follow-up is
recorded below and in the draft PR. The installed preview uses branch `feat/pierre-editor-diffs` in the stable clone
`/Users/erwin/Code/bb-plugins-editor-preview`. It retains plugin id `erwin-editor`.
PR #16 stays in draft until the user permits review readiness.

## Automated checks

`npm run typecheck`, `npm test`, `npm run build:pierre`, `bb plugin build`,
and `git diff --check` pass. The current suite has 108 passing tests.
The asset build produces 11.5 MB and 398 lazy chunks. Its dependency check
rejects React, React DOM, and Scheduler in the lazy runtime.

The tests cover hash-checked saves, save serialization, typing during a save
or read, stale draft recovery, session identity, external refresh, diff source
and path checks, missing merge bases, conflict status, complete reads despite
truncated preview patches, absent diff sides, and zero-hunk comparisons.
Theme tests cover repeated app loads and synchronization with the syntax worker.
The write adapter tests model the SDK distinction between a hash, omitted
`expectedSha256` (overwrite), and `null` (create only).

Independent reviews found and corrected stale-draft hash handling, load timing,
per-file conflict detection, render readiness, and several diff response cases.
Live testing then found the overwrite adapter error and a loading state for
pure renames. Both now have regression tests and passed installed checks.

## Installed browser checks

The tests used a disposable Git repository at `/tmp/bb-pierre-qa-0907`, linked
to a BB test thread. File checks read the actual disk bytes after keyboard
input in the installed plugin. They did not substitute calls to editor internals
for typing and saving.

| Check | Result |
| --- | --- |
| Files: type and save with Cmd+S | Exact text reached disk. |
| Files: undo and redo | A typed character was removed and restored. Undo to the saved text cleared the unsaved state. |
| Files and Changes: shared unsaved text | A draft entered in Files appeared in Changes before saving. |
| Changes: edit and save | Only the new-side text reached disk; deleted rows were not included. |
| CRLF, no final newline, Unicode | Existing file formats and exact Unicode bytes survived saves. |
| External edit followed by save | Save stopped with Reload/Overwrite; disk and unsaved text were preserved. |
| Stale draft after page reload | The draft remained available, required explicit restoration, and stayed in conflict until overwrite. |
| Explicit overwrite | The restored draft reached disk after the adapter fix. |
| Clean external refresh | New disk content appeared in the open editor without manual reload. |
| Theme preview and restore | Token colors changed to Tokyo Night and returned after Escape. Unsaved text and undo history remained intact. |
| Initial file focus | The attached editor received focus after a deliberate file open. |
| Find and replace | Toolbar Find and keyboard Find/Replace opened Pierre search; Replace All and save changed the expected text. |
| Deleted, binary, oversized files | Read-only content or a clear unsupported notice; no editable textbox. |
| Historical commit and committed branch | Commit 6fdf3a8 and Committed against main displayed saved revisions with no editable textbox. |
| All on branch | Included both the historical addition and working-tree edits against main. |
| Added file, pure rename, empty added file | Loaded without a permanent loading state. Rename and empty-file edits saved. |
| 20,000-line file | Loaded in the virtualized comparison. |
| Desktop split and unified layouts | Both rendered and allowed edits on the new side. |
| 390 px layout | Unified comparison, list/content navigation, and auto save worked without page overflow. |
| Existing settings | Font size 13, wrap on, line numbers on, tree on the right retained. Auto save restored to afterDelay and tested. |

A hidden browser tab suspends animation frames. An early blank-render test was
repeated with the tab visible; no layout defect was found from that case.
Browser automation uses real keyboard events for editor input. Setting a
contenteditable node with a generic form-fill command does not exercise Pierre
correctly.

## Limits for user testing

Physical mobile keyboards, IME composition, touch selection, and remote-host
latency remain unverified. A narrow desktop browser does not prove these cases.
Language services formerly supplied by Monaco are absent, as stated in the
Editor README. Undo history lasts for the mounted editor; buffers and durable
drafts survive file and tab switches.

The SDK cannot identify a markerless both-added unmerged index entry. The
plugin checks exposed per-file conflict status and conflict markers, and still
uses content hashes for saves. Native BB diff rendering remains available.

The final browser run reported no unhandled errors. The native BB custom-element
registration can produce an expected coexistence warning; rendering and editing
worked with that registration present.

This is an installed preview for user testing. No merge or review-readiness
change is authorized.

## Styling follow-up

Conductor 0.84.2 registers custom `conductor-dark` and `conductor-light` themes.
Its default dark colors are warm white `#eae8e6`, comment gray `#8e8885`,
keyword red `#f87272`, string tan `#ddc1b1`, constant blue `#61a6fa`, and
entity magenta `#e852ff`. These values come from the installed app's palette
and theme registration, not a guess from the screenshot. Its default code
font is Geist Mono at 13 px with 20 px rows. No local code-theme override was
found; a running Conductor editor's selected theme was not inspected.

The plugin applies those colors with its own compact scope rules. It bundles
the OFL-licensed Geist Mono font, keeps BB's canvas background in the shadow
root, uses subdued line numbers and a stable gutter width, and uses compact
hunk separators with 20-line expansion. Conductor and Follow BB are local
palette choices in the existing picker. Other theme pairs retain their
existing shared BB theme behavior.
