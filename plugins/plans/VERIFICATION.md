# Prototype verification

Checked on 2026-09-07 with BB 0.42.1 and Plugin SDK 0.4.47.

## Passed

- `npm run typecheck`
- `npm test`: 50 tests across backend, UI regression, and app slot suites.
- `npm run build`: backend and frontend artifacts identify `erwin-plans`.
- Browser preview: create a plan, select text with the keyboard, save a quoted
  comment, send feedback, import a second version, view changes, and approve the second version (the original check used
  the since-removed Resolve control).
- The preview receiver recorded exactly two messages for that flow: a revision
  request containing the comment and its original version ID, then approval
  containing the second version's ID and full Markdown. Both targeted the
  linked preview thread with `queue-if-active`.
- Sample creation, comments, and feedback do not send agent messages.
- Desktop layout and a 390 by 844 phone viewport, in light and dark themes.
  The phone page had no horizontal overflow. The document, comments, decision
  footer, version selector, and thread panel were reachable.
- No browser runtime errors during the checked flow.
- Final UI fixes: pending quotes stay highlighted, the Changes view directs
  reviewers to Document for comments, preview overlays follow the root theme,
  and the narrow version control hides the latest suffix. The UI implementer
  checked the dark dropdown in headless Chromium.
- The real BB shell puts its dark class on the document root. The preview
  now follows that structure.

The independent Fable UI reviewer supplied 19 regression tests and checked that
the relevant tests fail when the original selection, draft, and render-loop
bugs are restored in a temporary copy.

The CSS optimizer reports four warnings about `::highlight`. It retains the
rules, and highlights rendered in the checked browser.

## Original pre-install checklist (completed below)

- User triage of `DECISIONS.md`, then commit, push, and a draft PR.
- Install that Git branch in the normal BB instance and verify its resolved
  commit. No normal installation was changed during preview testing.
- Check the actual BB thread panel, auto-opening on submission, and
  BB's own Markdown and diff renderers. The preview uses a Markdown stand-in and a separate Pierre integration;
  it does not prove these host behaviors.
- Send feedback to a real test thread and verify that its agent submits a new
  version and receives approval for the intended version.
- Check selection on a real touch device. The phone viewport checks prove
  layout; the regression suite simulates touch events. Neither proves iOS
  Safari's native selection behavior.

Leave the PR in draft until these installation checks pass. Do not merge it.

## Annotation update

- Minimal comment popup verified in the preview thread panel.
- Redline and Looks good save from the selection toolbar. Red and green
  highlights rendered at desktop and 390-pixel phone widths without overflow.
- Backend tests verify removal feedback, redline approval blocking, positive
  annotations sent with feedback or approval, validation, and duplicate delivery.
- The preview was restarted with a fresh Annotation test plan left in Review.

## Thread-only scope

Removed the standalone nav page and sidebar accessory. App tests now exercise
review flows through the thread panel, including thread-bound creation and a
thread-specific plan picker with pagination.

## Review controls update

Verified the compact positive card, vertical menu, D/G shortcuts, and no
scrollbar in the single-row note. Shortcut labels are hidden on mobile.
Accept deletion was removed at the user's request: redlines remain feedback for
the agent, and no annotation action edits the plan Markdown.

## Header cleanup

Removed status badge, project/raw-thread metadata, and Resolve all. The version
picker sits beside the title; tabs occupy their own row. Desktop thread-panel
and 390-pixel phone checks passed without horizontal overflow. Older comments
remain reachable through Show. The later comment-control update removes
individual Resolve controls too.

## Version and diff cleanup

Timestamp is compact beside the title, with the full date available on hover.
Version controls are inline number-and-caret selectors. Changes displays colored
addition/deletion counts and passes only hunks to the host diff renderer, using
the SDK's supported headerless-patch input. The preview shows no filename or
separator. Verified at 390 pixels without horizontal overflow.

## Pierre preview rendering

Replaced the raw-patch preview painter with @pierre/diffs PatchDiff. Preloads the
Markdown highlighter before mounting, hides file headers, uses simple hunk
separators, and follows the preview theme. Verified rendered additions/deletions
and word highlights on desktop and at 390 pixels; no raw @@ line or overflow.
Production continues to use BB's native experimental_Diff component.

## Comment controls and phone warning

Removed Resolve from comment cards. Unchecked quote anchors no longer display a
missing-passage warning when saving switches from Document to Comments. Tests
cover the warning and the approval rule: sent feedback remains in history and
permits approval after a new revision; unsent feedback still blocks approval.

The document now stays mounted across tabs; only visibility and interaction
change. Quote matching continues while Comments or Changes is open. A regression
test adds both a present and an absent quote while Comments is selected and
checks that only the absent quote reports a missing passage.

## View selector

Replaced the view tabs with an icon select before the version picker. The icon
reflects the current view; menu options retain labels and the comment count.
Browser checks confirm view switching and no horizontal overflow at phone and
desktop viewport widths. The document remains mounted across view switches.

## Release preparation

Rebased onto origin/main, checked SDK 0.4.47 compatibility, added the bundled
plan-review skill, and updated install and store descriptions. Added coverage
for note-only feedback and identical-text revisions. The real Git installation
and fresh-provider skill checks remain pending; the preview is not an installed
plugin and its sample data is not copied into BB.

Independent release review confirmed the manifest, SDK pin, skill registration,
thread-panel action IDs, thread ownership checks, and delivery locking. The
sample test and identical-text revision findings were fixed during review; the
subsequent full run passed 50 tests. The first live check must confirm that
queue-if-active wakes an idle thread as well as queues for an active thread.

## Live BB installation — 2026-09-07

Installed the Git feature branch, not a worktree path, at runtime commit
`dd2d8bb5488846e746e41864c43c54ef552699a7`. `bb plugin source erwin-plans`
confirmed the branch, commit, and plugins/plans subdirectory. BB reported the
server running, the frontend compatible, and plans_submit plus plan-review
registered. The following checks used BB at port 38886, not the Vite preview.

- Fresh Fable 5.1 High thread `thr_58yed643zz` submitted through the native tool.
  The tool was deferred and found with ToolSearch. The Plan panel auto-opened.
- Selected a passage rendered by BB Markdown, saved a comment, and confirmed its
  quote and unsent state through the installed CLI. No false anchor warning.
- Send feedback woke the idle thread with queue-if-active. The agent submitted
  v2 of the same plan with the requested line-count verification and stopped.
- BB's native diff rendered additions, deletions, and word changes at 390x844;
  the view menu and version control fit, with no horizontal overflow.
- Approval through the phone-width confirmation woke the idle thread and sent
  the exact v2. The agent created only /tmp/plans-live-proof.md. The parent
  independently read the file and confirmed exactly two lines.
- Reloaded erwin-plans. Its approved status, two versions, and sent comment all
  survived. No source files were changed by the acceptance thread.
- The skill was registered by BB but absent from Claude's first Skill menu.
  The agent read its installed file directly. Local copies were added under
  ~/.claude/skills/plan-review and ~/.agents/skills/plan-review; the agent then
  confirmed Skill-menu discovery on its approval turn. No AI config sync.
- Left another open plan, `ca31fa9d-191c-48ed-8052-74a5e223f545`, in the parent
  thread for manual annotation. It was submitted with the installed CLI.

Evidence screenshots: /tmp/plans-bb-comment-desktop.png and
/tmp/plans-bb-mobile-diff.png. Browser console check reported no runtime errors.
These are real-host browser checks at desktop and phone viewport widths;
native iOS selection was not separately tested in this run.

GitHub checks: Socket passed. Devin reported a pass but skipped its review
because its trial expired; Macroscope skipped the draft PR. These are not
independent correctness approvals. The earlier independent Fable review and
its addressed findings are recorded above.

## Greptile thread-scope regression

PlanReviewLoader now rejects a loaded plan whose thread ID differs from the
panel thread. Added slot tests for foreign-plan rejection and a valid requested
plan absent from the list page. Full suite: 52 tests.

## Selection and spacing update

Annotation actions stay hidden from pointer down until pointer up (including
release outside the document). A regression test checks expanding a selection
and starting a second drag. Document, header, and footer use the same left
padding. The note shares a row with actions above the wide-container breakpoint
and stacks on narrow panels.

## Bugbot state and diff regressions

ThreadPlanPanel remounts its stateful content per thread ID. A slot test switches
a mounted panel from a chosen plan to an empty thread and back. Diff comparison
now normalizes trailing newlines before its equality check; tests cover both
newline directions and a real line change. Full suite: 56 tests. These fixes
close the two Bugbot findings from 67592f8; its security review had no findings.
