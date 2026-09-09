# Plans release decisions

This audit covers the plugin prepared from the approved UI. Publication and installation
follow the repository's review workflow. See `VERIFICATION.md` for the completed
checks and the remaining checks in BB.

The following sections record earlier decisions and checks.
The live review decisions below replace the named earlier choices.
Earlier verification does not prove the live review flow.

## Choices to review

| ID | Choice | Other option | Confidence | When this choice could fail |
| --- | --- | --- | --- | --- |
| D01 | Build a BB interface using BB Markdown, diff, and panel components. | Adapt Plannotator's UI package or embed its app. | Medium | Our annotation handling could take more maintenance than a reused editor. |
| D02 | Use an explicit submission tool and CLI. Tell the agent to stop after submission. | Integrate each provider's native plan approval. | Medium | An agent can ignore the instruction and continue. This prototype is not an execution gate. |
| D03 | Keep unsent text drafts in the browser. Save comments on the BB server. | Save every draft on the server. | Medium | A note started on desktop will not appear on a phone until saved as a comment or sent. |
| D04 | Pin comments to a version and quote. Highlight only a unique match; keep the composer minimal and show anchor details in saved cards. | Store document positions and remap them across edits. | Medium | Repeated text can require reading the quote without a highlight. |
| D05 | Block edits after uncertain delivery and require receipt reconciliation through the CLI. | Automatically retry or add a full delivery recovery screen. | Medium | A lost connection can require manual work even if BB received the review. Superseded by D28. |
| D06 | Unsent comments and redlines block approval; sent feedback requires a new revision. Looks good does not block approval. | Allow approval with open comments. | Medium | Sent feedback stays in the history and does not block a newer revision. Superseded by D29. |
| D07 | Use a standalone preview with the actual backend and simulated agent delivery before installation. | Test only inside the normal BB installation. | Medium | The preview cannot prove BB panel behavior, its Markdown rendering, or provider delivery. Live BB checks remain necessary. |
| D14 | Bound versions to 100,000 characters, comments and notes to 10,000 characters, UI selections to 2,000 characters, history content to 2 MB, and list pages to ten plans. The 2 MB limit counts plan text, annotation bodies, quotes, and replies, not the whole serialized record. Version summaries and resolve references also count. | Allow unbounded storage and responses. | Medium | A large plan history reaches the limit and needs a new plan. Long selections must be shortened. These are prototype limits, not measured usage thresholds. |
| D16 | Keep plan deletion explicit in the UI and delete its review receipts with it. | Keep deleted plans in an archive. | Medium | A deleted plan has no built-in undo. |
| D08 | Store complete plan snapshots as JSON rows in plugin SQLite. | Store Markdown files in each worktree or use separate relational version tables. | High | Plans do not automatically appear in Git, and large histories require a storage redesign. |
| D09 | Send feedback and approval to the original thread with queue-if-active. | Interrupt the active turn or create a separate revision thread. | High | A busy thread can delay the requested revision. Superseded by D25. |
| D10 | Bind approval to an exact version and retain successful delivery request IDs. | Approve whichever version is current at delivery time. | High | A stale browser tab must refresh before it can submit a review. |
| D11 | Keep sample plans unlinked to any thread. | Let samples use the currently selected agent. | High | Sample approval demonstrates state changes, not real implementation. |
| D12 | Open submitted plans only in a matching visible thread panel. | Navigate to Plans whenever any thread submits a plan. | High | Submissions in other threads are reviewed by opening their thread panels. |
| D13 | Make sent comments immutable; allow unsent comments to be edited or removed. | Allow edits to the full review history. | High | A correction to sent feedback needs another comment. Superseded by D26. |
| D15 | Read CLI files through the invoking thread's host and BB file API. | Read paths on the BB server. | High | Submission fails when the invoking environment or working directory is unavailable. |

The UI is limited to per-thread panels at the user’s request. The standalone
Plans page, sidebar count, global creation form, and page navigation were removed.

## Plannotator reuse assessment

Plannotator exposes a source UI package with components, hooks, styles, and
several editor dependencies. Reuse is possible. This prototype uses BB's existing
renderers and a smaller review interface. No Plannotator source code was copied.
The review cycle is the product reference.

Sources checked on 2026-09-07:
[Plannotator repository](https://github.com/backnotprop/plannotator) and
[UI package manifest](https://github.com/backnotprop/plannotator/blob/main/packages/ui/package.json).

## Verification and verdict

Backend checks pass for revision history, stale approval, quoted feedback,
duplicate requests, simultaneous approvals, reload persistence, sample isolation,
uncertain delivery, thread ownership, and remote file routing.

Type checking, all 50 tests, the plugin build, and the standalone browser review
flow pass. Desktop and phone-width layouts were checked in light and dark themes.

I stand behind this branch for a draft release. The normal BB installation,
real agent delivery, and native touch selection still need live verification.
In particular, the first live check must confirm idle-thread activation with
queue-if-active. I do not yet stand behind a production-readiness claim.
The package is ready for user triage before commit and a draft PR; it is not
ready to merge.

## Release preparation decisions

| ID | Choice | Other option | Confidence | When this choice could fail |
| --- | --- | --- | --- | --- |
| D17 | Bundle a narrowly triggered `plan-review` skill for explicit Plans requests and review messages. | Require users to name the submission tool every time. | High | An existing provider session may need to restart before it sees the skill. |
| D18 | Keep the rendered document and quote index mounted while another view is visible. | Build an independent Markdown-to-text parser and map positions between both renderers. | High | Large plans retain their rendered DOM while the panel is open. BB renderer changes still require anchor checks. |
| D19 | After any feedback, require another submitted version before approval; permit an identical-text revision when revising. | Let a user approve the prior version immediately after requesting changes. | Medium | An agent that decides no text change is needed must still resubmit to finish the review cycle. Superseded by D29. |
| D20 | Keep the standalone demo for development, separate from installed plugin entry points. | Remove the demo after installation. | High | The demo is not evidence of a real provider integration. |
| D21 | Extend two select interaction test timeouts to 15 seconds; preserve their assertions. | Replace Radix Select with a mock in the slot tests. | Medium | These jsdom tests take about 10 seconds each and can be slow on CI. Actual menu behavior was checked in Chromium. |
| D22 | Use approximate 30-day months and 365-day years for the compact header age; show the exact date on hover. | Use calendar boundaries or show a date in the header. | High | Ages near a calendar boundary can differ by a day from calendar-based calculations. |

The approved UI is unchanged during release preparation. The Git branch is
rebased onto current main. The new agent skill and the exact installed host flow
still require verification after installation. No merge is authorized.

## User triage — 2026-09-07

Accepted for branch installation. Use our own BB implementation; do not reuse
Plannotator code. The standalone preview is only for UI iteration. Verify the
actual installed plugin in BB with a plan. Commit the BB-specific skill in this
repository and distribute it with the plugin; no AI config sync is required now.

## Live verification verdict

The installed Git branch passed the actual BB review cycle, including idle-agent
activation, native tool submission, Markdown annotations, native diff, approval,
and reload persistence. I stand behind the branch for review and continued use.
The user retains the merge decision. Native iOS selection and correctness
services that skipped this PR are not claimed as verified.

## Review fix: thread scope

A plan opened through panel parameters is checked against the panel thread ID
after loading and before rendering review controls. This enforces the accepted
per-thread scope without rejecting older plans absent from a paginated list.
No new user-facing workflow or permission boundary is introduced.

## Live review decisions — 2026-09-09

| ID | Choice | Other option | Confidence | When this choice could fail |
| --- | --- | --- | --- | --- |
| D23 | Tools never block on any harness. End the turn after submission and handoff. | Keep a tool call open until the user acts. | High | An agent can ignore the instruction to end its turn. |
| D24 | Hold the review prompt while idle. Release it before any message reaches the thread, including any queued message. Handoff creates no prompt while a plugin message is queued for the thread; that message already brings the agent back. | Hold the prompt until a plan action releases it. | Medium | BB might not dispatch a queued message when the plugin releases the prompt. |
| D25 | Store delivery mode per plan. Default to queue-if-active. Offer steer-if-active in the plan menu. A mode change applies to the next batch; an existing queued batch stays in its row. If the provider rejects steering, send that message with queue-if-active, keep the selected mode, and show a notice. | Use one global mode. | High | A provider might reject delivery into a running turn. |
| D26 | Use comment, ask, redline, and looks good. Keep delivered text fixed. Allow replies, withdrawals, and resolution. | Use one comment kind for every intent. | High | An agent might treat an ask as a change request or miss a settled question. |
| D27 | Store every agent edit as a version. Keep the panel on the latest text. Allow any two versions to compare. | Require a separate submission for each change. | High | Frequent edits can distract the reviewer or reach the history size limit. |
| D28 | Retry failed delivery automatically with backoff. Show undelivered items in the panel. Drop feedback for archived or deleted threads with a panel notice. Do not replay it after restore. Keep delivered and dropped rows until plan deletion. | Require manual delivery recovery. | Medium | A lasting service failure can delay feedback despite repeated attempts. |
| D29 | Allow approval with open annotations. Show their count in the dialog. | Require all annotations to close before approval. | High | The user might approve while an important question remains open. |
| D30 | Use the thread composer for general remarks. Remove the general note box. | Keep a separate note field in the plan panel. | High | An agent might miss a thread remark that has no annotation number. |
| D31 | Bind approval to the viewed version. Reject it if that version is no longer the latest. Keep request ID idempotence and name the approved version in the outbox event. | Approve the latest version without checking what the user viewed. | High | A stale panel must show the latest version before the user can approve. |
| D32 | Count a queued row missing at recovery as dispatched. BB offers no durable dispatch evidence. Stop the retry loop there. | Retry the message after a missing queue row. | Medium | A deleted queue row can count as delivered even if BB did not dispatch it. Retrying can send duplicate feedback. |
