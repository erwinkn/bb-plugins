# BB MCP

Create, manage, and monitor BB coding threads from Executor or another remote
MCP client. BB owns execution and conversations; this headless plugin exposes a
scoped interface over the public BB SDK.

Version 0.2 adds real child threads, the product's source-reference handoff,
execution controls, and thread updates. See the [product parity audit and
delivery plan](PARITY.md), or call `bb_get_capabilities`, for what is shipped,
planned, blocked upstream, or intentionally interactive.

Requires BB 0.42.1 / Plugin SDK 0.4.47 and a connected execution host. MCP SDK
2.0.0 serves modern `2026-07-28` requests and stateless 2025 initialization on
the same Streamable HTTP endpoint. Legacy calls use finite SSE responses;
modern calls return JSON. There is no session database or background MCP task.

## Install and configure

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin bb-mcp --yes
bb plugin config bb-mcp set projectIds 'proj_first,proj_second'
bb plugin config bb-mcp set hostIds 'host_linux'
bb plugin config bb-mcp set defaultHostId host_linux
bb plugin config bb-mcp set appUrl https://your-bb.example.com
bb plugin config bb-mcp set endpointUrl https://your-mcp.example.com/mcp
bb mcp status
```

Find IDs with `bb project list --json` and `bb machine list --json`. Project
and host lists are explicit allowlists; an empty list denies operations. Read
and write tools check scope even when a caller supplies a known thread or
environment ID. Threads that have not yet received an environment can be read
when the plugin has a recorded host for their creation.

Settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `projectIds` | empty | Comma/space-separated project IDs |
| `hostIds` | empty | Comma/space-separated host IDs |
| `defaultHostId` | empty | Default host for new worktrees |
| `providerIds` | empty | Optional provider allowlist; empty permits installed providers |
| `appUrl` | empty | HTTPS BB URL used for thread links |
| `endpointUrl` | empty | HTTPS MCP URL accepted by the HTTP host/origin checks |
| `permissionMode` | `auto` | Maximum execution permission; lower supported modes are used when necessary |
| `requestsPerMinute` | 120 | Authenticated HTTP request limit per plugin generation |
| `createsPerHour` | 20 | Durable new-thread admission limit, including uncertain outcomes |
| `maxPendingOperations` | 4 | Concurrent create/send dispatch limit |

The host's native permission ceiling and BB's concurrency controls also apply.
The MCP caller can request a permission mode within the configured ceiling,
host ceiling, and any parent ceiling. An explicit unsupported/excessive mode
fails; omitted modes resolve to an allowed supported default. It cannot change
the operator's ceiling or configure the plugin. Discover
providers before choosing one and pass `providerId` to discover its models.
Pass `environmentId` when the provider needs a workspace-specific catalog.

## HTTPS and authentication

The internal route is:

```text
/api/v1/plugins/bb-mcp/http/mcp
```

Route a dedicated HTTPS hostname's `/mcp` path to that exact route. A
[Caddy example](deploy/Caddyfile.example) is included. Keep the general BB API
private, preserve MCP headers, disable response caching, and ensure this
service path does not redirect to a browser login. The plugin checks Host and
Origin against its configured URLs and BB loopback URL. An absent Origin is
accepted for service clients. It does not trust forwarded identity headers.

BB manages the credential. Obtain it through `bb plugin token bb-mcp` in a
private terminal or pipe it directly to your connection secret store. Do not
paste it into a prompt, source file, URL, or log. The plugin requires the
`x-bb-plugin-token` header and rejects BB's query-string token alternative.
Missing or invalid credentials return HTTP 401.

In Executor's live console:

1. Add a remote MCP integration for the public endpoint, with Streamable HTTP.
2. Choose API-key/custom-header authentication named `x-bb-plugin-token`, with
   no prefix, and store the BB token as the connection's secret.
3. Set Executor policies for the exposed tools and verify `bb_list_projects`.
4. Use that catalog from the assistant already connected to Executor.

No Executor deployment or GrokBot-specific adapter is required. If the ingress
adds Cloudflare Access, configure its service credentials as additional
connection secret headers. OAuth can be added for clients that require it or
for delegated identities; this first version uses one service principal.

For a direct client, use the same HTTPS URL and custom header. Follow that
client's secret management mechanism. Rotate using `bb plugin token bb-mcp
--rotate`, immediately update the Executor connection secret, and reconnect.
Rotation invalidates the previous token. Disabling the plugin disables its
routes and does not stop existing coding threads.

## Tools

All successful tool results contain `{ "data": ... }` in both structured
content and the text representation. Tool failures set `isError` and return a
bounded `{ "error": { "code", "message" } }` text block.

| Tool | Purpose |
| --- | --- |
| `bb_list_projects` | Allowed projects and default execution host |
| `bb_get_capabilities` | Implemented features, limits and parity roadmap |
| `bb_list_runtimes` | Allowed hosts/providers and paginated provider models |
| `bb_list_threads` | Paginated project scan with title/tree/archived/hidden filters |
| `bb_get_thread` | Runtime, execution options, queue and pending prompts |
| `bb_get_events` | Incremental event summaries with an exclusive sequence cursor |
| `bb_create_thread` | Root/child creation, workspace choice and execution options |
| `bb_handoff_thread` | New conversation with source-thread context reference |
| `bb_send_message` | Queue/steer follow-up with execution options and optional schedule |
| `bb_stop_thread` | Release current runtime; queued instructions remain separate |
| `bb_rename_thread` | Update a thread title |
| `bb_update_thread` | Title, parent, visibility and sticky model/reasoning updates |
| `bb_get_result` | Latest root assistant message with turn provenance/freshness |
| `bb_get_changes` | Page changed files/PR metadata and request bounded patches |
| `bb_get_operation` | Read a stored create/handoff/send outcome |

Example create arguments:

```json
{
  "projectId": "proj_first",
  "prompt": "Fix the failing test and report the change and validation.",
  "title": "Fix failing test",
  "providerId": "codex",
  "idempotencyKey": "ticket-42-initial-instruction"
}
```

Creation returns an operation ID and acceptance receipt. Provisioning may
still be pending and `environmentId` may be null. Read the current thread for
its resolved execution and environment; the stored receipt is historical.
New tasks use isolated managed worktrees by default and do not navigate the
user's open BB panes. Explicit environment reuse shares that environment's
working files. Its project/host must be allowed.

Add `parentThreadId` to create a child in BB's tree. Reusing `environmentId`
alone creates no parent relationship. Child visibility inherits the parent
unless supplied explicitly. Thread summaries expose `parentThreadId`,
`sourceThreadId`, `originKind` and `visibility`; listing can filter by parent,
native source relationship, `hasParent`, `archived` and `includeHidden`.

For a handoff, call `bb_handoff_thread`:

```json
{
  "sourceThreadId": "thr_previous",
  "prompt": "Continue with the remaining tests using the prior thread's context.",
  "providerId": "claude-code",
  "idempotencyKey": "ticket-42-handoff"
}
```

This matches BB's UI handoff: a new conversation with a rich source-thread
mention, using BB's context resolution. It reuses the source environment by
default; set `reuseSourceEnvironment: false` for a new worktree or pass an
explicit allowed `environmentId`. It does not clone a provider session, create
a parent edge unless requested, or stop/archive the source. Both source and
target scope are checked, including receipt reads after scope revocation.

Create, handoff and send accept `model`, `reasoningLevel`, `permissionMode`
and `serviceTier` (`default`/`fast`, provider-dependent). Create and handoff
also accept `providerId`. Catalog discovery reports provider capabilities and
model defaults. `sendAt` schedules a first or follow-up instruction using a
future Unix timestamp in milliseconds.

Use `bb_update_thread` to set title, parent (`null` clears it), visibility,
model or reasoning without dispatching work. Model/reasoning updates stay
within the current provider and apply to next/later turns. Standalone
permission/service-tier updates need [BB #3401](https://github.com/get-bb/bb/issues/3401);
until then, set those fields on the next `bb_send_message`. The plugin does
not simulate an update with a hidden prompt or plugin-only sticky settings.

`bb_send_message` returns BB's actual `delivery` and, when queued, the queued
message ID and wait reason. A queued outcome is successful acceptance, not a
failure to resend. Use its `afterSeq` with event/result reads. `steer` can
still queue during provisioning, startup, or a pending interaction.

## Progress and results

Poll every approximately 15 seconds. Runtime status, `activity`, pending
interactions, and queue state are separate facts. Idle is not a declaration
that a coding task succeeded. `taskCompletion` is deliberately `not_inferred`.
`isCurrentTurnResult` requires an idle, completed matching turn without pending
prompts, queued messages, or a later request. The caller still evaluates the
assistant's result. Snapshots carry observation time and are not atomic across
concurrent BB changes.

Pending prompts are read from BB's interactions API, including plugin prompts
that do not emit lifecycle events. Answer them in BB. Remote approval, question
answering, and automatic callback delivery are outside this first release.

Follow `nextAfterSeq` for events. Text is truncated explicitly; tool payloads
and reasoning text are omitted. Pages stop at the response budget without
skipping the remaining events. Thread title/host filters apply to scanned
pages, so follow `nextOffset` even if a page contains no matches. Result search
looks back through at most 100 matching events; `historyWindowExhausted` means
to inspect event history rather than infer that no earlier answer exists.

Changed-file responses omit BB's automatic inline patches. Request up to three
relative paths for explicit patches; each patch is capped at 10 KB. File lists
are paginated, and BB's own truncation flags are preserved. `all` includes
changes since the environment's base branch and uncommitted work. Use
`uncommitted` for environments without a base branch. Requests cap at 64 KiB;
individual result data cap at 60 KB before MCP's text/structured duplication.

## Retry and recovery

Use one stable idempotency key per create/handoff/send instruction. Same key and same
arguments returns the stored operation. Reusing it for different arguments is
an `idempotency_conflict`. Keys are stored as hashes, and prompts are not copied
into the operation ledger. HTTP disconnect does not stop accepted coding work.

Handoffs share creation admission limits with ordinary threads. Replays use
the original supplied arguments rather than newly resolved defaults, including
after a scheduled time passes. Stored 0.1 create/send receipts remain valid.
After upgrading, refresh Executor's discovered tools to load the added schemas.

BB may commit a request before the plugin records its response. SDK failures
at that boundary and pending requests recovered after reload are retained as
`outcome_unknown`; they are never automatically dispatched again. Exactly-once
creation needs [upstream support](https://github.com/get-bb/bb/issues/3396).

```sh
bb mcp operations
# Inspect the matching thread and its history before confirming acceptance:
bb mcp reconcile op_ID thr_ID --confirmed
```

Reconciliation is local/operator-only, applies only to uncertain requests, and
checks the thread against the recorded project/host and any existing thread ID.
It records an operator-confirmed acceptance; it does not execute work. If you
establish that no request was accepted, deliberately issue a new instruction
with a new key. Keep the old unknown record for audit.

There is a 10,000-operation cap with no automatic key expiry. New instructions
fail closed at that cap; existing receipts remain readable/replayable. Back up
the plugin's BB-managed database before administrative maintenance. Settings,
HTTP token and request history must survive installation source changes.

## Development and verification

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install path:/absolute/path/to/plugins/bb-mcp --yes
bb plugin dev /absolute/path/to/plugins/bb-mcp
node tests/live-client.mjs
node tests/live-client.mjs --legacy bb_list_projects
node tests/live-client.mjs bb_get_thread '{"threadId":"thr_ID"}'
```

The live client runs on the BB server and obtains the plugin token in memory
through the CLI. It never puts the credential in process arguments or output.
`--url` targets the authenticated public endpoint. Use test worktrees and stop
their runtimes after verification.

Tests use the official BB fake host with real SQLite and official MCP clients.
They cover protocol negotiation, scope, runtime validation, queue/attention,
request conflicts, restart recovery and bounded output. BB enforces token
equality outside that fake host, so verify missing/wrong tokens against the
installed route as well. `bb plugin logs bb-mcp` logs tool names/outcomes only.

Follow the root README's draft-PR workflow. BB 0.42.1 cannot switch a populated
path installation to a managed Git branch in place. Use the documented stable
Git clone/path-rebind fallback and record its full commit; do not remove this
plugin to change its source. Keep the tested branch installed while the PR is
open. After merge, update the stable clone to `main`, build and reload, or use
a future data-preserving managed source switch.
