# BB MCP

Manage BB threads from Grok Bot, Executor or another MCP client. Version 0.3.1
exposes 35 explicit tools for thread work, questions and permission approvals.
All projects (including Personal), hidden threads and enrolled execution hosts
are available. Project access is not restricted to the plugin's own project.

The general SDK/CLI bridges from the temporary owner-access build are removed.
There is no arbitrary API dispatch, CLI execution, plugin RPC, permanent
thread/project/section deletion, direct filesystem/terminal access, Git/PR
write tool, publishing, or BB administration.

## Connect

Requires BB 0.42.1 / Plugin SDK 0.4.47 and configured coding providers.
Provider and infrastructure usage retains its normal costs.

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin bb-mcp --yes
bb plugin config bb-mcp set appUrl https://your-bb.example.com
bb plugin config bb-mcp set endpointUrl https://your-mcp.example.com/mcp
bb mcp status
```

Expose HTTPS `/mcp` through a proxy to
`/api/v1/plugins/bb-mcp/http/mcp`. See the [Caddy example](deploy/Caddyfile.example).
Use Streamable HTTP and the custom secret header `x-bb-plugin-token`.
Obtain the token with `bb plugin token bb-mcp` in a private terminal; do not
paste it into prompts, URLs, source or logs. BB validates the token. The plugin
also checks Host/Origin against its configured URLs and BB loopback; service
clients may omit Origin. Query-string tokens are refused.
Both modern 2026-07-28 and stateless legacy 2025 negotiation work.

The settings are `appUrl`, `endpointUrl` and optional `defaultHostId`.
An empty default host selects a connected host, preferring a project source.
Former project/host/provider scopes, permission ceilings and quota settings
are retired and ignored. Credentials, settings values and the operation
database are preserved on upgrade. Refresh/reconnect the MCP client after
upgrading so it discards the removed general-purpose tools.

## Tools

| Area | Tools |
| --- | --- |
| Discovery | `bb_get_capabilities`, `bb_list_projects`, `bb_list_runtimes` |
| Create and dispatch | `bb_create_thread`, `bb_fork_thread`, `bb_handoff_thread`, `bb_send_message`, `bb_stop_thread`, `bb_retry_thread` |
| Organization | `bb_rename_thread`, `bb_update_thread`, `bb_archive_thread`, `bb_unarchive_thread`, `bb_set_thread_pinned`, `bb_set_thread_read`, `bb_reorder_pinned_thread` |
| Sections | `bb_list_thread_sections`, `bb_create_thread_section`, `bb_rename_thread_section` |
| Monitoring | `bb_list_threads`, `bb_get_thread`, `bb_get_events`, `bb_get_result`, `bb_get_changes`, `bb_wait_for_thread`, `bb_get_operation` |
| Queued work | `bb_list_queued_messages`, `bb_update_queued_message`, `bb_cancel_queued_message`, `bb_reorder_queued_message`, `bb_send_queued_message` |
| Questions and approvals | `bb_list_interactions`, `bb_get_interaction`, `bb_answer_question`, `bb_approve_permission` |

Successful results contain `{"data":...}` in structured and text content.
Tool exceptions set `isError` with the underlying error message, without stack
traces or argument logging. Inspect operation receipt state too.

### Create and organize

```json
{
  "projectId": "proj_example",
  "prompt": "Fix the failing test and report validation.",
  "title": "Fix failing test",
  "providerId": "codex",
  "idempotencyKey": "ticket-42-start"
}
```

Standard projects use new managed worktrees by default; Personal uses native
Personal workspaces. Supply `environmentId` to reuse an existing environment.
Parent links and environment reuse are independent. Child visibility inherits
the parent unless overridden.

Handoff starts a fresh conversation with a BB source-thread mention and reuses
the source environment unless requested otherwise. Fork uses native provider
session cloning at the tip or `sourceSeqEnd`; provider support is required.
A fork can be sent new instructions afterwards.

Create/send accept explicit model, reasoning, permission mode, service tier
and optional `sendAt` epoch milliseconds. BB resolves omitted defaults and
validates native policy. Updates support title, parent, section, visibility and
sticky model/reasoning; null clears a parent/section. BB's standalone update
API does not support permission mode/service tier: pass them on create/send.
On BB 0.42.1, follow-ups queued before a scheduled thread's first run also
need an explicit `model`; use the same model as creation.

Archive is reversible for thread history, but can cascade to descendants and
trigger BB's native managed-workspace cleanup. There is no permanent thread
deletion tool. Stop releases the runtime; cancel queued instructions separately.

### Questions and permission approvals

Read `bb_get_interaction` before answering or approving.

For a provider `user_question`, use `bb_answer_question` with `answers`
keyed by question ID: `{"selected":["option-value"],"freeText":"..."}`.
For a native/plugin form, pass `value` matching its response contract.
The target is an existing interaction, not an arbitrary plugin method.

For an approval:

```json
{
  "threadId": "thr_example",
  "interactionId": "interaction_example",
  "decision": "allow_once",
  "idempotencyKey": "reviewed-interaction-example"
}
```

Decisions are `allow_once`, `allow_for_session`, or `deny`, only when the
pending request offers them. Expired, settled or mismatched interactions are
refused. Omitted `grantedPermissions` uses the requested permission grant
(or the request's session grant for a session decision). An explicit grant
uses BB's native filesystem/network permission shape. This does not expose
machine-wide permission settings.

This is a trusted thread-management endpoint, not an agent sandbox. A caller
can dispatch coding work and approve the agent's requested commands/file
changes. Those agents can then act under their normal permissions. Protect
the token accordingly.

### Queues, monitoring and retry safety

Queue edits require the listed `updatedAt` as `expectedUpdatedAt`; stale
edits fail. Editing replaces the message's entire input with the supplied text,
including any attachments. Send-now explicitly bypasses the queued message's
schedule and plugin waits; native provisioning/runtime waits remain.
Cancel discards only that queued instruction.

Lists include hidden threads by default and can span all projects. Pages
default to 20 with no plugin maximum. Follow `nextOffset` until null;
a final empty page avoids mistaking a BB-capped short page for the end.
Conversation text and requested patches are not clipped by the plugin.
Native retained-output truncation and native API validation still apply.

Wait for a native status or event with `bb_wait_for_thread`, supplying
`timeoutMs` appropriate for the client's timeout. Idle/acceptance does not
certify task success. There are no unsolicited completion callbacks to a
disconnected MCP client.

Optional stable idempotency keys deduplicate dispatch and interaction
responses across retries/reloads. Creation/send/handoff always return receipts;
other keyed operations do too. Changed arguments with the same key fail.
A lost response can leave `outcome_unknown`: BB may have committed. Inspect
native state before using a new key; never automatically redispatch it.

`bb mcp operations` lists thread receipts; `bb mcp reconcile <operation-id>
<thread-id> --confirmed` records a manually verified create/send outcome.
Old general-SDK/CLI receipts remain on disk but their payloads are not exposed
through the narrowed MCP. There is no operation-count admission cap.

No plugin request/creation quotas, concurrency ceiling, payload/result caps or
execution-permission ceiling are imposed. Native BB/provider/host policies,
availability, costs, paging and client/proxy timeouts still apply.
See the [scope and boundary inventory](PARITY.md).

## Develop and verify

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

Tests cover the explicit surface, rejected broad tools, all-project and
Personal behavior, approval binding/decisions, question/form responses, queues,
idempotency persistence, old receipts, large output and former quotas.
`tests/live-client.mjs` performs individual calls with an in-memory credential.
`tests/live-thread-management.mjs --project <id> [--url <endpoint>] [--approval]`
runs an opt-in thread/queue/fork lifecycle exercise; its labeled test threads
are archived/stopped afterwards with history retained.

Follow the repository's data-preserving plugin update workflow. Never remove
a populated installation merely to change its source.
