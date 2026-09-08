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
   skill calls `plans_submit`, which blocks the agent the way a question to the
   user does: BB marks the thread as waiting for you, and the composer shows a
   **Review plan** prompt with **Open review** and **Skip review**. New tools
   become available when BB starts or resumes the provider session.
2. Open **Review plan** from the prompt or the **Plan** header button. Select
   text to add a comment, or add a general review note. Draft text stays in this
   browser; saved comments stay in BB.
3. Select **Send feedback**. The prompt clears and the blocked tool call returns
   your comments and note as JSON inside the agent's current turn.
4. The agent submits the revision with the same plan ID and the expected version
   ID and blocks again. Compare the versions. Earlier comments retain their
   original version.
5. After reviewing the revision, select **Approve**. The call returns
   `status: "approved"` and the agent implements that exact version.

**Skip review** releases the agent without a decision (`status: "dismissed"`);
the plan stays open and a later decision reaches the agent as a thread message.
The decision never repeats the plan text: the agent already has it, and
`bb plans get PLAN_ID --version-id VERSION_ID` fetches it after context loss.
If no agent is waiting when you decide (its turn ended, or it never waited),
the plugin falls back to a compact thread message with the same content, queued
if the thread is busy. Approval does not authorize a merge or deployment.

BB caps one interaction at an hour; the plugin re-requests it while the agent
keeps waiting, so a review can take longer than that. BB also allows one
pending interaction per thread; a second wait on the same thread keeps waiting
without its own prompt.

Cursor's MCP client times out tool calls after 60 seconds, so on providers
listed in the **Providers whose tool calls cannot block** setting (default
`acp-cursor`) `plans_submit` returns `status: "submitted"` at once while the
plugin keeps the same **Review plan** prompt pending on the thread. The agent
ends its turn; your decision arrives as the compact thread message and starts
its next turn. A plugin reload drops the held prompt (the plan stays open and
the message still arrives). `bb plans wait` remains available for agents that
prefer to block on a shell command.

The panel lists only plans from its thread. If none exists, paste Markdown
to create one. New plans are linked to that thread automatically.
Legacy sample records remain in storage and never send agent messages.

## Agent commands

The native `plans_submit` tool accepts `title`, `markdown`, and optional `planId`
and `expectedVersionId`. A revision must belong to the calling thread. It
blocks until the user decides (up to 24 hours) and returns the decision.

```sh
bb plans wait PLAN_ID --version-id VERSION_ID [--timeout 1200]
bb plans submit ./plan.md 'Storage migration' --wait
bb plans submit ./plan.md 'Storage migration' PLAN_ID EXPECTED_VERSION_ID --wait
bb plans get PLAN_ID --version-id VERSION_ID
bb plans list [10]
bb plans review PLAN_ID VERSION_ID feedback --comment 'quoted text::what to change' --redline 'drop this' --note 'General note'
bb plans review PLAN_ID VERSION_ID approve --looks-good 'keep this'
```

`wait` holds the same BB interaction as the tool and blocks until the reviewer
decides on that version, then prints the decision as JSON: `status`
(`feedback` or `approved`), `note`, `comments` with their `quote`, `body`, and
`kind`, and an `instruction`. It exits 0 with `status: "pending"` when the
timeout (default 20 minutes, max 24 hours) passes; run it again to keep
waiting. `dismissed` means the user chose **Skip review**. A wait on a version
that was replaced returns `status: "superseded"` with the latest version ID.
Decisions are stored, so a wait that starts after the decision returns
immediately, and a wait that is interrupted (plugin reload, shell time limit)
loses nothing. Providers whose shell tool has a time limit should run `wait` in
the background and await it.

`review` lets another thread act as the reviewer, for example a parent thread
reviewing a child's plan. A thread cannot review its own plan.

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

jsdom also cannot show engine behaviour. For the phone, run the WebKit probe
against a live BB thread; it prints the same report as the panel's
**Diagnostics** menu item (highlight API, resolved versus painted anchors, the
nearest `user-select` value and the ancestor that set it) and saves a
screenshot of the document:

```sh
npx playwright install webkit
node scripts/mobile-probe.mjs /projects/<project>/threads/<thread>
node scripts/mobile-probe.mjs --engine-only   # paint check without BB
```

The base URL comes from `BB_SERVER_URL` inside `bb` shells or `--base`. On a
real phone, open the plan's `…` menu, choose Diagnostics, and paste the copied
report into the thread.

## Annotation controls

Select text to open a vertical menu: Comment (C), Redline (D), or Looks good (G).
Shortcuts are hidden on mobile. Redlines request removal by the agent when
feedback is sent. They do not change the plan text. Deleting an unsent annotation
removes only that annotation. The agent applies changes in its next revision.
