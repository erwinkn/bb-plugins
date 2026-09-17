---
name: github-pull-requests
description: Use when you create, open, review, or discuss a GitHub pull request in a BB thread. Link the PR to the thread so it shows in the thread's GitHub PR panel and sidebar.
---

# GitHub pull requests in BB

BB keeps a list of pull requests linked to each thread. The list drives the
thread's **GitHub PR** side panel and the sidebar, and it is mirrored into the
thread's plugin metadata under `github-prs.pullRequests` for other tools to read.

## What links itself

The pull request of the thread's own branch links itself: after every turn,
BB looks up the PR for the environment's branch (the same lookup as the
sidebar chip) and records it — but only on a thread-dedicated worktree whose
branch is not the default branch. On a shared project checkout nothing links
itself, so call `github_link_pr` for PRs the thread works on. Listing is
read-only and never creates a link. You do not need to link a PR you opened
from the current branch, but linking it again is harmless.

## What you must link

Call `github_link_pr` with the PR URL:

- right after you create a pull request with `gh pr create` or the GitHub API
  from a branch other than the thread's current one;
- when the user asks you to review, compare, fix up, or discuss a PR from
  another branch or repository;
- when a PR you found is the subject of the work, not just a passing mention.

Accepted references: the full URL, `owner/repo#123`, or `#123`. A bare number
resolves against the checkout's `origin` remote; use the full URL when the PR
lives in another repository.

Do not link every PR that appears in search results or logs. One link per PR
that this thread creates or works on.

## Tools

- `github_link_pr {reference}` — link; returns `linked` or `already-linked`.
- `github_unlink_pr {reference}` — remove a link that was a mistake.
- `github_list_prs {}` — the current links with last seen title and state.

CLI fallback (also for sessions started before the tools were installed):

```sh
bb github link https://github.com/owner/repo/pull/123
bb github links
bb github unlink owner/repo#123
```

The CLI targets the current thread; pass `--thread <id>` to target another.
