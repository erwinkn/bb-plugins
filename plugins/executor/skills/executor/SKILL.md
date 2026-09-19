---
name: executor
description: Use Erwin's Executor gateway for external integrations (Cloudflare, GitHub, Google Calendar/Docs/Drive/Gmail, Linear, Massive, Mobbin, Notion, Railway, Wisprflow, bb, Devin, Exa, Fal, Cursor cloud agents, DeepWiki, Details) or whenever executor_* tools are available. Prefer it over browser flows for those services.
---

# Executor

The `executor_*` tools proxy Erwin's Executor MCP gateway. `executor_execute`
runs sandboxed TypeScript with a `tools` proxy to every connected integration;
the other tools resume paused runs, read the gateway's own docs, and manage
saved UI artifacts.

Available integrations include `bb`, `cloudflare`, `cursor_cloud_agents`,
`deepwiki`, `details`, `devin`, `exa`, `fal`, `github`, `google_calendar`,
`google_docs`, `google_drive`, `google_gmail`, `linear`, `massive`, `mobbin`,
`notion`, `railway_mcp`, `wisprflow`.

If a call returns "Executor is not configured", ask the user to open the
Executor plugin's settings and set `accessToken` (with `refreshToken`,
`clientId`, `clientSecret` for automatic renewal) or `cfAccessClientId` +
`cfAccessClientSecret`, then retry.

## executor_execute

```ts
executor_execute({ code: "…TypeScript…" })
```

Inside `code`:

1. Discover: `const { items } = await tools.search({ query: "<intent + key nouns>", namespace?: "<integration>", limit: 12 });` — returns ranked `{ items, total, hasMore, nextOffset }`; page with `offset: nextOffset` when `hasMore`.
2. Inspect: `await tools.describe.tool({ path })` → `inputTypeScript`, `outputTypeScript`, `typeScriptDefinitions`. On `tool_not_found` use the `suggestions`.
3. Call: `await tools.<integration>.<owner>.<connection>.<tool>(args)` — the `path` from search/describe is already the full address; `tools[path]` works.
4. Live connections: `await tools.executor.coreTools.connections.list({})` → `{ address, integration, owner, name }` entries (address includes the `tools.` root).

Rules:

- Every call returns `{ ok: true, data }` or `{ ok: false, error: { code, message, status?, details?, retryable? } }`. Branch on `result.ok`.
- `emit(value)` appends user-visible output: plain values become text, `ToolFile` (`{ _tag: "ToolFile", name?, mimeType, encoding: "base64", data, byteLength }`) renders by MIME, MCP content blocks pass through. Emitted items come first in the result; the envelope reports an `emitted` count.
- `return` is only for structured data — returning a `ToolFile` or bare base64 emits nothing to the client.
- No `fetch`, `Buffer`, `atob`, `btoa`, `TextDecoder`, `TextEncoder` in the sandbox. Never decode bytes; forward a `ToolFile`'s base64 `data` as another tool's `bodyBase64`.
- `tools` is a lazy proxy — `Object.keys`, spread, `for…in` throw. Use `tools.search`.
- Filter large collections in code instead of calling per-item tools.
- TypeScript type syntax is stripped before execution (interfaces, `: T`, `as T`, generics are fine; decorators and `enum` are not).
- If a run pauses for interaction, the result carries an `executionId` — continue with `executor_resume({ executionId, action: "accept" | "decline" | "cancel", content? })`.

For the gateway's own long-form docs call `executor_skills({ name: "execute" })` once; `executor_skills()` with no name lists its small doc catalog.

## Artifacts

`executor_create_artifact` / `executor_edit_artifact` / `executor_list_artifacts` /
`executor_show_artifact` manage reusable React UI artifacts rendered by the
Executor console. Read `executor_skills({ name: "create-artifact" })` and
`{ name: "artifact-style" }` before writing one: data access is declarative
(`tools.<integration>.<tool>.queryOptions(args)` inside `useQuery`), artifact
code addresses integrations (not connections), and edits are find-and-replace
patches. Clients that cannot display artifacts receive a link — pass it to the
user.

`executor_tools` lists the gateway's live tool surface; `executor_call`
invokes any upstream tool by name when no `executor_*` mirror exists.
