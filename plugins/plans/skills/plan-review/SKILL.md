---
name: plan-review
description: Use when the user asks to submit or review a plan in the BB Plans panel, or when a plan review result requests a revision. Do not use for general brainstorming or an implementation task without a plan-review request.
---

# Plan review

Use the thread's Plans panel for a review cycle before implementation. The
cycle stays inside your current turn: submit, wait for the decision, act on it.

## Submit

Read the relevant project context and prepare a complete Markdown plan. Include
the intended result, scope, implementation steps, and verification that fits the
task. State material open questions; do not make the plan look approved.

Call `plans_submit` with `title` and the full `markdown`. BB supplies the current
thread. The result contains `planId`, `versionId`, and the wait command. Tell
the user the plan is ready in **Review plan**, then wait (below). Do not start
implementation while waiting.

If the native tool is unavailable, write the Markdown to a UTF-8 file in this
thread's workspace and submit with the CLI. `--wait` submits and waits in one
command:

```sh
bb plans submit ./plan.md 'Plan title' --wait
```

The plugin does not control the provider's native plan mode. If that mode is
active, its native approval step remains separate.

## Wait

```sh
bb plans wait PLAN_ID --version VERSION_ID
```

The command blocks until the reviewer sends feedback or approves, then prints
one JSON object. If your shell tool has a time limit, run it in the background
and await its output rather than polling. Read `status`:

- `feedback`: `comments` (each with `quote`, `body`, `kind`) and `note` are the
  requested changes. Revise (below).
- `approved`: implement this version. `comments` holds Looks good annotations.
- `pending`: the timeout passed (default 20 minutes). Run the same command
  again; nothing was lost.
- `superseded`: a newer version exists. Wait on `latestVersionId` instead.

Comments retain the version and exact text they refer to. A `redline` requests
removal of the quoted text; a `looksGood` annotation marks text to keep; a
`comment` carries the user's requested change or question.

The plan text is not repeated in the result. If it is no longer in context:

```sh
bb plans get PLAN_ID --version VERSION_ID
```

If a review arrives as a thread message instead, the same rules apply; that
happens only when no wait was attached when the user decided.

## Revise

Apply the feedback to the full plan, including any general note. Submit the
complete revised Markdown through `plans_submit` with the same `planId` and the
current `expectedVersionId`. Do not create a new plan for a revision. Then wait
on the new `versionId`. CLI fallback:

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
