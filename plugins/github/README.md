# GitHub

GitHub issues and pull requests inside BB, with pull requests linked to
threads and PR links that open in a side panel instead of the browser.

This plugin is a fork of BB's official GitHub plugin (`plugins/github` in
[get-bb/bb](https://github.com/get-bb/bb), v0.2.1). It keeps the upstream
features and adds thread links, agent tools, and link interception. BB
reserves the plugin id `github` for its bundled copy, so this fork installs as
`github-prs` (package `bb-plugin-github-prs`) and can live next to it. The
CLI keeps the `bb github` name; the bundled plugin's CLI would take it over
if both were enabled at once.

## Install

```sh
bb plugin install path:/home/exedev/Code/bb-plugins/plugins/github --yes
bb plugin reload github-prs
```

Requires BB 0.43.1 or later and the GitHub CLI. Auth is `gh`'s: if
`gh auth status` passes, the plugin works; it stores no token. New provider
sessions receive the `github-pull-requests` skill and the three agent tools.

## Features

Inherited from upstream:

- **GitHub nav panel**: Issues and Pull requests tabs across every tracked
  repo (projects with a GitHub `origin`, plus the `extraRepos` setting), a
  filter bar, issue detail with status, assignee, label editing and comments,
  a New issue form, and **Send agent** / **Review with agent** spawns.
- **PR overview**: title, state, review decision, checks, Markdown body,
  reviews, review threads with diff hunks, changed files with inline diffs,
  and a comment box (nav panel only).
- **Mentions**: `@` or `#` in a composer completes issues and PRs.
- **`bb github` CLI**: `repos`, `issues [repo]`, `prs [repo]`, `sync`.

Added here:

- **GitHub PR thread panel**: lists the pull requests linked to the thread
  (title, state, repo, how it was linked, when) and opens one in a read-only
  copy of the PR overview. A paste box links a PR by URL, `owner/repo#n`, or
  `#n`; each row has an unlink button. The thread header shows a `PR · n`
  button when links exist.
- **Multiple PRs per thread** (see link policy below).
- **Agent tools** `github_link_pr`, `github_unlink_pr`, `github_list_prs`,
  the `github-pull-requests` skill, and CLI equivalents `bb github link`,
  `unlink`, `links`.
- **Link interception**: a click on a GitHub PR link in a thread opens the PR
  in the thread's GitHub PR panel.

## Link policy

The plugin SQLite table `thread_pull_requests` is the source of truth. Every
change publishes the realtime signal `pull-requests-changed {threadId}` and
mirrors the list into the thread's plugin metadata under `pullRequests`
(`bb.sdk.threads.getPluginMetadata({ threadId, pluginId: "github-prs" })`), one
entry per PR with `repo`, `number`, `url`, `source`, `title`, and the last-seen
`state` (added in 0.4.0; entries mirrored earlier lack it).

Sources:

- `branch` — automatic. The PR of the thread environment's branch, as BB's
  own lookup finds it (`GET /environments/:id/pull-request`, the same `gh pr
  view` behind the sidebar chip). Recorded the first time it is seen: after
  each turn (`thread.idle`), and whenever the panel, a tool, or the CLI lists
  links. The lookup is cached server-side for ten seconds.
- `agent` — an agent called `github_link_pr` or `bb github link`.
- `user` — pasted into the panel or sent through the `linkPullRequest` RPC.
- `spawn` — the thread was created by **Review with agent** on a PR.

No auto-linking from message text. Links are removed with the tools, the
panel, or when the thread is deleted. A link keeps its first source and time;
title and state refresh when a newer value is seen.

## Agent tools

| Tool | Input | Result |
| --- | --- | --- |
| `github_link_pr` | `{ reference }` URL, `owner/repo#n`, or `#n` | `{ status: "linked" \| "already-linked", link }` |
| `github_unlink_pr` | `{ reference }` | `{ status: "unlinked" \| "not-linked", repo, number }` |
| `github_list_prs` | `{}` | `{ pullRequests: [...] }` newest first |

A bare number resolves against the thread checkout's `origin` remote, then
the project's tracked repo. `github_link_pr` carries session instructions
telling agents to link PRs they create or are asked to work on. The skill in
`skills/github-pull-requests` explains the same for sessions without the
tools.

```sh
bb github link https://github.com/owner/repo/pull/123   # current thread
bb github links --thread thr_abc                         # another thread
bb github unlink owner/repo#123
```

## Link interception

BB 0.43.1 has no plugin hook in its URL router, so this is a content script
(`lib/link-interception.ts`): one document-level capture-phase `click`
listener finds an anchor on the event path whose `href` matches
`https://github.com/<owner>/<repo>/pull/<n>`, prevents the default, stops
propagation before React's root listener, and dispatches the open request.
Modifier clicks (cmd, ctrl, shift, alt) and non-primary buttons are left to
the browser, so "open in new tab" still works. Anchors with
`data-github-open-external` are skipped; the viewer's own "Open on GitHub"
link uses it, and any other plugin can too.

How a request reaches the panel (`lib/open-pull-request.ts`):

1. The content script dispatches `bb-plugins:open-pull-request` on `window`
   with `{ url, threadId, element }`, where `threadId` comes from the route
   (`/projects/:p/threads/:t` or `/threads/:t`) and `element` is the anchor.
2. Every mounted `experimental_threadHeaderAction` registers itself as a
   viewer target. A capture-phase listener picks the pane whose header is
   closest to the clicked element (split layouts), else the pane with that
   thread id, else the only pane, and calls
   `useBbNavigate().openThreadPanel({ actionId: "pull", params: { url } })`.
3. The `experimental_appOverlay` listens in the bubble phase. If no pane took
   the request and a thread id is known, it navigates to that thread and
   parks the URL; the header action opens the tab when it mounts. Without a
   thread id it calls `openUrl`, honoring the client's browser preference.
4. If nothing prevented the event's default, the content script opens the URL
   in a new tab, the same `window.open(url, "_blank", "noopener,noreferrer")`
   BB's browser build uses.

Fragile parts, each pinned by `host-contract.test.ts`, which greps the
installed BB bundle:

- Markdown links must stay real anchors (`markdown-preview.tsx`,
  `MarkdownAnchor`); tool-row titles are plain spans and are not intercepted.
- The two thread route shapes (`useRouteState.ts`).
- The `window.open` fallback (`url-open-routing.tsx`).
- The slot names `experimental_threadHeaderAction`, `experimental_appOverlay`,
  `openThreadPanel`, `contentScripts`.
- Split-pane matching relies on the header action's DOM node sharing a pane
  ancestor with the clicked anchor; BB has no public pane marker.
- The desktop in-app browser preference is bypassed for intercepted PR links.

## Opening a PR from another plugin

The sidebar (or any plugin) opens a PR in this viewer by dispatching the same
event; no import is needed:

```ts
const event = new CustomEvent("bb-plugins:open-pull-request", {
  cancelable: true,
  detail: { url: pullRequest.url, threadId: thread.id },
});
window.dispatchEvent(event);
if (!event.defaultPrevented) navigate.openUrl(pullRequest.url); // plugin not installed
```

`defaultPrevented` is true when the request was taken: the thread's pane
opened the tab, or the app navigated to the thread and will open it on
arrival. It is false only when this plugin is not loaded, so the caller keeps
its old behavior as the fallback. Linked PRs for a thread are readable
without RPC through the thread's plugin metadata (`github-prs.pullRequests`).

The Threads sidebar reads that metadata for its row chips. A plugin app only
receives its own realtime signals, so it cannot subscribe to
`pull-requests-changed`; instead every link change also calls the sidebar's
`pullRequestsChanged` RPC (`bb.sdk.plugins.callRpc`, plugin id `sidebar`)
once the metadata mirror has landed. The sidebar republishes the bump on its
own channel and refetches. The call is best effort and fails silently when
the sidebar is not installed; a sidebar running against an older copy of this
plugin still gets its chips on list refresh and reconnection.

## Tests

```sh
npm test            # vitest: server, links, tools, app slots, interception, bundle contract
npm run typecheck
```

`host-contract.test.ts` needs an installed `bb-app` (found through the `bb`
binary or `BB_APP_DIR`); it skips with a warning otherwise.

## Upstream asks

- **URL opener registry**: `app.slots.experimental_urlOpener({ match(url),
  open({ url, threadId }) })` consulted by `openUrlByPreference` before the
  browser preference, like the `fileOpener` registry. Removes the content
  script and the split-pane guesswork.
- **Context menu slot**: a `contextMenuAction` matching on link href, file,
  or message, so "Link to this thread" can sit next to Copy Link instead of
  replacing the native menu.
- **Thread-targeted `openThreadPanel`**: callable from an app overlay with a
  thread id, so a request for a thread not in view does not need the
  navigate-and-park detour.
- **Thread plugin metadata change events**: a signal when metadata changes,
  so the sidebar can read links without a second realtime channel.
