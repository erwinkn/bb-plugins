Review plans beside the agent conversation, without a separate service.

## Review and revise

Select text in a Markdown plan to comment, request its removal, or mark it as
good. Send annotations and a review note to the original agent. Compare versions
in the Changes view, then approve the version you want the agent to implement.
Sent feedback stays attached to its original version.

## Submit a plan

Ask the agent to submit a plan for review in BB. The included `plan-review` skill
uses `plans_submit` and tells the agent to wait for feedback. The `bb plans`
command also supports submission from a Markdown file. You can paste Markdown
into the thread's **Review plan** panel.

This is an explicit review workflow. It does not enforce the provider's native
plan mode or prevent an agent from continuing against its instructions.

## Requirements and storage

Requires BB 0.42.1 or later. No separate account or service is required. Plans,
versions, saved comments, and delivery receipts stay in the plugin database on
the BB server. Unsent draft text stays in the current browser. Agent execution
uses the thread's provider and its normal account usage.
