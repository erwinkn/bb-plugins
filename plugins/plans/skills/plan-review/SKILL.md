---
name: plan-review
description: Use for explicit BB Plans submissions, panel review requests, or feedback messages about a submitted plan.
---

# Plan review

Use this skill for the BB Plans review flow before implementation.
Do not use it for general brainstorming or unrelated implementation work.
Plan tools return at once by design on every harness.
End your turn after `plans_submit` and `plans_handoff`.
Do not poll.
Do not wait on a command.
Feedback arrives as thread messages.
The user can also write general remarks or questions in the thread at any time.
Treat those messages as part of the review.

## Submit

Read the relevant project context.
Prepare a complete Markdown plan.
Include the result, scope, steps, and checks.
State open questions clearly.
Call `plans_submit {title, markdown}`.
The tool saves the plan and puts a review prompt on the thread.
It returns the plan and version IDs at once.
End your turn without implementation.

If the native tool is unavailable, write a UTF-8 Markdown file in this thread's workspace.
Use the CLI:

```sh
bb plans submit ./plan.md 'Plan title'
```

End your turn after submission.
The prompt gives the thread the needs attention state.
The thread composer stays usable.
The plugin releases the prompt before any message reaches the thread.
This includes queued messages from the user or another plugin.
The next `plans_handoff` restores it when no plugin message is queued.
`plans_handoff` creates no prompt while a plugin message is still queued for the thread.
The queued message already brings the agent back.
Skip releases the prompt and leaves the plan open.
A plugin reload drops the prompt until the next handoff.
The plugin does not control native provider plan modes.

## Handle feedback

Annotations have per-plan numbers such as `#7`.
A comment requests a change.
An ask expects an answer, not a change.
A redline requests removal of the quoted text.
A looks good confirms a passage or settles an open question.
The panel uses keys C, A, D, and G for these kinds.
Comment and Ask open the composer.
Redline and Looks good save directly from the selection menu.

On each feedback message:

1. Reply to each ask with `plans_reply {planId, annotation, body, resolve}`.
   For asks, `resolve` defaults to true and marks the ask answered.
   You can also use this tool to comment on an annotation.
2. Apply comments and redlines with `plans_update {planId, edits, summary, resolves}`.
   Use exact-match `{old, new}` edit pairs.
   Each `old` must occur exactly once.
   You can supply full `markdown` instead of `edits`.
   Name the resolved annotation numbers in `resolves`, for example `["#7", "#9"]`.
3. Fold a looks good into the text if it settles an open question.
   Other looks good annotations need no change.
4. Address general remarks and questions from the thread.
5. Call `plans_handoff {planId}` at the end of every turn that touched the plan.
6. End your turn.

Use `plans_update` for an existing plan.
`plans_update.resolves` sets each named annotation to **addressed**, including asks.
`plans_reply` sets an ask to **answered** by default.
With `resolve=false`, it keeps the current state, including **answered** or **addressed**.
For a comment or redline, a reply keeps the state by default; `resolve=true` sets **addressed**.
User replies do not reopen annotations.
Manual **Resolve** sets **addressed** and sends no message.
Each edit creates a stored version, and the panel follows the latest text.
The user can compare any two versions.
Delivered annotations cannot be edited.
The user can withdraw them, reply to them, or mark them resolved.
A withdrawal sends `withdrawn #n` only if the annotation was already delivered.
The plugin removes an undelivered annotation from the pending batch without a message.

### Message format

```
Plan "Storage migration" (3f2c…)

#7 comment · L12
> Migrate the users table first
Do the sessions table first; users depends on it.

#8 ask · L40–42
> Run the backfill in a single transaction
Why one transaction? Can this lock the table for minutes?

#9 redline · L57
> Add a feature flag for the old path

#10 looks good · L88–90
> Open question 2: keep the old API for one release
```

The header names the plan and its ID.
Line labels refer to the current Markdown source.
Missing or repeated matches have no line label.
Later messages use `reply on #7`, `edited #7`, `withdrawn #8`, `approved v6`, and `delivery mode: steer-if-active`.
A reply repeats the original quote.
An `edited` item repeats the quote and gives the new body.
Apply the correction with the new body, even if you already addressed the annotation.
Quotes keep every word and collapse whitespace.
`edited #n` items have no line label.
Messages carry no instructions; this skill is the instruction.

Each plan defaults to `queue-if-active`.
Feedback then arrives after the current turn.
The user can select `steer-if-active` in that plan's Delivery menu.
Feedback then arrives during the running turn.
There is no global delivery setting.
A delivery mode change applies to the next batch.
A batch already queued stays in its row.
If the provider rejects steering, the plugin sends that message with `queue-if-active`.
The selected mode stays unchanged, and the panel shows a notice.
The plugin drops feedback for an archived or deleted thread and shows a notice in the panel.
It does not replay that feedback after the thread is restored.
The plugin groups nearby events and appends to its queued message.
Failed deliveries retry after 5 seconds, 30 seconds, 2 minutes, then every 5 minutes.
The panel shows **Not delivered · retrying**.

## CLI and context recovery

The CLI supports the same actions:

```text
bb plans submit <file> [title]
bb plans update <plan> <file> --summary <text> [--resolve #n ...]
bb plans reply <plan> <#n> <text> [--no-resolve]
bb plans handoff <plan>
bb plans get <plan> [--version-id <id>]
bb plans list [offset] [--thread <id>]
bb plans review <plan> --comment "quote::body" --ask "quote::body" --redline "quote" --looks-good "quote" [--approve]
```

Quote annotation numbers in shell commands, for example `'#7'`.
Use `bb plans get` after context loss.
Add `--version-id` to read the approved version.
Use `bb plans list` if you lost the plan ID.
Never review your own plan.
The `review` command serves a separate reviewer thread and rejects the plan's own thread.

## Implement

Implement only after the `approved` message.
Approve is the only terminal action.
The user can approve with open annotations.
The dialog states their count.
Approval binds to the version the user viewed.
If that version is no longer the latest, the user must review the latest version before approval.
Follow the approved version and the user's current instructions.
Approval does not grant extra authority to merge or deploy.
