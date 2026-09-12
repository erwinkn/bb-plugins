Remote control of BB for a trusted orchestrator (Grok Bot, Executor) through a code-mode MCP.

`bb_execute` runs JavaScript in an isolated worker with a `bb` global mirroring the complete BB SDK — threads, projects, environments, files, terminals, hosts, providers, plugins, system, skills, threadSections and guide — plus `bb.ops` for durable, deduplicated dispatch receipts and `bb.approve` for remote permission approvals. `bb_read` exposes the same surface restricted to non-mutating methods, annotated read-only so clients can auto-approve it. Compose calls, loop, wait and filter inside the worker; only the final result crosses the wire.

The endpoint grants the plugin's owner-level access over `x-bb-plugin-token` authentication with Host/Origin checks. This is a trusted-caller remote interface — the worker is a reliability boundary, not a security sandbox — protect the token accordingly.
