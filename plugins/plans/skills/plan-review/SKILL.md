---
name: plan-review
description: Use when the user asks to submit or review a plan in the BB Plans panel, or when a plan review result requests a revision. Do not use for general brainstorming or an implementation task without a plan-review request.
---

# Plan review

Use the thread's Plans panel for a review cycle before implementation. The
cycle runs inside one tool call: `plans_submit` saves the plan, marks the
thread as waiting for the user, and returns when the user decides.

## Submit

Read the relevant project context and prepare a complete Markdown plan. Include
the intended result, scope, implementation steps, and verification that fits the
task. State material open questions; do not make the plan look approved.

Call `plans_submit` with `title` and the full `markdown`. BB supplies the current
thread. The call blocks while the user reviews, like a question to the user, and
returns one JSON object. Do not implement while it is pending.

If the native tool is unavailable, write the Markdown to a UTF-8 file in this
thread's workspace and use the CLI, which blocks the same way:

```sh
bb plans submit ./plan.md 'Plan title' --wait
```

If your shell tool has a time limit, run the CLI in the background and await
its output. The plugin does not control the provider's native plan mode. If
that mode is active, its native approval step remains separate.

Some providers cannot hold a tool call open. There `plans_submit` returns
`status: "submitted"` with an `instruction`: the review prompt stays pending on
the thread, so end your turn without implementing. The decision arrives as a
new message with the comments and note; do not poll and do not run `bb plans
wait`. If the tool call itself fails with a timeout, the plan was still saved:
find it with `bb plans list` and run `bb plans wait` on it.

## Read the result

`status` tells you what happened:

- `feedback`: `comments` (each with `quote`, `body`, `kind`) and `note` are the
  requested changes. Revise (below).
- `approved`: implement this version. `comments` holds Looks good annotations.
- `dismissed`: the user closed the prompt without deciding. Ask how to proceed.
  The plan stays open in Review plan; a later decision arrives as a message.
- `pending`: the wait timed out. Resume with
  `bb plans wait PLAN_ID --version-id VERSION_ID`; nothing was lost.
- `superseded`: a newer version exists. Wait on `latestVersionId` instead.
- `cancelled`: BB stopped the wait (`reason` says why). Resume with `bb plans
  wait` when appropriate.

A `redline` requests removal of the quoted text; a `looksGood` annotation marks
text to keep; a `comment` carries the user's requested change or question.
Comments keep the version and exact text they refer to.

The result never repeats the plan text. If it is no longer in context:

```sh
bb plans get PLAN_ID --version-id VERSION_ID
```

## Revise

Apply the feedback to the full plan, including any general note. Submit the
complete revised Markdown through `plans_submit` with the same `planId` and the
current `expectedVersionId`. Do not create a new plan for a revision. The call
blocks again until the user reviews the new version. CLI fallback:

```sh
bb plans submit ./plan.md 'Plan title' PLAN_ID EXPECTED_VERSION_ID --wait
```

If submission reports a stale version, read the latest plan and reconcile the
changes before submitting again.

## Implement

Start implementation when the result says `approved` for the exact version you
submitted. Follow that version and the user's current instructions. Approval of
a plan does not grant extra authority to merge or deploy.

Do not review your own plan: `bb plans review` refuses the plan's own thread and
exists for a parent or reviewer thread. Do not change review receipts to bypass
a delivery error. If delivery is uncertain, inspect the linked thread and report
the receipt ID so the user can reconcile it.
