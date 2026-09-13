# Plans

Review a Markdown plan beside its BB thread while the agent updates it.
Select text to request changes, ask questions, request removal, or confirm a passage.
Each annotation reaches the agent as a thread message.
The panel updates live with each agent edit.
Compare any two stored versions.
Approve the current plan when it is ready for implementation.

The plugin adds a **Plans** panel to each thread.
Use its tools in a normal thread.
The plugin does not control the provider's native plan mode.
A provider's own approval step remains separate.

## Install

Install from the repository's main branch after the change merges:

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin plans
```

Use the tested branch while its draft PR stays open.
Keep the plugin ID `plans` unchanged.
The plugin requires BB 0.43.1 or later because it writes thread plugin metadata.
New provider sessions receive the bundled `plan-review` skill and plan tools.
Existing sessions may need to restart or resume to receive new tools.

## Review flow

1. Ask the agent to submit a plan in BB.
   `plans_submit` saves the plan and puts a review prompt on the thread.
   The tool returns at once on every harness.
   The agent ends its turn.
2. Open **Plans** from the prompt or the **Plan** header button.
   The prompt says **Plan ready for your review** and offers **Open** and **Skip**.
   It gives the thread the **needs attention** state.
3. Select text to add an annotation.
   Each saved annotation enters message delivery at once.
   You can also write general remarks or questions in the thread composer at any time.
   These messages are part of the review.
4. The agent answers asks with `plans_reply` and applies changes with `plans_update`.
   Each edit creates a stored version.
   The panel shows the latest text as it changes.
   The agent calls `plans_handoff` at the end of each turn that touched the plan.
   It then ends its turn.
5. Use **Show changes** to inspect an agent update.
   The Changes view starts from the version you last saw.
   You can compare any two stored versions.
   The panel records the last-seen version when the latest Document view is visible.
   The update banner clears after three seconds of viewing, on **Show changes**, or on dismiss.
6. Select **Approve** when the plan is ready.
   Approve is the only terminal action.
   You can approve with open annotations.
   The dialog states how many remain open.
   The approval message tells the agent to implement the approved version.
   Approval binds to the viewed version.
   If the plan changes before approval, review the latest version and try again.
   The footer confirms delivery only after the approval reaches the thread.
   It shows a notice if the plugin drops the approval.

The thread stays open while the prompt is active.
The plugin releases the prompt before any message reaches the thread.
This includes queued composer messages and messages from other plugins.
The next `plans_handoff` restores the prompt when no plugin message is queued.
`plans_handoff` creates no prompt while a plugin message is still queued for the thread.
The queued message already brings the agent back.
**Skip** releases the prompt and leaves the plan open.
The plugin renews the prompt each hour.
A plugin reload drops the prompt until the next handoff.
Approval or plan deletion also releases the prompt.
Approval does not authorize a merge or deployment.

The panel lists only plans from its thread.
If none exists, paste Markdown to create one linked to that thread.
Legacy sample plans stay in storage and do not send agent messages.

## Agent commands

All plan tools return at once by design on every harness.
End the turn after `plans_submit` and `plans_handoff`.
Do not poll or wait on a command.
Feedback arrives as thread messages.

| Tool | Use |
| --- | --- |
| `plans_submit {title, markdown}` | Save a new plan and start the review prompt. Returns the plan and version IDs. |
| `plans_update {planId, edits, summary, resolves}` | Edit the current plan with exact-match `{old, new}` pairs. Each `old` must occur exactly once. |
| `plans_update {planId, markdown, summary, resolves}` | Replace the full Markdown. Use this instead of `edits`. |
| `plans_reply {planId, annotation, body, resolve}` | Answer an ask or comment on an annotation. For asks, `resolve` defaults to true. |
| `plans_handoff {planId}` | Restore the review prompt. Return a status line: `waiting` when the prompt is up, `queued` when a feedback message is still queued. |

Each submit, update, and approval also writes a pointer into the thread's plugin metadata under the `plans` namespace: `{ activePlanId, status, version }`.
The database stays authoritative.
A reader validates the shape and confirms that the plan belongs to the thread before using it.
Metadata is untrusted input; any client can write it.

Each update saves a version with a summary.
It returns the new version ID.
New annotations reach the agent only as thread messages.
`plans_update.resolves` sets each named annotation to **addressed**, including asks.
`plans_reply` sets an ask to **answered** by default.
With `resolve=false`, it keeps the current state, including **answered** or **addressed**.
For a comment or redline, a reply keeps the state by default; `resolve=true` sets **addressed**.
User replies do not reopen annotations.
Manual **Resolve** sets **addressed** and sends no message.
The `resolves` and `resolve` fields are optional.
Use annotation numbers such as `#7` in `resolves` and `annotation`.
Use `plans_update` to change an existing plan.
Call `plans_handoff` at the end of every turn that touched the plan.
Implement only after the `approved` message.

The CLI supports the same flow:

```text
bb plans submit <file> [title]
bb plans update <plan> <file> --summary <text> [--resolve #n ...]
bb plans reply <plan> <#n> <text> [--no-resolve]
bb plans handoff <plan>
bb plans get [plan] [--version-id <id>]
bb plans list [offset] [--thread <id>]
bb plans review <plan> --comment "quote::body" --ask "quote::body" --redline "quote" --looks-good "quote" [--approve]
```

Quote annotation numbers in shell commands, for example `'#7'`.
`review` serves a separate reviewer thread.
A thread cannot review its own plan.
Use `bb plans get` after context loss.
Without a plan ID, it reads the thread's metadata pointer and returns that plan when the database confirms it belongs to the thread.
Add `--version-id` to fetch a specific version.

File reads use the invoking thread's machine through BB's file API.
Only file-reading commands, `submit` and `update`, need a BB thread with a working directory.
`get` and `list` do not need a working directory.
`review --approve` explicitly approves the latest version.

### Message format

Annotations use numbers starting at `#1` within each plan.
Messages use compact text:

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
A missing or repeated match has no line label; the quote remains.
Later events use `reply on #7`, `edited #7`, `withdrawn #8`, `approved v6`, and `delivery mode: steer-if-active`.
Reply and edited events repeat the original quote.
Quotes keep every word and collapse whitespace.
`edited #n` items have no line label.
Messages carry no instructions; the bundled skill tells the agent what to do.

## Storage and delivery

The plugin SQLite database stores plans, versions, annotations with replies, and an outbox of events.
Delivered and dropped outbox rows stay until the plan is deleted.
Keep plugin ID `plans` unchanged.
Do not remove the installation to switch its Git ref.
Removal can delete stored data.
Pending annotation drafts stay in the current browser.

Migration runs for all plans when the plugin starts.
The plugin drops old pending deliveries and moves their unsent annotations to the outbox.
Old general notes in those deliveries are lost.
The log names the dropped deliveries.
The `review` and `revising` states become `open`.
Sent comments become delivered annotations.
Existing looks good rows remain in storage.

Each plan starts with `queue-if-active` delivery.
Messages reach an active agent after its current turn.
Use **Delivery** in the plan header menu to select `steer-if-active` for that plan.
This mode sends messages into the running turn.
You can switch back to **Queue after the current turn**.
There is no global delivery setting.
A delivery mode change applies to the next batch.
A batch already queued stays in its row.
If the provider rejects steering, the plugin sends that message with `queue-if-active`.
The selected mode stays unchanged, and the panel shows a notice.
The plugin drops feedback for an archived or deleted thread and shows a notice in the panel.
It does not replay that feedback after the thread is restored.
When the thread comes back from the archive, the plugin clears that notice and restores the review prompt for an open plan.

If you delete the plugin's queued message from the thread queue before it dispatches, the plugin marks that batch cancelled.
The affected cards show **Not delivered · cancelled** and stay undelivered, so you can still edit or withdraw them.
A cancelled approval shows the same state in the footer.
Nothing is resent automatically; later feedback goes out in a new message.
The review prompt comes back after the cancellation.

The plugin groups nearby events into compact messages.
It appends new events to its message while that message remains queued.
Failed deliveries retry after 5 seconds, 30 seconds, 2 minutes, then every 5 minutes.
The panel shows **Not delivered · retrying** during a failure.

Annotations keep their original version and quote.
Annotations follow matching quotes in the latest text.
Highlights stay for answered and addressed annotations.
Withdrawn annotations have no highlight.
A missing quote shows **Text changed** and offers **Resolve**.
Delivered annotations cannot be edited.
An edit before delivery updates the queued text.
If dispatch wins the edit race, the plugin sends a correction as `edited #7`.
You can withdraw delivered annotations or reply to them.
A withdrawal sends `withdrawn #n` only if the annotation was already delivered.
If the agent resolves an annotation before its message is dispatched, the plugin removes it from the queued message.
The plugin removes an undelivered annotation from the pending batch without a message.
The card label before delivery is **Pending** and after delivery is **Delivered**.
Answered, addressed, and withdrawn items show their state instead.

## Development

Run these commands from `plugins/plans`:

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

Run `npm run preview` for the standalone browser preview on port 5199.
It uses the plugin UI and backend with a simulated agent.
Preview plans use a temporary database that resets when the preview server restarts.
The preview thread is `preview-thread-1`.
No real agent receives its messages.

Follow the repository's branch installation workflow.
Build and test the plugin before opening a draft PR.
Verify the installed commit and review flow in BB.
Leave the tested branch installed until the user merges.

Check message delivery, prompt release, handoff, live updates, version comparisons, and approval in BB.
Also check a cancelled queued message, an unarchived thread, and the metadata pointer.
Check both desktop and phone layouts.
Automated tests and the preview do not prove live provider delivery or native touch selection.
See `VERIFICATION.md` for historical checks.

Use the WebKit probe to inspect selection and highlight behavior:

```sh
npx playwright install webkit
node scripts/mobile-probe.mjs /projects/<project>/threads/<thread>
node scripts/mobile-probe.mjs --engine-only
```

The base URL comes from `BB_SERVER_URL` inside BB shells or `--base`.
On a phone, choose **Diagnostics** in the plan menu.
Copy its report into the thread.

Icons render through the host registry (`experimental_Icon`).
`lib/host-icon-names.ts` is generated by `scripts/host-icon-names.mjs` from the pinned bb tag and types every icon name.
The generator lands with [#53](https://github.com/erwinkn/bb-plugins/pull/53); until it merges, fetch it from branch `bb/host-icon-names-script-thr_nca2xisxm9` (`git fetch origin bb/host-icon-names-script-thr_nca2xisxm9 && git show FETCH_HEAD:scripts/host-icon-names.mjs`).
Regenerate on each bb upgrade.
Glyphs bb does not ship (`plans-keyboard`, `plans-strikethrough`) are registered by the plugin in `app.tsx`.

## Annotation controls

Select text to open the annotation menu.
On mobile, the menu sits at the bottom of the document.

| Kind | Key | Meaning | Action |
| --- | --- | --- | --- |
| Comment | C | Request a change. | Open the composer. |
| Ask | A | Ask a question that needs an answer, not a change. | Open the composer. |
| Redline | D | Request removal of the quoted text. | Save directly. |
| Looks good | G | Confirm a passage or settle an open question. | Save directly. |

**Copy** copies the selected text.
A redline does not edit the document itself.
The agent applies the removal with `plans_update`.
A looks good needs no change unless it settles an open question.
The agent then folds that answer into the text.
Annotation cards show their number, kind, state, and replies.
Use the reply field to continue the discussion.

## Keyboard shortcuts

Open **Keyboard shortcuts** from the plan actions menu, or press `?` while the focus is not in a text field.
The cheat sheet lists the keys that the panel binds.

With text selected in the plan:

| Key | Action |
| --- | --- |
| C | Add a comment on the selection (opens the composer) |
| A | Ask about the selection (opens the composer) |
| D | Redline the selection (saves directly) |
| G | Looks good for the selection (saves directly) |
| ? | Open the cheat sheet |

In the composer:

| Key | Action |
| --- | --- |
| Cmd+Enter on macOS, Ctrl+Enter elsewhere | Submit the text |
| Escape | Cancel and close the composer |

The submit row shows the modifier for the detected platform.
When the browser does not identify the platform, the row shows both forms.
The D and G rows are hidden when the plan is approved or an older version is shown, because those keys do not save then.
