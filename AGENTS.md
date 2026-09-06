# Hi!

BB is an agentic IDE for working with coding agents in projects and threads.
This repository contains my plugins for BB.

When I request a feature or change, check whether it belongs in a plugin,
upstream in BB, or in another project. If it belongs elsewhere, tell me why
and suggest where and how to file an issue or feature request. Record desired
upstream changes in README.md, with their issue links when available.

## Plugin update workflow

Keep normal plugin installations on Git `main`. To test an update, push the
working branch and switch only the affected plugin's Git ref to that branch.
Build and run the relevant checks before installation, then verify behavior in BB.
Use the branch ref instead of a temporary worktree path for this workflow.

Keep the plugin on the branch while fixing failed checks. If the change is
abandoned, restore `main`. Merge a PR only when the user authorizes it.
After a squash merge, switch the plugin back to `main`, update it, and verify
that BB runs the merged commit without errors. Restoring `main` is part of
finishing the update; do not leave the plugin on the test branch.

Preserve plugin settings and data when changing sources. Check BB's current
source-change commands before use; do not remove an installation with data
just to change its ref. See the workflow in README.md.
