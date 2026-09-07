# Pierre migration decisions

These choices apply to the editor and Changes implementation. The PR stays in
draft until the user completes testing and permits review readiness. This is a
record for that review, not a request to merge.

| Confidence | Decision | Alternative | Where the choice can fail |
| --- | --- | --- | --- |
| Medium | Use Pierre 1.4.1's keyboard command path for toolbar search. | Add a public command method upstream, then use it. | A Pierre DOM or keymap change can break toolbar search. The version is pinned. |
| Medium | Keep the native `diffs-container` registration when BB has already registered it. | Isolate the editor DOM and runtime from BB. | A later BB stylesheet or custom-element change can affect rendering. Installed browser checks passed; later BB updates still require a check. |
| Medium | Detect conflicts with environment status `U` and text markers. | Add a per-file raw porcelain status or unmerged flag upstream. | Markerless `AA` conflicts look like ordinary additions. BB also caches status for three seconds. CAS still protects against changed file content. |
| Medium | Read the current diff list again for each file open. | Cache a list or add an SDK call that reads all required data together. | File switching can be slow on a remote host with expensive Git commands. A fresh list avoids relying on client metadata. |
| Medium | Poll mounted files for external changes while the page is visible. | Add host watch support to the plugin. | Changes appear after a delay and large remote reads cost bandwidth. The intervals are 5 seconds, or 30 seconds above 512 KiB; focus triggers a check. |
| Medium | Store drafts in browser local storage, capped at one million characters. | Persist drafts on the server with lifecycle and account controls. | Browser storage can run out or be cleared. Large drafts cannot be retained; the UI reports the limit. Drafts do not move between devices. |
| Medium | Use a stable Git clone as the source of the installed branch preview. | Switch an existing managed Git installation in place. | BB 0.42.1 cannot perform the latter while preserving state. A path installation requires explicit Git updates and separate commit verification. |
| High | Add a dedicated Changes tab. | Replace BB's native diff renderer. | Users have two diff entry points. The native renderer slot lacks the source and save context needed for safe editing. |
| High | Replace Monaco and remove controls for its language services. | Keep both engines or rebuild language services around Pierre. | Users lose completion, diagnostics, semantic navigation, formatting, folding, sticky scroll, and minimap. The user explicitly chose the engine replacement; the README states the losses. |
| High | Load vanilla Pierre as separate ESM assets with a syntax worker. | Bundle Pierre React into the BB plugin app. | Asset or worker failures need visible recovery. This avoids a second React runtime and keeps grammars lazy. |
| High | Keep undo history within a mounted editor, while sessions retain file text across mounts. | Retain Pierre editor state across mounts with a separate stable version model. | Switching files starts a new undo history; stale retained state cannot replace a newer session buffer. |
| High | Use one shared file session and save queue, with one focused editing view. | Allow each tab to maintain its own buffer and saves. | Focus transfer and mirror updates need testing. A single session prevents competing writes and conflicting drafts for one file. |
| High | Use content-hash checks for saves and require explicit overwrite after conflict. | Let the latest save replace the file. | A disk change can stop a save. The user's current text remains available for recovery. |
| High | Keep saved revisions and old diff sides read-only; expose no stage or revert mutations. | Add Git mutations in this change. | The Changes tab does not replace a full Git client. These operations need separate index-aware contracts. |
| High | Limit whole editable files and diff sides to 8 MiB, matching the previous editor read limit. | Attempt unbounded reads and rendering. | Larger files require another tool. A truncated preview patch does not block a complete file read. |
| High | Keep related runtime, editor, diff, and save changes in one draft PR. | Split the change into stacked PRs. | The review is larger, but both views must use the same tested session and runtime contract. |

## Verification and verdict

Unit tests, typechecking, asset builds, independent reviews, and installed
browser checks are required before returning the change for user testing.
Physical mobile keyboards and IME behavior need device testing; a narrow
browser viewport or synthetic composition event cannot prove those behaviors.

The installed preview passed the automated and browser checks in the
[verification report](verification.md). Live checks led to fixes for overwrite
semantics, empty comparisons, editor readiness, and syntax-worker theme changes.
The implementation is ready for the user's testing, with the device and SDK
limits recorded in that report. The PR remains a draft. No merge is authorized.


## Predefined theme selection, 7 September 2026

The user requested predefined themes, one selection for Files and Changes,
and selection from plugin settings. Conductor's defaults are custom themes,
so the copied palette was removed.

| Decision | Alternative | Confidence | Limit |
| --- | --- | --- | --- |
| Save one local Code theme setting and default to Follow BB. | Continue changing BB's global theme from the Files menu. | High | Native BB code previews only share the selection when Follow BB is used. |
| Reuse the existing predefined dark/light pairs. | Add independent dark and light selectors. | High | Themes without a matching variant use Pierre in that mode. |
| Use readable labels in the native settings select and stable ids in the picker. | Add a custom settings component. | High | Labels are persisted because the SDK select has no separate value/label fields. |
| Keep existing BB app-theme contributions. | Remove them with the custom palette. | High | Themes can still be chosen separately in BB's Appearance settings. |

I stand behind these theme changes. Installed tests cover both selection
controls, both viewers, light/dark modes, and preservation of edits and undo.


## Auto-save without editor replacement

Successful writes update the comparison's known hash while keeping its editor
mounted. This preserves selections, scroll, and undo history directly. Restoring
a cursor after remounting would still discard the undo stack. Confidence: high.

A file saved back to the baseline stays open until navigation or explicit
refresh, even though Git removes it from the change list. Automatically moving
to another file would interrupt the next edit. Confidence: high.

External reads still revalidate the comparison. Pierre completion callbacks
only acknowledge the highlight cache; actual changes reach the shared session
through its edit-change callback. Repeating the old completion text can replace
a newer external read. The installed external-write test now passes.
I stand behind these changes; the remaining device-test limits are unchanged.
