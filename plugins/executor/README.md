# Executor

Proxies Erwin's Executor MCP gateway — `https://executor.erwinkn.com/mcp`,
behind Cloudflare Access — into bb agent tools on every provider and machine,
from one install. bb has no provider-agnostic MCP configuration, so the plugin
speaks streamable-HTTP MCP itself (`mcp.ts`: `initialize` +
`notifications/initialized` + `tools/list`/`tools/call`, JSON or SSE-framed
responses, `mcp-session-id` reuse with re-initialize on session-expired 404s)
and registers mirror tools through `bb.agents.registerTool`, selected for all
providers by `bb.agents.configure`.

Registered tools (upstream name in parentheses):

- `executor_execute` (`execute`) — sandboxed TypeScript with a `tools` proxy
  to Erwin's connected integrations and `emit` for user-visible output.
- `executor_skills` (`skills`) — the gateway's own usage docs.
- `executor_resume` (`resume`) — continue a paused run by `executionId`.
- `executor_create_artifact` / `executor_edit_artifact` /
  `executor_list_artifacts` / `executor_show_artifact` — saved UI artifacts.
- `executor_tools` (`tools/list`) — the live upstream surface.
- `executor_call` — pass-through for any upstream tool not mirrored above.

Tool results are bounded (≤64 KiB per part, ≤128 KiB total, then truncated).
The `skills/executor` skill teaches agents the `tools.search` →
`tools.describe.tool` → `tools.<address>(args)` workflow.

## Settings

Configure auth in the plugin's settings (Settings → Plugins → Executor).
Either credential type works; both may be set.

**OAuth** (Cloudflare Access authorization_code + PKCE):

| Setting | Secret | Purpose |
| --- | --- | --- |
| `accessToken` | yes | `Authorization: Bearer <token>` on every request. Lives ~15 min. |
| `refreshToken` | yes | Rotates the access token via the refresh_token grant. |
| `clientId` | yes | Dynamically registered client (client_secret_basic). |
| `clientSecret` | yes | Sent as HTTP Basic on the token endpoint during refresh. |

When all four are set the plugin refreshes on 401 and ahead of the persisted
expiry, and writes rotated `accessToken`/`refreshToken` back to settings via
`experimental_set`. Without the refresh trio, expect calls to fail with a 401
error once the token dies — paste a fresh `accessToken` to recover.

**CF Access service token**:

| Setting | Secret | Purpose |
| --- | --- | --- |
| `cfAccessClientId` | yes | `CF-Access-Client-Id` header. |
| `cfAccessClientSecret` | yes | `CF-Access-Client-Secret` header. |

Non-secret settings: `endpointUrl` (default `https://executor.erwinkn.com/mcp`)
and `tokenEndpoint` (default
`https://erwinkn.cloudflareaccess.com/cdn-cgi/access/oauth/token`).

With no credential configured, every tool returns an error telling the agent
to ask the user for these settings.

## CLI

```sh
bb executor status                      # endpoint, which credential fields are set, session state
bb executor tools                       # tools/list against the gateway
bb executor call <tool> '<json-args>'   # one-off tools/call, e.g. bb executor call skills '{"name":"execute"}'
```

## Notes

- Tool calls execute in the bb server's plugin worker, not the thread's
  machine — fine for HTTPS, but `executor_*` never touches the workspace.
- Tool-set changes apply on the next provider session start.
- Cloudflare bot management fingerprints TLS clients (error 1010); the plugin
  worker's Node fetch passes. Test scripts should use curl or Node, not
  Python's urllib.
