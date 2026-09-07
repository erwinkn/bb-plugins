# Threads

A status-first BB sidebar. It replaces only the thread list, not the rest of
the sidebar. It uses the public Plugin SDK. It does not use a six-hour activity
window, automatically archive threads, or run cleanup jobs.

## Status rules

Groups appear in this order. Each thread appears in exactly one group.
Empty groups are hidden.

Status view initially shows five top-level threads per group, except Done,
which shows ten. Show more reveals another five or ten; Show less restores
the initial limit. Children do not count toward this limit. New-thread drafts
share the Draft limit with existing threads. The selected thread's family stays
visible even beyond the limit, so a group can show one extra top-level thread.
Expansion resets when a group closes or the view reloads. Project view initially
shows ten top-level threads per project, with ten more per Show more action.
It uses the same selected-family exception and includes new-thread drafts in
the limit.

| Group           | Rule                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| Needs Attention | Pending question or approval, or an unread run error.                       |
| Unread          | No current work; BB reports an unread reply.                                |
| Working         | A live runtime, background agent, command, workflow, plan, or goal.         |
| Draft           | No attention, work, or unread reply; an unsent draft is known.              |
| Done            | None of the above. This means idle and read, not confirmed task completion. |

Attention takes precedence over work. Work takes precedence over an old unread
flag. Unread takes precedence over a draft. Display order does not determine
this precedence.

Pinned threads appear once in a Pinned section above the Status or Project
groups. The section is hidden when empty and shows all pins without a row limit.
Status filters do not hide pins. Pinned children appear directly in this section;
unpinned children stay in the regular groups, as roots if their parent is pinned.
Archived threads remain hidden. The display menu offers **Date updated**
(the default) and **Date created**, both newest first. The choice applies in
both Status and Project views and stays when you switch views or reload.
The sort uses BB's `updatedAt` or `createdAt`, not attention events.
Children appear below their parent, with an inset arrow inside each child row
instead of a connecting line outside the rows. Each parent initially shows three
children. Show more reveals three more at a time; Show less restores the preview.
The selected thread and its ancestor path remain visible even outside that preview.
Expansion stays only while the family is mounted, not across reloads or group collapse.
Indentation stops at two levels below a root: children and grandchildren.
Deeper descendants appear at the second level in family order, with their actual
parent still shown in the info card. Hidden descendants still contribute to the
family's status. In Status view, a family appears in its highest-priority
category using the group order above. Each row keeps its own status.
All status markers sit at the right end of the title line, in one column for
root, child, and grandchild rows.
Every row has the same full-width hover, selection, and click area. Nesting
indents only the arrow and thread information, not the row background or status icon.
Rows never show status text below the title. Child rows
use the same status markers as parent rows, with no extra status text: a green
spinner for Working, a blue dot for Unread, an amber alert for Needs Attention,
a violet dashed circle for Draft, and no marker for Done.
Project view nests children within the same project.
If a parent is missing, archived, or hidden by a status filter, its visible
children appear as separate roots. Cross-project children appear under their
own project in Project view. Parent names appear in the hover info card.
If project details are missing, its threads remain in a No project group.
Each missing project keeps its own group until BB supplies its name.

The display menu switches between Status and Project grouping and shows or
hides each status. Status groups keep the order above. Project groups sort by
name. Pins, roots, and siblings follow the selected date sort.
Unpinned children stay below their unpinned parent. A child's timestamp or pin does not
move its parent. New-thread drafts have no thread timestamp and appear after dated
threads in their group. Groups can collapse. There is no thread search field or
project selector. Old saved project filters are ignored.
Preferences stay on this client. Sorting and grouping do not change thread state.
If browser storage rejects a write, this tab keeps its unsaved preferences and
draft flags in memory. It retries on the next local update, even if the value
does not change. Until that write succeeds, this tab's unsaved snapshot takes
precedence over storage events from other tabs. Normal cross-tab updates resume
after storage recovers. Reloading before a successful write loses those unsaved changes.

On mobile, the whole sidebar scrolls together, including navigation, the Threads
heading, groups, and footer. There is no separate thread-list scroll area.
Desktop keeps its fixed heading and scrolling thread list. The SDK has no
whole-sidebar scroll option, so compact mode applies a small CSS adapter to
BB's `data-sidebar` regions. It applies only while this list is mounted and
does not change host inline styles. Check this host layout after BB upgrades.

Rows have two lines. The first line shows the title with the status marker
at its right end. The second line shows muted metadata: the pull request for
the thread's branch when BB reports one, then the project name, then the
branch. Under a project header the project name is omitted, because it would
repeat the header. The age for the selected date sits at the right end of
that line and refreshes each minute. The pull request shows a state-colored
icon and its number: green for open, amber for an open pull request that
needs you, violet for merged, red for closed, and muted for a draft. Metadata
that does not fit fades out before the age instead of showing an ellipsis;
the title fades before the status marker. The provider, the full branch, and
the pull request title appear in an instant info card to the right on hover
or keyboard focus. The pull request lookup uses BB's per-row sidebar hook, so
BB owns its polling and staleness rules.
The card uses a 14 px title and 12 px details, with visible labels and values
aligned in two columns. The branch and parent stay fully readable. Labels,
provider, and dates use BB's subtle text color; status and values use the normal
foreground. Only the status and the pull request have icons. Missing fields
are omitted.
It uses BB's reported machine name, not a guessed local/cloud label. There is
no environment management action. Long text wraps, and the card adjusts at
viewport edges. Escape, scrolling, or opening thread actions dismisses it.
Touch keeps tap-to-open and long-press actions, without a hover card.
Working rows have a green spinner; unread rows have a
blue dot. Needs Attention rows have an amber alert icon. Draft rows, including
new-thread drafts, have a violet dashed-circle icon. Done rows have no status
icon. Child arrows stay separate from status icons. Group headers have plain labels and
centered collapse chevrons, with no status icons, counts, or hover descriptions.
The status menu retains its colored icons. The layout uses BB's theme tokens.

Active rows use BB's native open, split, rename, pin, read, and archive actions. The plugin also keeps
the attributes needed for BB's thread navigation shortcuts. Right-click a row
on desktop or hold it for 450 ms on mobile to open its actions. Scrolling,
releasing early, or cancelling the touch cancels the hold. With keyboard focus
on a row, press Shift+F10 or the Menu key. While a touch menu is open, a temporary
selection guard prevents the native hold from selecting background text. It is
removed on close or unmount; desktop menus are unchanged.
Select Rename to edit the thread name in the row. Save or Enter applies the
name. Cancel or Escape discards the edit. Empty names cannot be saved. A failed
save keeps the entered name and shows an error so you can try again.
There is no actions button. A normal
click or tap still opens the thread. Archive uses BB's native flow, which also
archives child threads and closes their open panes. No bulk read or delete
actions are added.

## Draft limits

SDK 0.4.47 does not expose saved composer drafts in its thread list. An invisible
composer banner observes public `useComposerView()` state, including attachment-only
drafts. Only a thread/project ID and a draft-present flag are saved in this
plugin's versioned localStorage key. Prompt text and attachments are never saved
by the plugin.

- Existing drafts become known when you open their composer once.
- Draft flags stay after navigation and reload on this client.
- Clearing text and attachments removes the flag when the composer is observed.
- New-thread drafts appear as “New thread draft” under their project.
- Queued messages and side chats are not treated as unsent main-thread drafts.
- The SDK has no global draft-clear event. A draft cleared while the plugin is
  disabled can have an old flag until you reopen its composer.
- Drafts are client-local. Another device can have a different draft state.

## Local installation

Requires BB 0.42.1 or later and Plugin SDK 0.4.47 or later.

```sh
cd plugins/activity
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install .
```

Select **Threads** in **Settings → Appearance → Sidebar** if BB does not select
it automatically. The selection is per client. Use `bb plugin dev` for live
development. To remove it, run `bb plugin remove erwin-activity`.

Tests cover status precedence, date sorting in both views, navigation, storage validation,
draft text and attachments, fallback UI, and a disconnected realtime connection.
They use the SDK's frontend harness. The live BB view still needs visual checks
after SDK upgrades because the sidebar API is experimental.

The test setup pins jsdom's `nwsapi` dependency to 2.2.25. Versions 2.2.26
and 2.2.27 recurse during `:modal` checks used to position menus. See
[upstream issue #172](https://github.com/dperini/nwsapi/issues/172).
All tests use Vitest's default timeout. Remove the override after a fixed
release passes the menu tests.

## Archived threads

Status view has an Archived section after the active groups. Project view has
an Archived section inside each project, including projects with only archives.
The sections start collapsed and remember their state per client. Status filters
do not hide archived threads. The selected date sort also applies to archives.

Expand a section to browse its threads. Rows use the same paging and child
groups as active threads. Archived rows offer only two actions: open the row
to read its history, or select Restore from its context menu. They have no pin,
read/unread, split, drag-to-split, or archive controls. Restoration uses BB's existing operation. Archived rows use
BB's general thread navigation because the sidebar open action only knows
active threads. Restore a thread before using pin, read, or split actions.

The backend reads visible archives in pages of 200 through BB's public SDK.
Hidden background threads stay hidden. The list refreshes on archive and delete
events, plugin restores, sidebar membership changes, and reconnection. Failed
loads show a Retry button; active threads remain available.
