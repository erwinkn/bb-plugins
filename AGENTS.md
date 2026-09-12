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

Development runs through one long-lived **PM thread per plugin**, pinned in
the "Plugin PMs" section of the `bb-plugins` project. Each PM has a
persistent managed-worktree environment — its desk. It is the only agent
that performs git operations there, and only one thread works on a plugin at
a time. The PM works in its environment directly or spawns child threads
that **reuse** its environment; children never get separate worktrees for
the same plugin. Route plugin changes to the owning PM. Orchestrator threads
dispatch to PMs rather than editing plugin code directly.

## Plugin update workflow

Keep normal plugin installations on `path:` sources under the main checkout
`~/Code/bb-plugins`, which always stays on `main` and is updated with
`git pull --ff-only`. Never check out a feature branch in the main checkout,
and never run `git rebase` or `git reset --hard` there while any PM has
unmerged work. Trivial changes that need no review (docs, comments, small
fixes) may be committed on `main` in the main checkout; everything else uses
this sequence:

1. In the PM worktree, fetch `origin`, create the feature branch from
   `origin/main`, and implement. Preserve other work and resolve conflicts
   before testing.
2. Run `bb plugin dev <pm-worktree>/plugins/<name>` while editing to rebuild
   and reload as files change. Move the affected plugin's install to the
   worktree in place with
   `bb plugin install path:<pm-worktree>/plugins/<name> --yes`, preserving
   its ID, settings, secrets, schedules, and data. Verify the new source.
   Keep the worktree until the installation uses another source.
3. Build the affected plugin, run its checks, commit, push the branch to
   `origin`, and open a **draft** PR against `main`.
4. Test the changed behavior in BB. Include desktop and mobile checks when
   the UI changes. Record the tested commit and evidence in the PR.
5. Fix failures, push, rebuild, and repeat the affected checks.
6. Keep the PR in draft until the human explicitly requests that it be marked
   ready for review. Passing checks, completed live verification, or a general
   request to finish the work does not authorize this transition. Before marking
   it ready, remove temporary work files from the PR diff and from any content
   sent to review agents. This includes plans, review notes, Markdown documents,
   HTML previews, prototype scripts, and other files created for development
   that the plugin does not need. Keep tests and files required to build, run,
   or use the plugin. Keep repository instructions and documentation changes
   that the user explicitly requested. Check the final PR diff for these files
   before requesting agent reviews, including reviews while the PR is in draft.
   Extra review content consumes credits and costs money. Mark the PR ready only
   after the user's explicit request, this cleanup, and successful live
   verification. Monitor
   checks and review comments while it is in draft and after it is marked ready.
   Address valid findings and repeat verification after fixes. Continue until
   checks pass and review findings are resolved on the latest commit. Report
   pending or unavailable reviews honestly.
7. Return the PR to the user for the merge decision. Do not merge or enable
   auto-merge. Leave the tested source installed while the PR is open.
8. After the user merges, confirm the merge on GitHub, pull the main
   checkout, move the install back to
   `path:~/Code/bb-plugins/plugins/<name>`, rebuild, and verify the resolved
   commit and behavior. A squash merge creates a new commit. Do not leave the
   PM worktree installed, and never delete a worktree while an install still
   points at it.

If the change is abandoned, move the install back to the main checkout path
before abandoning the branch. Coordinate with the owning PM before replacing
an installation its threads are testing. Check BB's current source-change
commands before use; do not remove an installation with data just to change
its source or ref. Local development does not bypass this rule. A
remove/install fallback is allowed only after verifying that the plugin has
no server-side settings, secrets, schedules, or stored data — otherwise back
up the plugin's data directory, settings, and secrets first. Keep client
preferences and the plugin ID unchanged. If BB cannot preserve existing
data, report the exact limitation and record the required upstream change.
See README.md for the verified fallback and rollback procedure.
