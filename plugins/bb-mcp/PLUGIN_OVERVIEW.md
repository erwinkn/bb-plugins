Remote control of BB for a trusted orchestrator (Grok Bot, Executor) through one code-mode MCP tool.

`bb_execute` runs JavaScript in a sandboxed worker with a `bb` global mirroring the complete BB SDK — threads, projects, environments, files, terminals, hosts, providers, plugins, system, skills, threadSections and guide — plus `bb.ops` for durable, deduplicated dispatch receipts that survive client disconnects. Compose calls, loop, wait and filter inside the sandbox; only the final result crosses the wire.

The endpoint grants the plugin's owner-level access over `x-bb-plugin-token` authentication with Host/Origin checks. This is a trusted-caller remote interface, not a hardened public sandbox — protect the token accordingly.
