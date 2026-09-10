Manage threads in every BB project from Grok Bot, Executor or another MCP client.

## Thread-focused control

Create, fork and hand off work; send or steer messages; stop/retry; rename,
organize and archive threads. Read conversations, results and changes; inspect,
edit, reorder or cancel queued work; wait for progress. Read and answer pending
questions/forms, and approve or deny a specific permission request, including
session grants when BB offers them.

All ordinary and Personal projects and hidden threads are available.
There are no plugin project allowlists, quotas, permission ceilings or output
clipping. Optional idempotency keys preserve request outcomes across retries.

## Deliberate boundary

No general SDK/CLI bridge, arbitrary plugin RPC, permanent deletion, direct
filesystem/terminal tools, Git/PR writes, publishing or BB administration.
Thread agents still work under their native permissions; approving a request
can permit command execution or file changes.

Requires BB 0.42.1 / SDK 0.4.47 and an HTTPS MCP endpoint with a BB-managed
token stored in the client's secret storage. Reconnect after an upgrade to
refresh tools. Native BB/provider policies, costs and client/proxy timeouts
still apply. Call `bb_get_capabilities` for the exact scope and boundaries.
