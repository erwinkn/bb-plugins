# BB MCP

Remote control of BB from Grok Bot, Executor or another MCP client, for
trusted personal use. Version 0.4.0 exposes a single code-mode tool,
`bb_execute`, whose `bb` global mirrors the complete BB SDK: threads,
threadSections, projects, environments, files, terminals, hosts, providers,
plugins, system, skills, status, theme and guide. There is no plugin-side
permission layer; the endpoint grants the plugin's own owner-level access and
must only be reachable by systems you trust.

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
Former project/host/provider scopes, permission ceilings and quota settings
are retired and ignored. Credentials, settings values and the operation
database are preserved on upgrade. Refresh/reconnect the MCP client after
upgrading so it discards the removed per-operation tools.

## Code mode

`bb_execute(code, timeoutMs?)` evaluates a caller-supplied async function in a
sandboxed worker thread. Inside it, `bb` calls the same methods as `bb.sdk`
(`bb.threads.get({threadId})`, `bb.projects.list()`, `bb.files.read(...)`, and
so on — the full signature list is in the tool description), plus `bb.ops`
below. Compose calls, loop, poll and filter inside the sandbox; only the
returned value and `console.*` logs cross the wire.

A second tool, `bb_read`, runs the same code under the same limits but only
serves non-mutating methods — the gate applies to every host-bound call,
including `ops.run` and `approve`, which are rejected outright (`ops.get`
stays readable). It is annotated read-only so MCP clients can auto-approve
it — prefer it for monitoring and discovery flows, and keep `bb_execute`
for work dispatch. Client-side, configure your orchestrator to auto-approve
whichever of the two you use; server-side there is no per-call approval
layer by design.

Successful results contain `{"data":{"result":...,"logs":[...]}}`. The result
is the SDK's raw shape — `list` methods return bare arrays, reads return their
documented objects; nothing is wrapped per call. Filter or aggregate large
responses inside the sandbox before returning (a 256 KB result cap applies;
big intermediate values like `providers.models` are fine inside). SDK errors
reach the sandbox as exceptions carrying their `.code`; sandbox faults set
`isError` with the message only — no stack traces or argument logging.

```js
async () => {
  const op = await bb.ops.run({
    kind: "create", key: "ticket-42-start",
    call: "threads.spawn",
    args: { projectId: "proj_x", input: [{ type: "text", text: "Fix the failing tests", mentions: [] }], environment: { type: "host", hostId: "host_x", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } } },
  });
  const threadId = op.threadId;
  await bb.threads.wait({ threadId, status: "idle", timeoutMs: 60000 });
  const events = await bb.threads.events.list({ threadId, order: "desc", limit: "5", types: ["item/completed"] });
  return events.map(e => e.data?.item?.text).filter(Boolean)[0] ?? null;
}
```

### Durable dispatch (`bb.ops`)

The SDK has no request ledger, so the plugin adds two functions:

- `bb.ops.run({call, args, key?, kind?, threadId?, projectId?})` executes one
  SDK call inside a recorded receipt. Reusing `key` with identical
  `call`+`args`+scope replays the stored receipt (a concurrent retry joins the
  in-flight dispatch); a changed payload under the same key is
  `idempotency_conflict`. Ledgered calls intentionally run without the
  request's abort signal: they must survive client disconnects.
- `bb.ops.get({operationId})` reads a stored receipt.

`bb.approve({ threadId, interactionId, decision, grantedPermissions? })`
resolves a pending permission approval — the code-mode equivalent of
`bb thread approve` / `bb thread grant --scope session`. It verifies the
interaction is still a pending approval, checks the decision is offered, and
builds the resolution shape BB requires (`grantedPermissions` is
required-but-nullable on `allow_*`; `deny` takes none; `allow_for_session`
defaults to the request's `sessionGrant`, or to the requested permissions for
`permission_grant` subjects; an explicit `null` grants once-only scope). For
`user_question` and plugin-form
interactions, call `threads.interactions.resolve` directly with
`{ kind: "user_answer", answers }` or `{ kind: "request_answer", value }` —
inspect the interaction first for its contract.

A receipt's `state` is `accepted`, `failed` or `outcome_unknown`. `failed`
means BB definitively rejected the request (a pre-dispatch `ToolError` or an
HTTP 4xx) — nothing committed, so the key is free and retrying with corrected
arguments re-dispatches under it. `outcome_unknown` means BB may have
committed despite the lost response — inspect BB (e.g.
`threads.get`/`threads.list`) before retrying under a new key, and never
automatically redispatch it. `bb mcp operations` lists receipts;
`bb mcp reconcile <operation-id> <thread-id> --confirmed` records a manually
verified outcome after checking the thread exists and matches the recorded
project.

### Limits and boundary

- Execution ends at a 30 s default timeout (120 s max via `timeoutMs`), 500
  `bb` calls, or 8 KB of `console.*` output; runaway code is terminated with
  the worker. Workers get a 256 MB old-generation cap, and at most 8
  executions run concurrently (the rest queue). Termination never stops work
  BB already accepted.
- Cancelling the MCP call terminates the worker and propagates an abort
  `signal` into inner SDK calls (except `ops.run` dispatches, which are
  intentionally durable).
- Provided globals beyond `console`: `setTimeout`/`clearTimeout`, `Buffer`,
  `btoa`/`atob`, `TextEncoder`/`TextDecoder`, `crypto.randomUUID`/
  `getRandomValues`. There are no module imports.
- Methods returning live handles (`subscribe`, streams) are not exposed to the
  sandbox. `bb.guide.render()` returns BB's own usage guide for argument
  details.
- Terminals take exact arg shapes: `terminals.create` requires `scope`
  (`{kind:"thread", threadId}` / `{kind:"environment", environmentId}` /
  `{kind:"host_path", hostId, cwd}`) plus `cols` and `rows`;
  `terminals.input` takes `{terminalId, dataBase64}` — base64 PTY bytes, not
  `text`/`enter`. `files.write` takes exactly `{path, content}`.
- The worker is `node:vm` inside `worker_threads`: a reliability boundary for
  trusted orchestrators, not a hostile-code sandbox.
- When `threads.spawn` omits `permissionMode`, the plugin resolves one: the
  project's configured execution default, else `"full"` clamped to the system
  permission ceiling — never silently `"accept-edits"`. Injected defaults are
  marked `executionInputSources.permissionMode: "client-preference"`. On
  create/send/edit/queue calls, caller-supplied execution fields
  (`providerId`, `model`, `reasoningLevel`, `serviceTier`, `permissionMode`)
  are marked `"explicit"` automatically — BB silently drops them otherwise.
  `threads.fork` is the exception: its args schema does not declare
  `executionInputSources`, so its fields pass through unmarked.
  `threads.send`, `threads.fork` and queued-message creation are deliberately
  not defaulted — omitting `permissionMode` there inherits the thread's
  stored execution options.
- BB's own validation, provider policies, availability, costs, paging and
  client/proxy timeouts all still apply; nothing is clipped or admitted by
  the plugin.

## Develop and verify

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

Tests cover the sandbox bridge (composition, error propagation, timeout kill),
the SDK path dispatch, the durable-ops ledger (dedupe, outcome_unknown,
reconcile) and the MCP transport (auth, Host/Origin checks, `bb_execute`
end-to-end). `tests/live-client.mjs` performs calls with an in-memory
credential against a live BB.

## Upstream feedback desired in BB

Observed by orchestrator agents driving this endpoint:

- Provider catalog model IDs can be URL-encoded JSON; stable aliases (e.g.
  `swe-2`) would be easier for agents to use.
- Reasoning tiers vs. models are indistinguishable in the catalog — e.g.
  "SWE-2 Max" is `reasoningLevel: "max"` on model `swe-2`, not a model ID.
- `bb.guide.render()` is conceptual only; argument shapes for spawn/send
  remain tribal knowledge (this plugin now embeds the common shapes in the
  `bb_execute` description).

Follow the repository's data-preserving plugin update workflow. Never remove
a populated installation merely to change its source.
