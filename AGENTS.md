# Hi!

BB is an agentic IDE for working with coding agents in projects and threads.
This repository contains my plugins for BB.

When I request a feature or change, check whether it belongs in a plugin,
upstream in BB, or in another project. If it belongs elsewhere, tell me why
and suggest where and how to file an issue or feature request. Record desired
upstream changes in README.md, with their issue links when available.

## Plugin update workflow

Keep normal plugin installations on Git `main`. Use this sequence for updates:

1. Create or reuse a feature branch, fetch `origin`, and rebase onto
   `origin/main`. Preserve other work and resolve conflicts before testing.
2. Build the affected plugin and run its relevant checks. Commit the change,
   push the branch to `origin`, and open a **draft** PR against `main`.
3. Switch only the affected plugin to that Git branch, preserving its ID,
   settings, secrets, schedules, and data. Do not use a temporary worktree path.
4. Verify the installed source and resolved commit, then test the changed
   behavior in BB. Include desktop and mobile checks when the UI changes.
5. Fix failures, push, update the branch installation, and repeat the affected
   checks. Record the tested commit and evidence in the PR.
6. Mark the PR ready for review only after live verification passes. Monitor
   checks and review comments, address valid findings, and repeat verification
   after fixes. Continue until checks pass and review findings are resolved on
   the latest commit. Report pending or unavailable reviews honestly.
7. Return the PR to the user for the merge decision. Do not merge or enable
   auto-merge. Leave the tested branch installed while the PR is open.
8. After the user merges, confirm the merge on GitHub, switch the plugin back
   to Git `main`, update it, and verify the resolved commit and behavior. A
   squash merge creates a new commit. Do not leave the test branch installed.

If the change is abandoned, restore `main`. Coordinate before replacing an
installation another thread is testing. Check BB's current source-change
commands before use; do not remove an installation with data just to change
its ref. A remove/install fallback is allowed only after verifying that the
plugin has no server-side settings, secrets, schedules, or stored data. Keep
client preferences and the plugin ID unchanged. If BB cannot preserve existing
data, report the exact limitation and record the required upstream change.
See README.md for the verified fallback and rollback procedure.
