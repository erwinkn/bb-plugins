# Hi!

BB is an agentic IDE for working with coding agents in projects and threads.
This repository contains my plugins for BB.

When I request a feature or change, check whether it belongs in a plugin,
upstream in BB, or in another project. If it belongs elsewhere, tell me why
and suggest where and how to file an issue or feature request. Record desired
upstream changes in README.md, with their issue links when available.

Never file issues, feature requests, pull requests, or comments on any external
repository (including get-bb/bb) without my explicit request or approval in the
current conversation. This applies to every task, not just plugin
implementation: a recorded README entry, a suggested issue title, or a past
filing is not authorization. Record candidates in README.md and propose them to
me instead.

## Development topology

This repository is developed from the **main checkout** at `~/Code/bb-plugins`
by one **orchestrator thread** plus short-lived child threads. There are no
per-plugin PM threads and no feature branches or pull requests for routine
work. Each child works in its own BB-managed Git worktree (Erwin, D420), so the
main checkout only ever holds reviewed, committed code: BB compiles path-installed
plugins from that checkout on every reload or restart.

- The orchestrator is the only agent that runs Git commands: pull, add,
  commit, push, stash, checkout. Child threads never touch Git.
- The user talks to the orchestrator. For a change to a plugin, the
  orchestrator spawns a child thread (its own worktree) with the full task;
  the child investigates, implements, verifies, and reports back; the
  orchestrator applies the child's diff to the main checkout, tests, commits
  and reloads. When a child has reported and its work is
  committed or reverted, the orchestrator archives it.
- Spawn children on the Linux host (BB's project default creates the
  worktree there), never on `env_pepnyn24rr` (its registered path is the Mac
  checkout), always with `--permission-mode full`.
  Use one Claude Opus 5.5 work child (high reasoning) per substantial batch,
  combining related features, plus one independent review child, preferably
  from another model family such as Codex GPT-6.1 Sol. Small fixes get no
  separate review, and more work children need the user's explicit yes. Keep
  the orchestrator in `full` before spawning, or spawn without
  `--parent-thread` — a parent in `auto` silently clamps the child. See
  README.md §"The daily loop" for exact spawn flags.
- One child per plugin at a time. Parallel children are fine when they touch
  different plugins; the orchestrator sequences commits so each commit is one
  coherent change.

## Plugin update workflow

Every plugin installs from the main checkout's path —
`path:~/Code/bb-plugins/plugins/<name>` — never a `git:` ref. The running
plugin tracks whatever the checkout contains.

1. The orchestrator confirms the checkout is clean and on `main`
   (`git status`, `git pull --ff-only`), then spawns a child with the brief:
   plugin directory, expected behavior, verification commands.
2. The child works in `plugins/<name>` inside its own worktree and may run
   `npm run typecheck` and `npm test` there. It reports files changed and what
   it verified. It does not commit.
3. The orchestrator applies the child's diff to the main checkout
   (`git -C <worktree> diff | git apply`), reruns the tests, runs
   `bb plugin reload`, and the user checks the live behavior. Testing
   and diff review stay with children; a substantial change gets a review
   child rather than an orchestrator-side check.
4. If it is good, the orchestrator commits on `main` and pushes to `origin`
   directly. If not, it sends follow-up instructions to the same child, or
   reverts the working tree with `git checkout -- <paths>`.

Keeping the Git state healthy is the orchestrator's job:

- Commit only files that belong to the change; leave unrelated working-tree
  changes alone and ask the user about anything unexpected.
- Never leave a half-applied change in the checkout across sessions.
- Run `git pull --ff-only` before each new piece of work. If the pull is not
  a fast-forward, stop and report; do not rebase or reset.
- Do not use `git stash` as long-term storage; stash only to pull and pop
  immediately.
- Trivial doc and comment fixes may be made by the orchestrator itself without
  a child thread, under the same commit rules.

Larger or riskier changes may still use a feature branch and a draft PR, but
only when the user asks for it. In that case the branch is created in a
separate clone or worktree, never in the main checkout, and the install stays
on the main checkout path until merge.

For plugin installs, source switches, and data preservation — including why
`path:` sources are required and when a remove/install fallback is allowed —
follow README.md §"The daily loop" and §"Source switches and data
preservation"; those sections are authoritative.
