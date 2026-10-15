# Threads

A status-first BB sidebar. It replaces only the thread list, not the rest of
the sidebar. It uses the public Plugin SDK. It does not use a six-hour activity
window, automatically archive threads, or run cleanup jobs.

## Layout

The sidebar is one view in two parts. At the top, a picker: every Adventure,
then an **Other threads** entry. Below it, one section lists what is picked:
the Adventure's coordinator and workers, or every thread outside the
Adventures.

```
Adventures                                    +
  ◎ bb-plugins                          ◌  2m   ← picked
  ◍ Equisafe: infra                     ⓘ  1m
  ☰ Other threads                       ◌
bb-plugins                                    ≡   ← group/order workers
  ⚙ Plan the sidebar rework                   ◌
    Coordinator                              1m
  Needs you                                   1
  ⚙ Sidebar review                            ⓘ
    W476                    Sol 6.1 · xhigh  4m
  Working                                     2
  ⚙ Sidebar: selected Adventure's workers     ◌
    W478  #812              Opus 5.5 · high  1m
    › 1 child thread
  ⚙ Workers tab prefetch                      ◌
    W473                    Opus 5.5 · high  6m
  › 3 member threads
```

Pick Other threads and the lower section becomes the thread list:

```
  ☰ Other threads                       ◌       ← picked
Other threads                               ≡ +
  Fix flaky snooze test                        ◌
  bb-plugins · fix-snooze                     2m
```

**Adventures.** One dense line per Adventure: its icon in its color, its
name (muted while paused), its status and how long ago its threads last
changed. The status prioritizes an unread coordinator reply or a
decision/input needing you, then any working thread (including native
descendants), then an observed unsent text or attachment draft. Routine
unread worker reports wait for the coordinator. The counts (needs you, in
flight, remaining, to revisit, paused) are in the row's tooltip, under the
objective. A click picks the Adventure and opens its coordinator (its
overview when it has none).

**New Adventure.** The + level with the Adventures title (or "Start one"
while there are none) opens a dialog: a name, what it should achieve, and its
repositories, where the open thread's repository is preselected and the first
checked one hosts the coordinator. Only the header creates; no Adventure row
offers it. It creates through the Adventures plugin's own `command` RPC
(`create`, with a new coordinator on the first repository's default checkout),
like its create form. The dialog closes at once and the draft shows in the
picker as "Creating…" while Adventures spawns the coordinator, so nothing
waits on it. Once created, the new Adventure becomes the pick (the picker
shows it as soon as the tree lists it) and its coordinator opens unless you
have navigated away meanwhile. A failed draft stays in the picker with its
reason; Edit reopens it, and resending it unchanged reuses its idempotency
key, so a create that did land but whose answer was lost is never made twice.
Past 90 s without an answer the draft shows as unconfirmed, and a late answer
still settles it. Sent drafts and their keys are kept in this client's
storage, so a reload keeps them; after a reload, drafts still waiting for an
answer are sent again under their keys. Each send is its own storage entry,
named by its key and holding only what that key's answers decided, so tabs
sending at once never overwrite each other's, and every tab shows what another
sent or settled. A send that got no answer shows as failed only in its own
tab. Only an answer from Adventures settles a key: when it refused the create,
or cannot tell what an earlier send saved, the draft gets a new key and
resending it is a new create, which you check and send on purpose. A key first
sent over 7 days ago is never sent again, by a reload or by hand, because
Adventures keeps its receipt only a day longer: the draft stays listed with a
warning, so you can check whether it was created before sending it as new. An
Edit dialog always sends the draft's current key, even one that settled while
it was open, and closes if the draft is created meanwhile.

**Picking.** Exactly one entry is picked and shows highlighted. The pick is
kept in this client's storage (`selected`), so a reload keeps it. Opening a
thread of an Adventure (its coordinator, a worker, or one of their child
threads) picks that Adventure, once per opening: picking Other threads while
that thread stays open sticks. The Adventure whose tree names the thread
wins; otherwise the one naming its nearest ancestor. BB's thread list leaves
archived threads out, so when the walk up reaches a parent it does not list
(a live helper under an archived reviewer), the client asks the sidebar
server once, in the background, for that thread's parent links
(`threadAncestry`, read from the host, at most 32) and keeps them for the
session; a read in flight is shared, and a failed one is asked again on the
next opening. Opening a thread outside the Adventures keeps
the pick. With nothing picked yet, or once the picked Adventure has left the
tree, the first Adventure is shown; Other threads only when there are no
Adventures or the Adventures plugin is not running. Before the first tree read
of a fresh client (no cached tree) the lower section waits under "Loading
Adventures…"; a picked Other threads draws at once.

**Workers.** The section of a picked Adventure is titled with its name. The
coordinator comes first, labelled "Coordinator", without the threads it
spawned. Each worker is an ordinary thread row (status, hover prefetch, the
row menu, split and PR chip) whose title drops the leading worker id BB
titles start with; its second line starts with the id (W474) and ends with
the model and reasoning level from its Adventures execution profile ("Opus
5.5 · high", the full profile on hover), then its age. A worker's child
threads (reviewers, helpers) fold under a "› 2 child threads" toggle shown
only when it has some, closed until clicked or while it holds the open
thread; a child with children of its own gets its own toggle. The
Adventure's member threads (discussions and threads attached to it, the ones
its tree names whose parent is the coordinator or gone) fold the same way
under "member threads" at the end. Other threads under the coordinator, such
as a former worker's thread nobody archived, are not listed.

The workers section's options button chooses, for every Adventure at once:
**Group workers by** State (Needs you, Working, Waiting, Done · PR waiting,
Stopped, Idle: the Workers tab's groups and rules) or None, and **Order
workers by** Recent activity or Newest worker (highest W# first). The choice
is kept in this client's storage. Waiting holds a worker whose own thread is
quiet while a descendant is live (a review running, queued for a slot or
asking for input), whatever its last report said: a worker that reported done
and then took more work never shows as done while its review runs. BB's live
status wins over the last read at once: a worker waiting for input shows
under Needs you, a running one under Working, and a quiet one over a running
or input-waiting descendant under Waiting. A descendant queued for a slot
looks quiet in BB's sidebar list, so only the server's facts (Adventures'
child cache) put that worker under Waiting. Needs you, Working and Waiting
show whole; Done, Stopped and Idle show five rows before Show more, and the
ungrouped list fifteen.

Where the model and state come from: BB threads carry no model, so the
sidebar server reads the picked Adventure's Adventures `overview` (summary
tier) and keeps only each worker's id, profile and group. That read is heavy
(about 1.2 MB and 1.5 s for an Adventure of 80 workers), so it is bounded: only
Adventures some client asked about in the last two minutes are read, one read
at a time, a first read at once and a changed one again at most every 30 s
(`FACTS_INTERVAL_MS`). Clients ask with `adventureWorkers`, which answers from
the server's memory at once, without reading the tree; a read that changes an
Adventure's facts announces it on `adventure-workers-changed`, so the clients
showing that Adventure ask again and nothing else is read. A client asks for
the picked Adventure's facts once a minute, which keeps them current, and for
an Adventure whose row the pointer rests on (150 ms), so picking it draws its
groups at once. Before an Adventure's first read its workers show in one list
without models.

**How the sidebar reads.** Every server read goes through TanStack Query
(`lib/query.ts`, `lib/queries.tsx`): one client shared by every mounted slot,
so two views of a query read it once. The tree and order, worker facts,
Adventure thread ids and both snooze documents are saved to `localStorage` and
restored before the first render, so a cold open draws them at once and reads
each again in the background; the archive list, branch-PR eligibility and
thread ancestry stay in memory. Realtime signals drive the reads: a signal
marks its queries stale and reads the ones on screen once, 200 ms after a
burst, and a read in flight finishes and is followed by exactly one more (its
answer may predate the change). A signal carrying a document applies it
without a read, as does a snooze write's answer. A reconnect reads everything
on screen again, since signals are not replayed; a tab coming back reads what
is older than 30 s. A slow poll (`SAFETY_POLL_MS`, 60 s, visible tabs only)
covers a lost signal. A failed read retries once at once; errors show from
the second miss. Measured in `tests/request-rate.test.tsx`, an open sidebar
sends 3 reads a minute idle (8.2 before), 14 under a signal every 5 s (32.1),
none in a hidden tab.

**Other threads.** The picker's last entry, in the Adventures' style with a
list glyph, lists every thread outside them, with pins, snoozes, drafts and
archive. Its status shows the most urgent of its threads (needs attention,
unread, working). Its grouping and order are this client's own (they default
to no grouping, most recent first) and never follow the picked Adventure. Its
section's options button holds Grouping (None, Status, Project) and Ordering
(date updated or created, newest or oldest first) submenus that name the
current choice, then Show options for each status, Snoozed and Archived. Its
+ opens BB's new-thread composer in the open thread's project. Ungrouped,
new-thread drafts lead the list and 25 threads show before Show more; under a
Pinned group the list gets a "Recent" title so it does not read as pinned.

Adventure order is fixed until you change it: activity, selection, polling and
reloads never move a row. Drag a row to reorder it — the whole row is the
handle on desktop; on touch, hold about a fifth of a second before moving so
the sidebar still scrolls on a flick. On the keyboard, focus a row and press
Space to lift it, arrows to move it, Space or Enter to drop it. The release
click after a drag never opens the Adventure.

Each row keeps an options menu on right-click or a stationary long press
(the same gesture on keyboard is ContextMenu/Shift+F10): **New thread**,
**Rename…**, **Icon and color…** and **Adventure overview** (that
Adventure's dashboard). New thread opens the Adventure's native BB composer
in the Adventures plugin immediately. Navigation closes the mobile drawer and
does not create a thread or send input.

Choose the member repository, model and checkout in the native composer.
Initiatives validates the selected repository and creates the user-owned thread
under the current coordinator when you submit, using the same flow as the
Initiative dashboard. Sidebar has no separate first-message form or repository
submenu.

There is no Overview link and no Advisor entry: the Initiatives overview page
and the Advisor are reached from BB's own sidebar entries, if at all.

**Icon and color…**, next to Rename, swaps the row for a small picker: an
automatic color (the hue from the name) or one of the eight identity hues, and
one of sixteen BB icons. Each choice saves at once through the Initiatives
`command` RPC (`appearance`), which owns the data, accepts only the palette
and only from the user (agents cannot change it). **Reset** returns to the
default Target icon and name hue; Escape or **Done** closes the picker. The
choice persists in Initiatives, travels in the tree as optional `appearance`,
and never moves the row or changes its identity. An older Initiatives without
the field, or a value this sidebar does not know, shows the default look.

Links go through the `initiatives` plugin. Composer links target
`/plugins/initiatives/initiatives/<encoded-initiative-id>/compose`. The plugin
calls `initiativesChanged` to refresh the view.
The public `toPluginPanel` helper is scoped to the calling plugin, so Sidebar
uses the SDK's `UrlLink` to open Initiatives through native internal navigation. The old `createProjectThread` server RPC
remains for already-loaded Sidebar bundles; the new UI does not call it.

The order persists in the plugin's server-side key-value storage, so every
client signed in to the same BB host shares it and reloads keep it. New
Initiatives append at the end; one that leaves the tree keeps its stored
slot and reclaims it if it returns. The first run orders Initiatives by the
tree's order at that moment. Saves are revision-checked and
serialized; a failed save keeps your order on screen, shows an error, and
retries on the next refresh. Up to 256 Initiative IDs are stored; snapshots
beyond that cap keep the first 256 visible Initiatives' order intact and a
reorder that would exceed it is rejected rather than silently truncated. A
stored document that fails to parse is surfaced as an error and left
untouched.

The sidebar builds independently of the Adventures plugin (`initiatives`); its
versioned RPC schema is checked against the same fixture in both plugins' tests.
If it is disabled, the Adventures section explains how to enable it and Other
threads still works. Composer links close
the mobile drawer before navigating. Composer links use `UrlLink` for BB's
internal navigation; the row menu's overview link remains an ordinary anchor.

## Adventure threads stay out of Other threads

The thread list hides every thread the Initiatives tree names (coordinators,
workers, reviewers and the Initiative's other member threads, which include
discussions) and every descendant of one, archived or not. Reviewer and fixer
children that Initiatives never records are therefore hidden too, even under an
archived or unlisted intermediate thread. A thread with the same shape (a child of a plain thread) is
untouched. Pinned Initiative threads are hidden as well, so one rule holds
everywhere: the Pinned section, the Recent list, the Status and Project
groups, Archived, and the **Make child of…** targets all skip them. Adventure
threads are listed under their Adventure instead (workers, their child
threads, and its member threads), and in its panel.

The ids come from the `initiativeThreads` RPC. The server keeps one snapshot
for all clients and answers at once from it, announcing a change on its own
realtime channel. A walk reads the Initiatives tree, then the host's parent
links (active and archived in one read per parent, 8 reads at a time, 60 s
deadline) to collect every descendant, so the client needs no ancestry walk of
its own for threads the server has seen. At most one walk runs, walks start at
least 30 s apart however often the snapshot is read, and Initiatives ledger
changes in between are coalesced into the next allowed walk. A walk that times
out or fails cancels its reads before the next may start. `status` is `loading` until the first read
finishes, `failed` when that first read failed (no snapshot exists, and a
failure is never reported as a confirmed empty set), and `ready` otherwise.
The client keeps the last confirmed set in its query cache, saved to
`localStorage`. With a saved set the list renders at once and a refresh never
blocks it; without one Other threads
shows "Loading threads…" until the first answer (a failed or timed-out first
read also ends the wait, with nothing hidden and nothing cached until a read
succeeds). A client that has a set keeps it and its cache through any failed or
slow read; only a confirmed answer replaces it, and an Initiatives plugin that
is not running hides nothing. Each read has a 30 s deadline and late answers
are ignored, so a stalled request cannot stop later refreshes. The set is read
again on reconnection, on the snapshot change signal (a ledger change starts a
walk on the server, which announces its result there), when the host thread
list gains or loses a thread, and once a minute while the tab is visible.
For a thread newer than the snapshot, the client also follows the live parent
links, using loaded archived rows too; a named parent hides its children even
when its own row is missing from the list.

Limits: the tree names only current threads, so the thread of a retired worker
or a former generation shows again in the thread lists. The tree does not mark
discussions apart from other member threads, so all member threads are hidden.

## Status rules

Grouped by status, groups appear in this order. Each thread appears in exactly
one group. Empty groups are hidden.

Status grouping initially shows five top-level threads per group, except Done,
which shows ten. Show more reveals another five or ten; Show less restores
the initial limit. Children do not count toward this limit. New-thread drafts
share the Draft limit with existing threads. The selected thread's family stays
visible even beyond the limit, so a group can show one extra top-level thread.
Expansion resets when a group closes or the view reloads. Project grouping initially
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
Archived threads stay hidden until you enable Archived in the list options.
The list options' **Ordering** offers **Date updated**
(the default) and **Date created**, and **Newest first** (the
default) or **Oldest first**. The choice applies in
every grouping and stays when you reload.
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
family's status. Grouped by status, a family appears in its highest-priority
category using the group order above. Each row keeps its own status.
All status markers sit at the right end of the title line, in one column for
root, child, and grandchild rows.
Every row has the same full-width hover, selection, and click area. Nesting
indents only the arrow and thread information, not the row background or status icon.
Rows never show status text below the title. Child rows
use the same status markers as parent rows, with no extra status text: a green
spinner for Working, a blue dot for Unread, an amber alert for Needs Attention,
a violet dashed circle for Draft, and no marker for Done.
Project grouping nests children within the same project.
If a parent is missing, archived, or hidden by a status filter, its visible
children appear as separate roots. Cross-project children appear under their
own project when grouped by project. Parent names appear in the hover info card.

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

The list options switch between no grouping, Status and Project grouping and
show or hide each status. **Snoozed** and **Archived** close the **Show**
list, below **Done**.
Status groups keep the order above. Project groups sort by
name, except **No project**, which always closes the list above Archived. Pins, roots, and siblings follow the selected date sort.
Children in each family stay below their parent. A child's timestamp or pin does not
move its parent. New-thread drafts have no thread timestamp and appear after dated
threads in their group. Groups can collapse. There is no thread search field.
Old saved project filters and space selections are ignored.
Sorting and grouping do not change thread state.

The collapsed state of the Pinned group and of each project group follows
BB's synced sidebar preferences, so it matches the native sidebar and every
other client:

| Plugin setting | BB preference |
| --- | --- |
| Pinned group collapsed | `pinned` in `sidebar.collapsedSections` |
| Project group collapsed | the project id in `sidebar.collapsedProjects` |

BB's grouping and sort preferences (`sidebar.organizationMode`,
`sidebar.chronologicalSort`, `sidebar.sortDirection`) are neither read nor
written: the list's grouping and order are this client's own. The plugin reads the preferences when the list mounts, when the
connection returns, and when the window regains focus, because BB's own
clients write them without a signal that reaches a plugin. Each change here is
written through with BB's per-key revision; a write that races another client
is retried once against the fresh value, and a second failure is reported.
Entries the plugin does not show, such as other collapsed projects or the
Threads section, are preserved. Grouping, order, hidden statuses, collapsed
status groups, archive visibility, and expanded archives stay on this
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
that line and refreshes each minute. The pull request indicator is the branch PR BB reports for the thread's
environment: a state-colored icon and its number, green for open, purple for
merged, red for closed, edit amber for a draft, and attention amber when an
open pull request needs you. It is a real link to the PR, and never inside
the row's link (a link can't nest a link): the row link keeps an invisible,
`aria-hidden` copy of the chip so the line lays out as before, and the chip's
own link sits beside the row link, absolutely positioned over that space with
the row's left padding, bottom padding and line height. Modifier clicks,
middle clicks and Copy Link behave natively on both links, and pressing the
chip never selects the row, drags it, or opens the row's menus. It underlines on hover; a plain click, a
tap, or Enter opens the pull request. It opens through BB's URL opener (`useBbNavigate().openUrl`),
which follows the client's link preference: a tab of BB's built-in browser on
desktop when "open links in the app browser" is on (the default), the
external browser otherwise, and a plain new tab on a host without the opener.
Metadata
that does not fit fades out before the age instead of showing an ellipsis;
the title fades before the status marker. The provider, the full branch, and
the pull request title appear in an instant info card to the right on hover
or keyboard focus. The pull request lookup uses BB's per-row sidebar hook, so
BB owns its polling and staleness rules, but the chip only shows when the
`branchPullRequestEligibility` RPC reports the thread's environment as
eligible — a thread-dedicated worktree on a non-default branch. On a shared
project checkout that PR belongs to the checkout, not to each thread on it,
so it is hidden. One bulk call covers the whole visible list, re-read on
mount, when the listed threads change, and on every realtime reconnection.
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
Right-click or long-press a project header for **New thread**, **Rename…** and
**Remove…** (inline forms under the header). Both go through BB's own project
API, so every client sees the change. **Remove…** says how many active
threads the project has and requires typing its name; BB then deletes the
project with all of its threads. Files on disk are untouched. The personal
project offers only New thread.
The status menu retains its colored icons. Archived has a neutral archive-box
icon in the menu and the row's right-aligned status position. The layout uses BB's theme tokens.

Active rows use BB's native open, split, rename, pin, read, and archive actions. The plugin also keeps
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

## Removed: Spaces and the Library

Earlier versions had a second Threads view, a scope menu over it with saved
**spaces** (named project selections, managed on a Spaces page with project
add, re-folder and reorder forms) and a **Library** (Save to Library hid a
thread family from the list until removed). All of it is gone; BB's own
project settings manage projects, and snooze covers "later".

Their shared data is left in place, unused, so rolling back to the old code
brings them back: the space catalog and the library list in the plugin's
key-value store, the `{ saved, savedAt }` keys in threads' `sidebar` plugin
metadata, and the spaces and library caches in this client's `localStorage`.
The plugin no longer reads any of it, so previously saved threads show in the
list again. This client's stored view, space selection, and Threads-view
grouping and sort are ignored and dropped at its next preference write; the
thread list's grouping and order carry over.

## Snooze

Snooze hides a thread until a time and brings it back as something to look
at. **Snooze…** in a row's context menu (right-click, or a long press on a
touch viewport) lists the presets and **Custom date and time…**; on a mouse
or trackpad a clock control appears on hover, left of the archive control,
and opens the same presets in a small popover. A snoozed row's control and
menu entry become **Unsnooze**.

- A sleeping thread leaves the status groups and Pinned, together with its
  descendants, including children created later. The **Snoozed** group,
  closed by default and placed before Archived, lists sleeping families
  soonest first, with the wake time in place of the age. Unchecking
  **Snoozed** under **Show** hides the group, like Archived;
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

Tests cover status precedence, grouping and date sorting, synced collapsed
groups, navigation, storage validation, draft text and attachments, fallback
UI, a disconnected realtime connection, the Adventures list with its worker
rows, models, child toggles and worker options, the query cache's
persistence, deduplication, prefetch and signal-driven reads, the request
rate,
project rename and removal through BB's API, and the snooze CLI.
They use the SDK's frontend harness. The live BB view still needs visual checks
after SDK upgrades because the sidebar API is experimental.

The test setup pins jsdom's `nwsapi` dependency to 2.2.25. Versions 2.2.26
and 2.2.27 recurse during `:modal` checks used to position menus. See
[upstream issue #172](https://github.com/dperini/nwsapi/issues/172).
All tests use Vitest's default timeout. Remove the override after a fixed
release passes the menu tests.

## Archived threads

Archived threads are hidden by default. Enable **Archived** under **Show** in
the thread list options to show them. The list then has a single Archived
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
plugin leaves the Archived section without a reload. Failed loads show a Retry button; active threads
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
headers, and draws a 2px accent at the left of a row wherever the row also
shows the project name (the Recent list, status groups, Pinned). The color is BB's file blue with only the hue replaced through CSS
relative color syntax, so lightness and chroma follow BB's light and dark
palettes; browsers without relative colors keep the plain blue. Tailwind never
sees these values, so no custom theme colors or literal oklch appear in
classes.
