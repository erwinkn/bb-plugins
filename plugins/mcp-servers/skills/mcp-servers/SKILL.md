---
name: mcp-servers
description: Use when a task needs a remote MCP server's tools that are not in this session, when an `<prefix>_*` MCP tool reports it needs authorization or is unreachable, or when asked to inspect or call the user's connected MCP servers.
---

# MCP servers

The MCP servers plugin turns each tool of each server the user connected into
a tool named `<prefix>_<tool>` (for example `linear_create_issue`), with the
server's own description, schema and instructions.

- **Adding or authorizing a server is the user's job.** It happens in
  Settings → Plugins → MCP servers (URL, name, and auth: none, a header, or
  OAuth). Don't ask for tokens in chat.
- **New or changed tools arrive with the next session**, not mid-thread. If
  the user just connected a server, its tools appear once this thread's
  provider session restarts.
- **Errors say what to do.** "needs authorization" means the user must click
  Connect on that server. "refused the header" means the header value is
  wrong. "disabled" or "removed" means the server is off.

Inspect from a shell (no secrets are printed):

```sh
bb mcp-servers list                     # servers, state, tool counts
bb mcp-servers tools <prefix>           # BB names of one server's tools
bb mcp-servers call <tool> '<json>'     # call a tool by its BB name
```
