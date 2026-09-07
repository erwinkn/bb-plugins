---
name: plan-review
description: Use when the user asks to submit or review a plan in the BB Plans panel, or when a Plans review message requests a revision. Do not use for general brainstorming or an implementation task without a plan-review request.
---

# Plan review

Use the thread's Plans panel for a review cycle before implementation.

## Submit

Read the relevant project context and prepare a complete Markdown plan. Include
the intended result, scope, implementation steps, and verification that fits the
task. State material open questions; do not make the plan look approved.

Call `plans_submit` with `title` and the full `markdown`. BB supplies the current
thread. Keep the returned `planId` and `versionId`. Tell the user the plan is
ready in **Review plan**, then end the turn. Do not start implementation while
waiting for review.

If the native tool is unavailable, write the Markdown to a UTF-8 file in this
thread's workspace and run:

```sh
bb plans submit ./plan.md 'Plan title'
```

The plugin does not control the provider's native plan mode. If that mode is
active, its native approval step remains separate.

## Revise

A feedback message identifies the plan and version. Read `bb plans get PLAN_ID`
when more context is needed. Comments retain the version and exact text they
refer to. A redline requests removal; a looksGood annotation marks text to keep.
Apply the feedback to the full plan, including any general note.

Submit the complete revised Markdown through `plans_submit`, with the same
`planId` and the current `expectedVersionId`. Do not create a new plan for a
revision. CLI fallback:

```sh
bb plans submit ./plan.md 'Plan title' PLAN_ID EXPECTED_VERSION_ID
```

If submission reports a stale version, read the latest plan and reconcile the
changes before submitting again. After a successful revision, end the turn and
wait for review again.

## Implement

Start implementation when the user approves the exact version. The approval
message includes its full Markdown and version ID. Follow that version and the
user's current instructions. Approval of a plan does not grant extra authority
to merge or deploy.

Do not send feedback to yourself, approve a plan on the user's behalf, or change
review receipts to bypass a delivery error. If delivery is uncertain, inspect
the linked thread and report the receipt ID so the user can reconcile it.
