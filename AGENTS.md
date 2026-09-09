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
2. Install the affected plugin from the local worktree for development, subject
   to the data-preservation rules below. Use `bb plugin dev <plugin-path>` to
   rebuild and reload as files change. Run relevant checks and test in BB.
   Keep the worktree available until the installation uses another source.
3. Build the affected plugin, commit the change, push the branch to `origin`,
   and open a **draft** PR against `main`. Switch only the affected plugin to
   that Git branch, preserving its ID, settings, secrets, schedules, and data.
4. Verify the installed source and resolved commit, then test the changed
   behavior in BB. Include desktop and mobile checks when the UI changes.
5. Fix failures, push, update the branch installation, and repeat the affected
   checks. Record the tested commit and evidence in the PR.
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
   auto-merge. Leave the tested branch installed while the PR is open.
8. After the user merges, confirm the merge on GitHub, switch the plugin back
   to Git `main`, update it, and verify the resolved commit and behavior. A
   squash merge creates a new commit. Do not leave the test branch installed.

If the change is abandoned, restore `main`. Coordinate before replacing an
installation another thread is testing. Check BB's current source-change
commands before use; do not remove an installation with data just to change
its source or ref. Local development does not bypass this rule. If a safe
source switch is unavailable, use the Git-branch workflow for that installation.
A remove/install fallback is allowed only after verifying that the
plugin has no server-side settings, secrets, schedules, or stored data. Keep
client preferences and the plugin ID unchanged. If BB cannot preserve existing
data, report the exact limitation and record the required upstream change.
See README.md for the verified fallback and rollback procedure.
