# Threads

A status-first BB sidebar. It replaces only the thread list, not the rest of
the sidebar. It uses the public Plugin SDK. It does not use a six-hour activity
window, archive threads, or run cleanup jobs.

## Status rules

Groups appear in this order. Each thread appears in exactly one group.
Empty groups are hidden.

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

Pins appear first within each group. The display menu offers **Date updated**
(the default) and **Date created**, both newest first. The choice applies in
both Status and Project views and stays when you switch views or reload.
The sort uses BB's `updatedAt` or `createdAt`, not attention events.
Child threads use their own
status; a blocked child is not hidden below a running parent. A child row has
an arrow, and its tooltip names its parent.

The display menu switches between Status and Project grouping and shows or
hides each status. Status groups keep the order above. Project groups sort by
name; threads inside each project follow the selected date sort, regardless of
status. New-thread drafts have no thread timestamp and appear after dated
threads in their group. Groups can collapse. There is no thread search field or
project selector. Old saved project filters are ignored.
Preferences stay on this client. Sorting and grouping do not change thread state.

Rows show the title first, then muted project and branch text. The age for the
selected date appears on the right and refreshes each minute. The provider and full branch
remain in the tooltip. Working rows have a green spinner; unread rows have a
blue dot. Other rows have no status icon. Group headers have plain labels and
centered collapse chevrons, with no status icons, counts, or hover descriptions.
The status menu retains its colored icons. The layout uses BB's theme tokens.

Rows use BB's native open, split, pin, and read actions. The plugin also keeps
the attributes needed for BB's thread navigation shortcuts. No bulk read,
archive, or delete actions are added.

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
