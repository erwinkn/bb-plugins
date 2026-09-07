# Pierre editor verification

Tested on 7 September 2026 with BB 0.42.1, SDK 0.4.47, and Pierre 1.4.1.
The initial implementation was tested at `b86f63d`. The styling follow-up is
recorded below and in the draft PR. The installed preview uses branch `feat/pierre-editor-diffs` in the stable clone
`/Users/erwin/Code/bb-plugins-editor-preview`. It retains plugin id `erwin-editor`.
PR #16 stays in draft until the user permits review readiness.

## Automated checks

`npm run typecheck`, `npm test`, `npm run build:pierre`, `bb plugin build`,
and `git diff --check` pass. The current suite has 110 passing tests.
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

The initial styling revision applied those colors with its own compact scope rules. It bundles
the OFL-licensed Geist Mono font, keeps BB's canvas background in the shadow
root, uses subdued line numbers and a stable gutter width, and uses compact
hunk separators with 20-line expansion. Conductor and Follow BB are local
palette choices in the existing picker. Other theme pairs retain their
existing shared BB theme behavior.

Installed styling revision `88f4769` passed the 108-test suite, typecheck,
asset build, and BB build. Browser checks confirmed Geist Mono loaded, the
editor background matched BB in both system color modes, and the observed
keyword/string/entity colors reached the rendered tokens. Theme preview and
Escape preserved unsaved text and undo history. Follow BB changed the code
colors while retaining BB's canvas background. The 390 px comparison retained
its layout without horizontal page overflow. No unhandled browser errors were
reported. That revision used the Conductor palette. The predefined-theme follow-up below replaces it.


## Predefined themes follow-up

Installed code revision `6c9c6d3` removes the copied Conductor palette. The
Files picker and **Settings → Editor → Code theme** save one plugin setting.
Files and Changes use the same predefined theme pair. Follow BB is the
default; plugin selection leaves BB's global theme unchanged. The existing
BB app-theme contributions remain available for users who select them there.

The clean installed clone passed all 107 tests and typecheck. The Pierre
asset build, BB build, and whitespace checks passed. Installed browser checks:

- Choosing GitHub in Files saved the setting and gave Files and Changes the
  same keyword color, `rgb(249, 117, 131)`, with BB's canvas background.
- Choosing Catppuccin Mocha in the plugin settings UI gave both tabs
  `rgb(203, 166, 247)` keywords. System light mode used Catppuccin Latte,
  `rgb(136, 57, 239)`, on BB's light background.
- Theme preview and Escape kept unsaved text and undo history.
- At 390 px, the host settings control opened its mobile theme menu. The
  page had no horizontal overflow and selecting Follow BB saved correctly.
- No unhandled browser errors were reported. Follow BB and the existing
  afterDelay auto-save setting were restored after testing.

This replaces the custom palette but retains Geist Mono, subdued line numbers,
compact separators, and BB's background. Physical-device testing remains open.

## Disposed session recovery

The recovered two-file patch was verified with a browser harness using the
real React hook and session registry, with an in-memory file transport:

1. Open a file, retain its session, and disable the hook without unmounting it.
2. Open and detach 26 other clean files, exceeding the 24-session idle cache.
3. Enable the hook for the original path, edit its text, and save.

Before the patch, the hook reused the disposed session. Save returned false
and the file retained its original text. After the patch, the hook acquired
a different live session; save returned true and the file held the edited
text. The fix exposes the existing disposed flag through the session interface
and checks it before reusing the hook's retained session.

All 107 tests, typecheck, the BB build, and whitespace checks passed.


## Auto-save cursor preservation

Installed revisions `a3d6184` and `81d33cf` fix diff refresh after saves and
stale text reported when an editor completes during external refresh.

A save now acknowledges its new hash without reloading the comparison. The
file stays open if saving back to the baseline removes it from the change
list. Explicit refresh still reconciles the list. Session snapshots distinguish
saved text obtained from a write from text obtained through an external read.
Pierre completion updates its cache only; each actual edit already reaches
the session through `onItemEditChange`.

The original installed version replaced the editor and lost focus after auto
save. With the fix, the same editor retained cursor offset, a nonempty selected
range, and scroll position at 2736 px. Repeated saves retained undo/redo.
Saving a 180-line file back to its baseline kept the editor open; another edit
saved successfully and put the file back in the change list.

Final revision `81d33cf` passed an actual edit/save test at 390 px with a
nonempty selection retained. External edits reached the open comparison and
remained on disk after auto save had time to run. This check found and fixed
a stale completion callback that could write the old text back over an
external update. No unhandled browser errors were reported.

All 110 tests, typecheck, the BB build, and whitespace checks pass. Physical
mobile keyboards and IME remain outside these browser checks.
