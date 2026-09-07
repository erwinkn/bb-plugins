# Plans

Review a Markdown plan beside its BB thread. Select text, add comments or redlines, mark passages as good, compare
versions, and send feedback to the agent. Approve a specific version when it is
ready for implementation.

The plugin adds a **Review plan** panel to each thread.
Its workflow uses an explicit plan submission tool. It does not replace or
enforce a provider's built-in plan mode.
Use the submission tool in a normal thread. If a provider is waiting for its
own plan approval, its native approval step remains separate.

## Install

After this change merges, install from the repository's main branch:

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin erwin-plans
```

While the draft PR is open, use its tested branch instead of `main`. Keep the
plugin ID `erwin-plans` unchanged. New provider sessions receive the bundled
`plan-review` skill and submission tool. Existing sessions may need to restart
or resume before new agent tools become available.

## Review flow

1. Ask the agent to submit a plan for review in BB. The included `plan-review`
   skill uses `plans_submit` and tells it to wait. The tool returns a
   plan ID and version ID. New tools become available when BB starts or resumes
   the provider session.
2. Open **Review plan** in the thread, or use its **Plan** header button. Select text to add a comment, or add a general
   review note. Draft text stays in this browser; saved comments stay in BB.
3. Select **Send feedback** to request a revision in the original thread.
4. The agent submits the revision with the same plan ID and the expected version
   ID. Compare the versions. Earlier comments retain their original version.
5. After reviewing the revision, select **Approve**. The plugin sends
   that exact plan version to the original thread for implementation.

Feedback and approval use BB's queue-if-active mode. If the thread is working,
BB queues the message. Approval does not authorize a merge or deployment.

The panel lists only plans from its thread. If none exists, paste Markdown
to create one. New plans are linked to that thread automatically.
Legacy sample records remain in storage and never send agent messages.

## Agent commands

The native `plans_submit` tool accepts `title`, `markdown`, and optional `planId`
and `expectedVersionId`. A revision must belong to the calling thread. After
submission, the agent must stop and wait for the user.

An existing session can use the CLI:

```sh
bb plans submit ./plan.md 'Storage migration'
bb plans get PLAN_ID
bb plans submit ./plan.md 'Storage migration' PLAN_ID EXPECTED_VERSION_ID
bb plans list
bb plans list 10
```

File reads run on the invoking thread's machine through BB's file API. The CLI
must have a BB thread and working directory. It does not read a remote file from
the server's local disk.

## Storage and delivery

Plans, immutable versions, saved comments, and delivery receipts use the
plugin's SQLite database. Keep plugin ID `erwin-plans` unchanged. Do not remove
the installation to switch its Git ref: removal can delete its stored data.

Comments remain attached to their reviewed version. A repeated quotation does
not identify one unique location. Sent comments cannot be edited or deleted.
Unsent comments and redlines block approval. Send or delete them first.
Sent feedback blocks approval of its reviewed version until a new revision arrives;
it stays in the history without blocking that new revision.
Looks good annotations do not block approval and are sent with the next feedback
or approval. Redline and Looks good save directly from the selection toolbar.

The server rejects stale revisions and approvals. A successful review request
ID cannot send twice. If delivery fails without a confirmed outcome, the plugin
blocks further changes to that plan to avoid duplicate agent work. Inspect the
linked thread for `Review receipt: REQUEST_ID`, then reconcile the receipt:

```sh
bb plans delivery REQUEST_ID
# Only after confirming the receipt is present in the linked thread:
bb plans delivery REQUEST_ID sent
# Only after confirming the message was not delivered:
bb plans delivery REQUEST_ID not-sent
```

The plugin has no automatic recovery for an uncertain delivery. It does not
retry a send after a connection failure. Its limits are 100,000 characters per
Markdown version, 10,000 characters per comment or note, 2 MB of serialized
history per plan, and ten plans per list page. Oversized history produces an
error and preserves the previous saved plan.

## Development

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

Run `npm run preview` for a standalone browser preview on port 5199. It mounts
the real UI and backend with a simulated thread receiver. Preview plans live
in a temporary test database and disappear when the preview server restarts.
The preview's thread ID is `preview-thread-1`; no real agent receives its messages.

Follow the repository's branch installation workflow. Build and test first,
open a draft PR, install that Git branch, then verify the installed commit and
the review flow in BB. Leave the tested branch installed until the user merges.

The automated backend tests use BB's official plugin harness and SQLite. They
check version history, comments, stale approvals, duplicate requests, concurrent
submissions, sample isolation, reload persistence, and uncertain delivery.
They do not prove live provider delivery or the desktop and mobile layout.

## Annotation controls

Select text to open a vertical menu: Comment (C), Redline (D), or Looks good (G).
Shortcuts are hidden on mobile. Redlines request removal by the agent when
feedback is sent. They do not change the plan text. Deleting an unsent annotation
removes only that annotation. The agent applies changes in its next revision.
