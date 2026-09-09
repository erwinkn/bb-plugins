Review plans beside the agent conversation while the agent updates the text.

## Live review

Select text to comment, ask a question, request removal, or mark a passage as good.
Each annotation reaches the agent as a thread message.
The agent answers questions and edits the plan in place.
The panel follows the latest version.
It records the last-seen version when the latest Document view is visible.
The update banner clears after three seconds of viewing, on Show changes, or on dismiss.
Highlights stay for answered and addressed annotations.
Withdrawn annotations have no highlight.
Cards show Pending before delivery and Delivered after delivery, unless they have another state.
Compare any two versions.
Approve the plan when it is ready for implementation.
You can approve with open annotations.
Approval binds to the viewed version, which must still be the latest.
The footer shows whether the approval is pending, delivered, or dropped.

## Submit a plan

Ask the agent to submit a plan in BB.
The bundled `plan-review` skill uses tools that return at once on every harness.
The agent ends its turn after submission and each handoff.
The review prompt gives the thread the needs attention state.
You can write general remarks in the thread composer at any time.
`plans_handoff` creates no prompt while a plugin message is still queued for the thread.
The queued message already brings the agent back.
The `bb plans` commands also support this flow.
The plugin does not control native provider plan modes.

## Requirements and storage

Requires BB 0.42.1 or later.
No separate account or service is required.
The plugin database stores plans, versions, annotations with replies, and an outbox of events.
Delivered and dropped rows stay until the plan is deleted.
Migration runs for all plans at plugin start.
It drops old pending deliveries and moves their unsent annotations to the outbox.
Old general notes in pending deliveries are lost; the log names the dropped deliveries.
Failed deliveries retry automatically.
Each plan defaults to delivery after the current turn.
Its Delivery menu can select delivery into the running turn.
A delivery mode change applies to the next batch.
A batch already queued stays in its row.
If the provider rejects steering, the plugin sends that message with `queue-if-active`.
The selected mode stays unchanged, and the panel shows a notice.
The plugin drops feedback for an archived or deleted thread and shows a notice in the panel.
It does not replay that feedback after the thread is restored.
Draft text stays in the browser.
Agent work uses the thread's provider account.

## Annotation states

`plans_update.resolves` sets each named annotation to **addressed**, including asks.
`plans_reply` sets an ask to **answered** by default.
With `resolve=false`, it keeps the current state, including **answered** or **addressed**.
For a comment or redline, a reply keeps the state by default; `resolve=true` sets **addressed**.
User replies do not reopen annotations.
Manual **Resolve** sets **addressed** and sends no message.
A withdrawal sends `withdrawn #n` only if the annotation was already delivered.
The plugin removes an undelivered annotation from the pending batch without a message.
