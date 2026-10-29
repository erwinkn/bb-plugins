# MCP servers

Connect any remote MCP server by URL and give its tools to every agent BB
runs: Claude Code, Codex, Pi, Muse and ACP agents. Unlike Executor, which puts
its integrations behind `execute`/`search`, each upstream tool becomes a BB
tool with the server's own description and input schema, and the server's
`instructions` reach the agent's system prompt.

Add servers in **Settings → Plugins → MCP servers**.

## Install

```sh
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/mcp-servers --yes
```

Requires BB 0.45 (Plugin SDK 0.6.15). The plugin keeps everything in its data
folder (`<dataDir>/plugins/mcp-servers/`) and declares no BB settings.

## What agents get

For a server with prefix `linear`, the upstream tool `create_issue` becomes
`linear_create_issue`.

- **Names.** `<prefix>_<tool>`. MCP allows `.` and `/`; BB does not, so those
  become `_`. A name that would pass 48 characters, or that two upstream names
  would share, ends in a 6-character hash, salted again in the unlikely case
  that it meets a name already taken. The 48 comes from the harnesses'
  64-character cap minus Claude Code's `mcp__bb-bridge__` prefix.
- **Descriptions.** Passed verbatim. An empty one becomes the tool's title,
  or `<tool> (<server>)`.
- **Schemas.** Passed verbatim, except for two things BB refuses at
  registration. A root without `type: "object"` gets one. A `$ref` that
  closes a cycle (through refs or through a parent) is dropped, and its node
  says so in `description`; BB
  rejects recursive schemas because some providers reject the whole tool list
  over one. The settings page lists each change per tool. The server still
  validates the arguments.
- **Instructions.** BB takes up to 4,096 characters of instructions per tool,
  each piece under its own header, with no cap on the total. The server's text
  is therefore split across its tools, under the heading `Instructions from
  the MCP server "<name>"`. Only when it needs more pieces than the server has
  tools does the rest go into the last tool's description. Nothing is
  truncated.
- **Results.** `text` and `image` pass through. Audio and binary resources
  become a note saying what was left out. `resource_link` and text resources
  become text with their URI. `structuredContent` is appended as JSON unless
  a text part already mirrors it. `isError` passes through. Text is capped at
  100 KiB per part and 200 KiB per result, images at 8 MiB per result.

### When tools change

BB registers plugin tools once per plugin load and never changes a running
provider session's tool list. So:

1. At activation the plugin registers the tools each enabled server served
   last time (`servers.json`), without touching the network.
2. Live connections refresh the lists: on connect, and on
   `notifications/tools/list_changed` in both protocol eras.
3. When the result differs from what was registered, the plugin reloads
   itself. It waits 1.5 s for things to settle, waits for in-flight tool
   calls and OAuth operations (up to 2 minutes), and reloads at most once
   every 20 s. That time
   is kept on disk, so a server whose list changes on every connect can't
   reload the plugin in a loop.
4. Agents get the new tools when their provider session is next built:
   after 30 minutes idle, a Stop, or a daemon or bridge restart. A running
   thread keeps calling the tools it has; a removed or disabled server's
   tools answer with an error.

## Transports and protocol versions

The plugin uses the official TypeScript SDK v2 (`@modelcontextprotocol/client`).

- **Streamable HTTP** with era negotiation. It probes with the 2026-07-28
  `server/discover` and falls back to the 2025 `initialize` handshake
  (2025-11-25, 2025-06-18, 2025-03-26). Every connect probes again: connects
  are rare, and a cached verdict would also freeze the server's discovery
  data (its instructions).
- **Legacy HTTP+SSE** (2024-11-05) when the URL refuses Streamable HTTP
  (404/405/400), and first from then on.
- **Sessions.** A call is retried on a new session only when it provably
  never ran: a 404 to a request that carried an `mcp-session-id` (the spec's
  "session terminated" answer), or no open transport. Any other failure,
  including a 404 from a stateless server, goes back to the agent as is. A
  connection that was up for 30 s and drops reconnects in about a second. A
  notification stream that has used up its retries also counts as a drop.
  Anything else retries with backoff, from 2 s up to 5 minutes.
- Remote URLs only: `https://`, or `http://` for localhost.

## Authentication

- **None.**
- **Header.** Any header name, typically `Authorization: Bearer …`. Sent on
  every request.
- **OAuth 2.1**, per the MCP authorization spec, through the SDK's `auth()`:
  protected-resource metadata (RFC 9728) from the 401's `WWW-Authenticate`,
  then the well-known paths; authorization-server metadata (RFC 8414 / OIDC);
  PKCE S256; resource indicators (RFC 8707); `iss` checks (RFC 9207, SEP-2352).
  For the client there are three choices:
  - dynamic registration (RFC 7591), the default: a public client with
    `token_endpoint_auth_method: none`;
  - a pre-registered client ID, plus an optional secret;
  - a client ID metadata document (SEP-991) you host on your own https URL.
  Tokens refresh shortly before they expire (a minute ahead, or a quarter of
  the lifetime for short-lived tokens) and on a 401. Token-changing operations (a refresh,
  Connect, the redirect's code exchange) run one at a time per server, so
  none overwrites what another wrote. A refresh is shared by every
  connection, gives up after 30 s, and on failure discards only the tokens
  it started from. Connect always starts a new login; it never spends the
  refresh token. When a refresh fails,
  the server shows "Needs authorization" and the agent is told to ask you.
  A background refresh never starts a flow of its own.

### The redirect, and using BB remotely

The redirect URI is a plugin HTTP route on whatever origin your browser uses:

```
https://erwin.getbb.app/api/v1/plugins/mcp-servers/http/oauth/callback
```

The redirect is a top-level GET, so it carries your BB Connect session, and
BB's `local` route mode accepts it (no `Origin` header). A one-time `state`,
valid for 30 minutes and used once, ties it to the flow you started. Each
flow keeps its own verifier and client, so starting a second one doesn't
break the first. The page then says
"Connected to <server>". A registration is bound to its redirect URI, so
using BB from another origin (localhost, say) registers again.

Fallback: if that tab ends on an error page (a pre-registered client with
some other redirect URI, a proxy), paste its address into the field under
Connect.

Two things that don't work, and why:

- **A client metadata document hosted on BB.** BB Connect answers anonymous
  requests with its sign-in page (401), so an authorization server can't
  fetch one from erwin.getbb.app. Host it elsewhere and paste its URL.
- **Authorization servers that redirect with `response_mode=form_post`.** The
  plugin never asks for it.

## Secrets

Header values, client secrets, tokens and in-flight PKCE state live in
`<dataDir>/plugins/mcp-servers/secrets.json`. The file is mode 600 and written
atomically. RPC views say only whether a value is set.

A server can quote the credential it was sent, in an error, a result or its
own tool metadata. So everything a server says passes one redactor
(`[redacted]`) before it reaches the UI, a log, `servers.json` or an agent:
errors, text results, tool names, descriptions, schemas, instructions, and
the SDK's own `[mcp-sdk]` warnings. The redactor masks:

- every stored secret: header values and their credential part, client
  secrets, tokens, PKCE verifiers;
- the forms they are sent or quoted in: URL- and form-encoded, base64 and
  base64url, JSON-escaped, and HTTP Basic `client_id:client_secret`;
- for an hour after they change, the values they replaced (so a response to
  a request that used a rotated token is still masked).

Results are masked whole, every field, before they are cut to size. An
image whose type isn't a plain `image/*` MIME type becomes a note.
Credentials you type (a header's credential after its scheme, a client
secret) must be at least 8 characters, so each can be masked; issued tokens
are masked down to 4.

- **Forget tokens** drops the tokens and any flow in progress. It keeps the
  client: a pre-registered secret, the authorization server it is bound to,
  and dynamic registrations.
- A new URL or new OAuth settings forget the tokens too. A new client ID or
  metadata URL also drops the client.
- Each of these resets bumps the server's epoch. An OAuth operation that
  began before a reset (a slow refresh, say) can't write its result back.
- A pre-registered client is bound to the first authorization server it is
  used with. If the resource later points elsewhere, the plugin refuses to
  send it there.
- Removing a server deletes its secrets.
- An unreadable `servers.json` or `secrets.json` stops the plugin from
  loading. The error names the file, never its contents. The plugin doesn't
  start empty and overwrite the file.

## CLI

```sh
bb mcp-servers list                     # servers, state, tool counts (no secrets)
bb mcp-servers tools <prefix>           # the BB names a server's tools register as
bb mcp-servers call <tool> '<json>'     # call a tool by its BB name
```

## Develop

```sh
npm ci --include=dev
npm run typecheck
npm test                       # local fixtures: 2026 + 2025 + SSE servers, mock OAuth AS
MCP_LIVE=1 npx vitest run live # DeepWiki call; Linear up to the authorization URL
npm run build
```

## Limits

- Tools only. No resources, prompts, sampling, elicitation or roots, so a
  server that asks for input mid-call (2026 `input_required`, 2025
  elicitation) gets an error for that call.
- BB caps a plugin's `configure()` selection at 256 tools. This plugin doesn't
  call `configure()`: every registered tool goes to every thread, and a tool
  name another plugin already owns stays theirs (the settings page shows the
  conflict). Selecting a name the plugin doesn't hold would fail
  `configure()` and drop all of its tools.
- Tool calls run in the BB server's plugin worker, not on the thread's
  machine.
