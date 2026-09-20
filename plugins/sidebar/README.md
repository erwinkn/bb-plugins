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
Pinned threads keep all available descendants beneath them, regardless of status,
project, or a descendant's own pin. Status filters do not hide these families.
A pinned child appears as a root here only when it has no available pinned ancestor.
Each thread appears once. Child previews and Show more work as in other families.
Archived threads stay hidden until you enable Archived in Threads display options.
The display menu offers **Date updated**
(the default) and **Date created**, and an **Order** of **Newest first** (the
default) or **Oldest first**. The choice applies in
both Status and Project views and stays when you switch views or reload.
The sort uses BB's `updatedAt` or `createdAt`, not attention events. Pinned
threads lead their group in both orders.
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

Rows can be nested by dragging, mirroring BB's own sidebar: after a short
movement (4 px with a mouse, a 200 ms hold with touch), holding a row over the
center of another row for a moment arms a nest drop — the target highlights and
collapsed children expand. Dropping on a status or project group detaches the
thread to top level; dropping on the Pinned group pins it, and dropping a
pinned thread elsewhere unpins it. Nesting a pinned thread unpins it first.
Self, descendant, and archived targets are refused, and Escape cancels. A row
menu offers the same moves without dragging: **Make child of…** lists valid
parents, and nested threads get **Move to top level**.
If a parent's title is absent from the sidebar data, opening the info card
fetches only that thread's title, without loading the archive list. A failed
lookup shows Unavailable and retries when the card is reopened.
If project details are missing, its threads remain in an Unknown project
group. BB's personal project, which holds threads outside any project, is
shown as **No project** everywhere in the plugin.
Each missing project keeps its own group until BB supplies its name.

The display menu switches between Status and Project grouping and shows or hides
each status. **Snoozed** and **Archived** close the **Show statuses** list,
below **Done**.
Status groups keep the order above. Project groups sort by
name, except **No project**, which always closes the list above Archived. Pins, roots, and siblings follow the selected date sort.
Children in each family stay below their parent. A child's timestamp or pin does not
move its parent. New-thread drafts have no thread timestamp and appear after dated
threads in their group. Groups can collapse. There is no thread search field.
Old saved project filters from before spaces are ignored.
Sorting and grouping do not change thread state.

Grouping, the date sort, the order, and the collapsed state of the Pinned
group and of each project group follow BB's synced sidebar preferences, so
they match the native sidebar and every other client:

| Plugin setting | BB preference |
| --- | --- |
| Group by Project / Status | `sidebar.organizationMode` `project` / `chronological` |
| Date updated / Date created | `sidebar.chronologicalSort` `updated` / `created` |
| Newest first / Oldest first | `sidebar.sortDirection` `descending` / `ascending` |
| Pinned group collapsed | `pinned` in `sidebar.collapsedSections` |
| Project group collapsed | the project id in `sidebar.collapsedProjects` |

BB's chronological and machine modes both show Status grouping. An
alphabetical or manual BB sort keeps the plugin's last date sort until you
pick one here. The plugin reads the preferences when the list mounts, when the
connection returns, and when the window regains focus, because BB's own
clients write them without a signal that reaches a plugin. Each change here is
written through with BB's per-key revision; a write that races another client
is retried once against the fresh value, and a second failure is reported.
Entries the plugin does not show, such as other collapsed projects or the
Threads section, are preserved. Hidden statuses, collapsed status groups,
archive visibility, expanded archives, spaces, and the library stay on this
client. localStorage remains the cache and the fallback while BB is
unreachable.
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

Rows have two lines. The first line shows the provider's glyph (BB's
`experimental_ProviderIcon` for the thread's `providerId`, so plugin-registered
artwork and tints apply), the title, and the status marker at its right end.
The second line shows muted metadata: the pull request indicator when the
thread has one, then the project name, then a git-branch glyph in the same
muted color as the text and the same size as the pull request glyph, and the
branch. Under a project header the project name is omitted, because it would
repeat the header; pinned rows keep it. Rows under **No project** have no
project metadata at all, so they collapse to a single line: the title, the
status marker, and the age. The age for the selected date sits at the right end of
that line and refreshes each minute. The pull request indicator covers the
union of the branch PR BB reports and the pull requests the github-prs plugin
(`plugins/github`) linked to the thread, deduplicated by URL with the live
branch entry winning. A linked PR shows its last-seen state: green for open,
purple for merged, red for closed, edit amber for a draft, and an
unrecognised or missing state reads as open. The branch PR additionally shows
attention amber when an open pull request needs you. With one pull request
the chip is a state-colored icon and its number, a link by role since the row
itself is a link: it underlines on hover, and clicking it or pressing Enter
opens the pull request without selecting the row. With several it collapses
into the icon and a small count badge, coloured by the most attention-worthy
state (needs-you open, then open, draft, merged, closed); clicking it opens a
small popover listing each pull request with its state icon, number, and
title, plus the repo when it differs from the thread's — or whenever the list
mixes repos and no branch PR names one. Picking an entry opens that pull
request. The badge, the chip, and the entries are keyboard reachable, keep
the press away from the row's selection, drag, and long-press menu, and work
with a tap on touch viewports. The click first dispatches a cancelable
`bb-plugins:open-pull-request` CustomEvent on `window` with
`{ url, threadId }`; the github-prs plugin, when loaded,
shows the pull request in its thread panel and calls `preventDefault`. When
nothing takes the event, the sidebar opens the URL through BB's URL opener,
which follows the client's in-app or external browser preference; a host
without that opener gets a new tab. Metadata
that does not fit fades out before the age instead of showing an ellipsis;
the title fades before the status marker. The provider, the full branch, and
the pull request title appear in an instant info card to the right on hover
or keyboard focus. The pull request lookup uses BB's per-row sidebar hook, so
BB owns its polling and staleness rules, but the branch PR only joins the
chip when the `linkedPullRequests` RPC reports the thread's environment as
eligible — a thread-dedicated worktree on a non-default branch. On a shared
project checkout that PR belongs to the checkout, not to each thread on it,
so it is hidden; persisted github-prs links still show. The linked pull
requests come from
the `github-prs.pullRequests` thread metadata, read in one bulk
`linkedPullRequests` RPC for the whole visible list rather than one call per
row. A plugin app only receives its own realtime signals and BB emits no
metadata-change event, so the GitHub plugin bumps the sidebar's
`pullRequestsChanged` RPC on every link change (after the metadata mirror
lands, and harmlessly absent when the sidebar is not installed); the server
republishes `linked-pull-requests-changed` and the list refetches just that
thread. The whole map is also re-read on mount, when the listed threads
change, and on every realtime reconnection, since plugin signals are
ephemeral.
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
icon. Child arrows stay separate from status icons and keep BB's subtle text
color, so they never compete with the markers. Needs
Attention rows also get BB's attention surface wash behind the whole row.
Group headers show a glyph, the label, a count chip, and the collapse chevron,
with no hover descriptions. The glyph is the group's status icon, a pin for
Pinned, the archive box for Archived, or a folder in the project's identity
color for a project. The chip counts the rows in the group; it is muted except
on Needs Attention, where it turns amber while non-zero. Glyph and chip are
decorative, so the header's accessible name stays the plain label.
Project headers have no count chip. In its place, before the chevron, a `+`
button opens BB's new-thread composer in that project, the same path as the
header menu's **New thread**, without collapsing the group. On a mouse or
trackpad (`pointer: fine`) the button appears only while the header line is
hovered or focused; touch viewports always show it. Its accessible name is
"New thread in" followed by the project name. Unknown projects have no button.
The status menu retains its colored icons. Archived has a neutral archive-box
icon in the menu and the row's right-aligned status position. The layout uses BB's theme tokens.

Active rows use BB's native open, split, rename, pin, read, and archive actions plus the plugin's library save and remove. The plugin also keeps
the attributes needed for BB's thread navigation shortcuts. Right-click a row
on desktop or hold it for 450 ms on mobile to open its actions. Scrolling,
releasing early, or cancelling the touch cancels the hold. With keyboard focus
on a row, press Shift+F10 or the Menu key. On a mouse or trackpad
(`pointer: fine`), hovering a row swaps its status marker, or the empty slot of
a Done row, for an Archive control; on archived rows it is Unarchive. Clicking
it archives or restores through the same RPC as the menu action and does not
open the thread. Touch viewports keep the marker and the long press. While a touch menu is open, a temporary
selection guard prevents the native hold from selecting background text. It is
removed on close or unmount; desktop menus are unchanged.
Select Rename to edit the thread name in the row. Save or Enter applies the
name. Cancel or Escape discards the edit. Empty names cannot be saved. A failed
save keeps the entered name and shows an error so you can try again.
There is no actions button. A normal
click or tap still opens the thread. Archive collects all active descendants,
including hidden children and restored descendants below archived ancestors,
then archives them deepest first and the selected
thread last through BB's public API. BB handles runtime and terminal cleanup.
The operation stops on failure and reports partial progress; completed archives
are not rolled back. Discovery finishes before any archive requests are sent.
This is not atomic: children created or moved during the operation can escape
the collected tree. BB's other archive buttons and keyboard shortcut keep their
native behavior. No bulk read or delete actions are added.

## Spaces and project management

A space is a named selection of projects. The Threads heading is the scope
selector: it reads **All projects**, a space name, or **Library**. Its menu
lists All projects, each saved space, then Library — the saved-thread
collection described below — and **Manage spaces…**, which goes to the
plugin's **Spaces** page. The page also has its own row in BB's sidebar
navigation (route
`/plugins/sidebar/spaces`). There are no dialogs; every edit is a form
on the page, and on phones the page shows one column at a time with a back
link so it works like any other BB page.

- The Spaces page lists every space with its project count beside the
  selected space's projects. On desktop the list stays visible and the first
  space opens by default; on phones the list is the first screen and each row
  opens the space. **Manage spaces…** opens the current space when
  one is selected, the list otherwise, and All projects when no space exists
  yet. Selecting a space on the page does not change the Threads scope.
- **New space…** on the page opens a form
  with a name and a checklist of every BB project. Create saves the space and
  opens it. Names are trimmed, limited to 60 characters, and unique ignoring
  case. An empty space shows a **Choose projects** link into its page.
- A space's page shows a checkbox per project for membership, and a heading
  menu with **Rename…** and **Delete…** (inline forms; on phones also Move up
  and Move down). Deleting a space never touches projects or threads and
  returns to the list. A member project BB no longer lists appears as
  *Unavailable project* so it can be removed. Right-click or long-press a
  space in the list for Rename…, Move up, Move down, and Delete…; on desktop
  a space row can also be dragged onto another row to take its place.
- **All projects** at the bottom of the list shows every BB project without
  membership checkboxes; use it to manage projects before any space exists.
- Project lists with six or more entries get a **Filter projects** field that
  matches names and folders, in both the New space checklist and a space's
  page. Reordering is off while a filter is active.
- Each project row shows its folder (and a host badge when more than one host
  is connected) and has a `…` menu: **Rename…**, **Change folder…**, **Move
  up**, **Move down**, and **Remove…**, each an inline form under the row. The
  personal project has no menu. These go through BB's own project API, so BB's
  new-thread panel and every client see the same list. **Remove…** says how
  many active threads the project has and requires typing its name; BB then
  deletes the project with all of its threads, and the plugin drops it from
  every space. Files on disk are untouched. On desktop a project row can be
  dragged onto another row to take its place.
- **+ Add project…** opens a form with a folder path field with directory
  completion (type `/Users/me/Co` and pick from the list; Tab or Enter accepts
  the highlighted folder) or **Browse…** for the native folder dialog, and a
  project name that defaults to the folder name. With more than one host, a
  host selector comes first. On a space's page the new project joins that
  space. Browse… opens the dialog on the machine that hosts the project; plugin
  frontends do not know which host the client runs on, so on a remote host use
  the path field.
- In the by-project grouping, right-click or long-press a project header for
  **New thread**, **Spaces ›**, **Rename…** and **Remove…** (inline forms under
  the header), and **Manage spaces…**.
- Another plugin in the same page may switch the selected space: it writes
  `spaceId` in this client's stored state and dispatches the plugin's
  `bb-plugin-sidebar:state` window event, after which the Threads list
  re-reads the state. Voice Mode uses this for "switch to the mobile space".
- Space definitions are shared by every client of one BB server and stored in
  the plugin's key-value store as one document with a revision. A save that
  races another client's save fails with an error, and the form keeps your
  input; the catalog reloads so you can retry. Each client keeps its own
  selection in local storage, together with a cached copy of the catalog for
  the next load. Grouping, sorting, and status filters are shared across spaces.
- Scope applies before pins, families, archives, and drafts. A pinned thread
  outside the scope is hidden. A child outside the scope is hidden and does not
  affect its family's status. An in-scope child of an out-of-scope parent is a
  root, with its parent still named in the info card. Archiving a family still
  archives every active descendant, including those outside the scope.
- If the open thread is outside the scope, a notice offers **Show all
  projects**; the thread stays open and the scope does not change. If the
  selected space was deleted elsewhere, the list shows All projects with a
  notice. A brand-new client with a selected space shows *Loading spaces…*
  until the catalog arrives; if it cannot load, the list shows All projects
  with a Retry action.
- **New thread** uses the active project when it is in scope, otherwise the
  space's only project, otherwise a menu of member projects. In All projects
  it keeps BB's behavior.
- Projects created outside Manage (BB's own panel, the CLI) are not added to
  any space automatically. SDK 0.4.47 has no project-creation event that
  identifies the originating client.
- `bb sidebar spaces-export` prints the catalog. `bb sidebar spaces-import
  '<json>'` replaces it and bumps the revision. Use them for backups and for
  moving definitions between BB servers.

## Library

The library keeps threads for later without archiving them: no runtime
cleanup runs and saved work keeps going. **Save to Library** in a row's
actions marks the thread; **Remove from Library** unmarks it. Each save
covers the whole family — children of a saved thread count as saved,
including children created later — so one action keeps a family together.

Each save is mirrored into the thread's plugin metadata as
`{ saved: true, savedAt }` in the `sidebar` namespace, and the keys are removed
when the thread leaves the library by unsave or archive (a deleted thread takes
its metadata with it). The flag is informational for other plugins and agents
that read thread metadata; the key-value list stays the index and the flag is
never read back to rebuild it. Entries saved before the flag existed receive
it once, on the first start after the upgrade. A failed metadata write is
logged and does not affect the library.

Saved threads leave the active view in every scope. The **Library** scope
lists saved families instead, with live statuses, sorting, grouping, and
Show more as usual; while another scope is selected, a status icon on the
menu entry and the Threads heading reports saved threads needing attention
or holding unread replies. Removing a member frees its family unless a
descendant was saved on its own. Archiving or deleting drops the save, so a
restore lands in the active view. The document lives in the plugin's
key-value store, shared by all clients and cached locally for the next
load.

## Snooze

Snooze hides a thread until a time and brings it back as something to look
at. **Snooze…** in a row's context menu (right-click, or a long press on a
touch viewport) lists the presets and **Custom date and time…**; on a mouse
or trackpad a clock control appears on hover, left of the archive control,
and opens the same presets in a small popover. A snoozed row's control and
menu entry become **Unsnooze**.

- A sleeping thread leaves the status groups and Pinned, together with its
  descendants (the same family rule as the library). The **Snoozed** group,
  closed by default and placed before Archived, lists sleeping families
  soonest first, with the wake time in place of the age. Unchecking
  **Snoozed** under **Show statuses** hides the group, like Archived;
  sleeping threads stay hidden until they wake.
- A pinned thread can be snoozed: the snooze unpins it and remembers the
  pin, and the pin returns when the snooze ends by any route.
- When the wake time comes, the plugin marks the thread unread through BB
  and flags it *woke*; a woke thread sits in **Needs Attention** until it is
  opened, which clears the flag. If BB was down at the wake time, the thread
  wakes on the first poll after the next start.
- Agent activity on a sleeping thread (a turn starting or finishing, a
  failure, or a pending question) ends the snooze early, so the thread
  surfaces the same way. Archiving or deleting a thread drops its snooze.

The presets are shared by the popover, the menu, and the CLI and are edited
in BB settings under **Threads › Snooze presets**. Each preset has a label,
a CLI name, and either a delay in minutes or a local clock time a number of
days ahead (0 means today, or tomorrow once the time has passed). The
defaults are **1 hour**, **3 hours**, **Tomorrow** (09:00), and **Next
week** (the same weekday, 09:00).

Agents and scripts use the `bb sidebar` commands:

```sh
bb sidebar snooze <threadId> --until tomorrow      # a preset name
bb sidebar snooze <threadId> --until 2h            # 45m, 2h, 3d, 1w
bb sidebar snooze <threadId> --until 2026-09-20T09:00
bb sidebar unsnooze <threadId>
bb sidebar snoozes [--json]
bb sidebar presets [--json]
```

The thread id defaults to the invoking thread. The `thread-snooze` skill in
`skills/` tells agents when to reach for these. Snooze state lives in the
plugin's key-value store (one revisioned document served by the
`getSnoozes`, `snooze`, `unsnooze`, and `acknowledge` RPCs and pushed on
the `snoozes-changed` channel); the plugin cron schedule `snooze-wake`
polls it every minute. Each snooze is mirrored into the thread's plugin
metadata as `{ snoozed: true, snoozedUntil }` in the `sidebar` namespace
for agents and other plugins, and removed when the snooze ends.

There is no snooze entry in the thread header's ellipsis menu: that menu is
host-owned with no plugin slot (see *Desired upstream changes* in the root
README).

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

Requires BB 0.43.1 or later and Plugin SDK 0.4.87 or later. The saved-flag
mirror uses per-thread plugin metadata, which arrived in BB 0.43.1.

```sh
cd plugins/sidebar
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install .
```

Select **Threads** in **Settings → Appearance → Sidebar** if BB does not select
it automatically. The selection is per client. Use `bb plugin dev` for live
development. To remove it, run `bb plugin remove sidebar`.

Tests cover status precedence, date sorting in both views, synced preferences, navigation, storage validation,
draft text and attachments, fallback UI, a disconnected realtime connection, space
filtering and editing, the Spaces page, project management through BB's API,
the space catalog RPC, and the spaces CLI.
They use the SDK's frontend harness. The live BB view still needs visual checks
after SDK upgrades because the sidebar API is experimental.

The test setup pins jsdom's `nwsapi` dependency to 2.2.25. Versions 2.2.26
and 2.2.27 recurse during `:modal` checks used to position menus. See
[upstream issue #172](https://github.com/dperini/nwsapi/issues/172).
All tests use Vitest's default timeout. Remove the override after a fixed
release passes the menu tests.

## Archived threads

Archived threads are hidden by default. Enable **Archived** under **Show statuses**
in Threads display options to show them. Both views then have a single Archived
section at the bottom of the list; its rows keep their project names. The
section starts collapsed and remembers its state per client. Status filters do
not hide archived
threads. The selected date sort also applies to archives.

Expand a section to browse its threads. Rows use the same paging and child
groups as active threads. Archived rows offer only two actions: open the row
to read its history, or select Restore from its context menu. They have no pin,
read/unread, split, drag-to-split, or archive controls. Restoration uses BB's existing operation. Archived rows use
BB's general thread navigation because the sidebar open action only knows
active threads. Restore a thread before using pin, read, or split actions.

The backend reads visible archives in pages of 200 through BB's public SDK only
while the setting is enabled. Hidden background threads stay hidden. The list
refreshes on BB's archive, unarchive, and delete events, plugin restores,
sidebar membership changes, and reconnection. A thread restored outside the
plugin leaves the Archived section without a reload; it does not rejoin the
library. Failed loads show a Retry button; active threads
remain available.

## Color

Colors follow the theme plugin's palette roles with BB's own tokens as
fallbacks, written as `var(--bbp-x, var(<BB token>))` so the look degrades to
BB's defaults when the BB Color palette is not selected: attention amber
(`--bbp-attention` / `--warning-text`), unread and files blue (`--bbp-file` /
`--timeline-accent`), working and open green (`--bbp-done` / `--success`),
errors and closed red (`--bbp-error` / `--destructive-text`), agents, drafts,
and merged purple (`--bbp-agent` / `--pr-merged`), and draft
pull requests in the edit amber (`--bbp-edit` / `--warning-text`). Every status
keeps its own shape, so color never carries it alone; colored text only uses
BB's `-text` tokens.

Each project has an identity color: a deterministic hue from its name on an
eight-step wheel (`lib/project-hue.tsx`). It tints the folder glyph on project
headers and on the Spaces page project list, and draws a 2px accent at the left
of a row wherever the row also shows the project name (status view, Pinned,
Library). The color is BB's file blue with only the hue replaced through CSS
relative color syntax, so lightness and chroma follow BB's light and dark
palettes; browsers without relative colors keep the plain blue. Tailwind never
sees these values, so no custom theme colors or literal oklch appear in
classes.
