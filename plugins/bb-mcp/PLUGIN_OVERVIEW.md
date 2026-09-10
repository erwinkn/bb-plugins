Delegate coding work from Executor or another MCP client to the BB instance you control. Threads stay visible in BB, where you can inspect their conversations, worktrees, and results.

## What you get

Discover projects, execution hosts, providers, and models. Create a coding thread, queue or steer follow-up instructions, stop its runtime, rename it, and retrieve progress, assistant results, file changes, and pull request metadata. New work uses isolated worktrees by default.

## Reliable handoffs

Create and send tools require stable idempotency keys. Recorded requests survive reloads, while uncertain outcomes require reconciliation instead of automatic duplicate dispatch. Status responses distinguish queued work and pending prompts from a completed turn.

## Requirements

Requires BB 0.42.1 or later with compatible Plugin SDK 0.4.47 APIs, configured coding providers, and an authenticated HTTPS endpoint reachable by your MCP client. Provider usage and infrastructure retain their normal costs. Executor is optional. Configure explicit project and host access in BB settings and keep the connection token in your client's secret storage.

Use `bb mcp status` for configuration and `bb mcp operations` for recent request outcomes. Automatic completion callbacks and remote permission approvals are not included in this release.
