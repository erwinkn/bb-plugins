# Shared ACP bridge (OptChat)

BB's ACP provider bridge, ported onto the public plugin SDK (`@get-bb/plugin-sdk` 0.6.15), plus
OptChat: the per-turn context hook (`turnContext`, protocol 4) that Chat memory's UniiChat mode
needs. Two plugins bundle it:

- [`plugins/provider-acp`](../../plugins/provider-acp/README.md) (`provider-acp-local`): Cursor,
  OpenCode, omp, Grok, Hermes and custom ACP agents;
- [`plugins/provider-antigravity`](../../plugins/provider-antigravity/README.md): Google's
  Antigravity CLI, with its usage handler in front.

Both import it by path (`../../lib/acp-bridge/src/index.js`); `bb plugin build` bundles it into
each plugin's `dist/host.js`, with no `@bb/*` import left.

## OptChat on ACP

The bridge advertises `turnContext: true` in `initialize`. For a thread whose tools include the
hidden `claude_code_turn_context` (Chat memory selects it in UniiChat scopes):

1. The hook never reaches the agent: it is stripped from every session's MCP tool list.
2. Before each new turn (never a steer, never a standalone `/compact`), the bridge calls it through
   `item/tool/call` with `{protocol: 4, input, requestId, sessionId, elapsedMs?}`, as the Claude
   Code bridge does. Whether a turn asks follows the tools BB resolved for that turn
   (`turn/start.dynamicTools`).
3. `{}`: the turn runs in the thread's session with its own text.
   `{session: "fresh", sessionId, systemPrompt, input}`: the bridge opens a new session on the same
   agent process (`session/new` with the turn's tools, so `memory_read` and `memory_zoom` reach a
   thread that got them after it started), reports it with `thread/identity`, closes the old one
   where the agent supports `session/close`, and sends `input` (with the turn's attachments) as its
   first prompt. The system prompt is the thread's instructions plus the answer's: on
   `session/new` as `_meta.antigravity.systemPrompt.append` where the agent advertises it
   (Antigravity), otherwise as `<system_instructions>` at the head of the first prompt. ACP gives
   the client no way to choose a session id, so the answer's `sessionId` is not used.
4. Anything else fails the turn, and the agent never sees its text (D458): a tool error, text that
   is not JSON, a malformed answer, no answer within 120 s, or a fresh session that fails or takes
   over 30 s to start (the thread stays on its previous session; a session the agent creates after
   that is closed, never adopted). `turn/start` is answered as soon as the input is accepted,
   before the context is asked: BB waits 30 s for that answer, the context may take 120 s. So a
   failure ends the open turn with a provider error (once, whether the failed request or the
   agent's exit report comes first), not with a `turn/start` error.
5. A reload of Chat memory (its `TURN_CONTEXT_RESTARTING` error, or BB's `Unsupported tool`) is
   asked again every second with `elapsedMs`, while less than 90 s have passed since the first
   ask; a retry still unanswered 92 s after it fails with the restarting error.
6. Steers that arrive while the context is fetched are answered at once (BB gives a steer 30 s
   too, so an answer held for the context could come after BB reported the steer failed, and a
   resend would run twice). They wait behind the turn's input and follow it into the session it
   runs in, or are lost with the turn when its preparation fails: the turn's provider error is
   what the user sees. After a failed preparation, steers get the same
   error until the next turn; outside a turn they get `NO_ACTIVE_TURN` (stale), so BB sends them as
   a new turn. A stop or interrupt cancels the context call at once.

The protocol constants and answer parsing are in `src/bridge/turn-context.ts`; the flow is in
`src/bridge/bridge.ts` (`prepareTurn`, `fetchTurnContext`, `startFreshSession`). Tests:
`src/bridge/turn-context.test.ts` and `src/bridge/bridge.turn-context.test.ts` (against the fake
ACP agent). A live check against `agy acp` 1.5.14 ran a fresh turn whose system prompt the agent
followed.

## Relation to upstream

Ported from `~/Code/bb/packages/provider-bridge-acp/src` at `8d6347c0e6` (2026-10-08). The ported
files keep upstream's code; the differences are:

- `src/bb.ts` maps upstream's `@bb/domain`, `@bb/provider-bridge-protocol` and its `bridge-kit`
  imports onto `@get-bb/plugin-sdk/provider-bridge` (some names are `experimental_` there), and
  defines the few the SDK does not export. Its `dynamicToolSchema` keeps `alwaysLoad`, which the
  SDK's 0.6.15 schema strips; `src/bridge-protocol.ts` parses `dynamicTools` with it on
  `thread/start`, `thread/resume`, `thread/fork` and `turn/start`.
- `src/process.ts` replaces `@bb/process-utils` with plain Node: the agent's process group stops
  leader first, `execPortableFile` kills its group on timeout.
- `src/launch-spec.ts` re-exports the SDK's copy of the launch spec schema.
- `src/test-support.ts` maps the tests' private imports onto `@get-bb/plugin-sdk/provider-bridge/testing`.
  The two first-party conformance tests (recorded cells, calibration) are not ported: their
  fixtures are not published.
- `src/bridge/cursor-mcp-approval.ts` counts claims per approval in `mcp-approvals.json`
  (`releaseCursorSessionMcpServer` replaces upstream's `revokeCursorSessionMcpServer`). A fresh
  session per turn means two sessions of one thread can claim the same approval at once (a turn
  that gave up while its claim waited on the file lock, and the session that replaced it), so
  BB's ownership belongs to the approval: it stays while any claim holds it and goes with the
  last release if BB wrote it. Ownership changes only once the file write succeeds: a removal
  that fails (a full disk, a lock timeout) leaves BB owning the approval, and releasing the claim
  again, or the last release of a later claim, retries it. The count is per process; two bridge
  processes sharing a project still race as upstream does.
  Known limitation, as upstream: nothing retries a failed removal on its own. When a fresh session
  replaces approval A with B, or a fresh session is abandoned, a failed release of A is logged to
  stderr (`failed to remove Cursor session MCP approval`) and A's entry stays in
  `mcp-approvals.json` until a later claim of the same approval releases it, or by hand.
- A few index reads carry `!` so the code also type-checks under the consuming plugins'
  `noUncheckedIndexedAccess`.
- The fake ACP agent gained `FAKE_ACP_SYSTEM_PROMPT_APPEND`, `FAKE_ACP_CLOSE_SESSION`,
  `FAKE_ACP_SESSION_NEW_ERROR_AFTER`, and an id per `session/new` after the first.

To take a newer upstream, copy its `src` over this one, rerun the import rewrite (`@bb/...` to
`./bb.js` or `../bb.js`, `@bb/process-utils` to `process.js`), and keep the differences above.

## Develop

This package has its own `node_modules`: bare imports in `src` resolve here, also when a plugin
bundles it. Each consuming plugin's `postinstall` runs `npm ci` here, so `npm ci` in the plugin is
enough. On its own:

```sh
cd lib/acp-bridge
npm ci
npm run typecheck
npm test
```
