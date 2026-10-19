# Muse provider

Run Meta's Muse Code as a bb provider. The plugin registers provider `muse`
(models Muse Wonder 1.0, Spark 1.3 and Spark 1.2) and ships a provider bridge
that drives `muse serve` over Muse's own protocol, MSP: newline-delimited
JSON-RPC on stdio.

The approach follows T3 Code's Muse adapter
([pingdotgg/t3code](https://github.com/pingdotgg/t3code),
`packages/provider-muse`): one `muse serve` per session, client-minted
session and command ids, approvals driven by notifications plus
`approval/decide`, and per-call `promptTokens` for input usage.

## Install

Muse must be installed and signed in on every machine that runs Muse threads:

```sh
muse login            # once per machine; the plugin never copies credentials
muse exec "say hi"    # should answer
```

Then, from the main checkout:

```sh
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/muse --yes
```

The bridge looks for `muse` on the daemon's PATH, then in `~/.local/bin`
(the official installer's location, often missing from a service's PATH).
Set `BB_MUSE_EXECUTABLE` in the host daemon's environment to override it.

## Where it runs

Like every provider bridge, Muse runs on the **host of the thread's
environment**, not on the bb server: the host daemon downloads the plugin's
`dist/host.js`, verifies its digest and starts the bridge, which spawns
`muse serve` in the thread's workspace. A thread whose environment is on the
Mac runs Muse on the Mac; one on Hetzner runs it there.

On Hetzner, Meta answered an empty model catalog over IPv6
(`model catalog has no visible models`). `/etc/hosts` now pins
`api.meta.ai` to IPv4. If that address goes stale the symptom returns, and
the picker shows the bridge's error: "Muse's model catalog is empty…".

## What maps to what

| bb | Muse |
| --- | --- |
| Thread | One `muse serve` child holding one Muse session. The session id (a UUIDv7 the bridge mints) is bb's `providerThreadId`, so a thread resumes after a bridge, daemon or server restart (`session/resume`). |
| Turn, steer | `turn/start`; `turn/steer` into the running turn (`steerMode: inject`). |
| Stop | `turn/interrupt`, then waits up to 10 s for Muse to settle the turn. Answers once `muse serve` and everything left in its process group are gone (a shell that ignores SIGTERM is killed after 2 s). |
| `/compact` | `session/compact`. A fresh session answers "noop" and the turn ends with a warning. |
| Model, reasoning | Model from `model/list` (default Muse Wonder 1.0), applied with `session/setModel`. Reasoning effort per turn; Muse's `minimal` has no bb level and is dropped. |
| Instructions, skills | bb's instructions and its skill catalog become Muse's developer prompt (`-c run.developer_prompt=…`, fixed per process, which is why each thread gets its own `muse serve`). A prompt over 96 KiB is written to a file the prompt points at (Linux caps one argv string at 128 KiB). |
| bb tools | `initiative_*`, `memory_*` and every other bb tool are served by an MCP endpoint inside the bridge (streamable HTTP on 127.0.0.1, one bearer token per session), attached with Muse's `sessionMcp` capability. Muse names them `mcp__bb_bridge__<tool>`. Calls become `item/tool/call` requests; slow ones stream keep-alive pings so a tool waiting on a person does not time out. |
| Shell environment | bb's thread variables (`BB_THREAD_ID`, …) are set on `muse serve` and reach its shell. |
| Usage | `session/tokenUsage` is per model call; the bridge sums a turn's calls into one `usage` delta. Muse counts input including the cache, so input is reported net of cache reads and writes (Claude's convention). Context from `session/contextUsage`. No dollar cost: Muse reports none. |
| Subscription | `usage/changed` (5-hour window and weekly, in percent) feeds bb's rate-limit banner (warning at 80%, blocked at 100%) and the usage popup. The bridge keeps the last report in its data dir, because Muse only reports after a turn. |
| Errors | A failed turn shows Muse's error kind and message. Quota exhaustion (`error.quota` or a 429 "usage limit" message) is a `rate-limit` error with a `rateLimited` hint; `authRequired` asks you to run `muse login`. Retries (`turn/retryScheduled`) show as retrying errors. A crashed `muse serve` fails the open turn with its last stderr line, and the next turn restarts and resumes it. |

Rows: `bash` → command (with streamed output and exit code), `read_file` →
file read, `search` → search, `edit_file`/`write_file`/`apply_patch` → file
change (diffs from Muse's `tool_patch` document), `web_search`/`web_fetch` →
web rows, subagents and workflows → background delegations, a running tool
call Muse moves to the background (`background: true`, from auto-yield or a
user's move) → a background task that settles when it ends, after its turn if
need be, todos → a plan,
other tools → generic rows with Muse's own labels. Muse's reminder children
and the user's own message are not shown.

### One ordered queue per thread

Each thread's state has one writer: a queue of jobs run one at a time. bb's
commands (start, resume, turn, steer, stop), every frame Muse writes (in wire
order), Muse exiting, and your answers to approvals and questions are all
jobs. A job may await Muse's answer to a command it sent; frames arriving
meanwhile wait behind it. So a steer is accepted into the turn it went into
even when Muse sends that turn's completion before the steer's answer, and a
`turn/start` answer is matched to its turn whatever order the frames come in.
No timer or promise callback changes state.

Every input bb hands over ends one way: its request fails, or it is accepted
inside a bb turn that later closes. A turn Muse acknowledged but never started
(Muse crashed, or reclaimed a queued turn) still gets its input accepted and a
failed or interrupted ending. A host's work ends with the host: when
`muse serve` exits, is stopped, or is replaced for a new permission mode,
whatever it was running closes as failed or interrupted, and a stop answers
only once its process group is empty.

When Muse drops events from a thread's live stream (`view/gap`) or reports
the stream down (`session/viewHealthChanged`), the bridge reads nothing back
and splices nothing in. It closes that `muse serve` and fails the open turn
with an error that says so (with no turn open, the error goes on the thread).
The next turn starts a fresh `muse serve` and resumes the session from Muse's
own record, so no context is lost. Only the reply in progress is cut short.
Gaps need the bridge to fall behind Muse's push queue; none has been seen
live.

Every process the bridge starts is a `muse serve` it owns: a thread's host,
or a short-lived probe for the model list and health (the version comes from
the probe's handshake, and `muse` is found on PATH in-process). Shutdown stops
both and waits for their process groups; once the bridge is exiting it
launches nothing.

### Permission modes

| bb mode | Muse approval mode | Muse profile | Sandbox |
| --- | --- | --- | --- |
| Full | `allowAll` | `:unrestricted` | off (`--disable-sandbox`) |
| Auto | `promptUnmatched` | `:auto-review` (Muse's AI reviewer decides what it can) | on |
| Accept edits | `promptUnmatched` | `:ask-me` (workspace edits run; protected writes, new network targets and the like ask) | on |

Muse's prompts reach you as bb approvals: a shell command as a command
approval on its row, a protected write as a file-change approval, network and
other requests as a tool approval naming the host or path. Muse asks once per
stage of a compound command (`curl … | head`); bb shows the whole command
once and its answer covers every stage. In Full, Muse never asks, except for
workflow children, which the bridge approves. Muse's `request_user_input`
becomes bb's native question form.

Changing a thread's permission mode restarts its `muse serve` (sandbox
posture is fixed per process) and resumes the same session; bb notes the
restart in the timeline.

## Two decisions

**Muse's own memory stays on.** Muse injects a `memory_snapshot` into every
session and gives the model `read_memory`/`add_memory`/`edit_memory`; it
cannot be switched off except by pointing `XDG_DATA_HOME` elsewhere, which
would also move Muse's session store. In Regular mode bb adds no memory of
its own, so this matches Claude Code with its auto-memory on, and it is T3's
choice too. What Muse learns in a bb thread is shared with Muse in the
terminal. OptChat (Adventure coordinators) will revisit this: there, bb's chat
memory is the memory, and Muse's would compete with it.

**Foreign context stays on.** By default Muse loads `~/.claude/CLAUDE.md` as a
user rule ("written for Claude Code") and `~/.claude/skills` into its skill
catalog. These are Erwin's instructions and skills for every agent, so a bb
thread on Muse should see them as Claude and Codex threads do. One wart:
Muse does not expand Claude's `@import` lines, so a `~/.claude/CLAUDE.md`
that only says `@../.agents/AGENTS.md` contributes that one line. Under the
home directory the real file still arrives, because Muse reads
`.agents/AGENTS.md` in the workspace's ancestors (`~` is one); a workspace
outside `~` gets only the line (checked with `/private/tmp`). Making
`~/.claude/CLAUDE.md` a symlink to `~/.agents/AGENTS.md`, as
`~/.codex/AGENTS.md` already is, fixes it for Muse and changes nothing for
Claude. `--trust-workspace` loads each workspace's own `AGENTS.md` and
skills.

## Not at parity

- **Fork and rewind**: not supported (Muse rejects forks at turn boundaries).
- **Thread rename and archive**: not mirrored into Muse.
- **Plan mode**: not offered.
- **`instructionMode: "replace"`**: treated like `append` (bb's instructions
  are added to Muse's system prompt, never replace it).
- **`disallowedTools`**: ignored; Muse has no per-session tool filter on the wire.
- **Turn end**: Muse runs its goal and verify reminders after the final
  answer, so a turn stays open a few seconds after the reply arrives. A
  reminder can send the agent back to work in the same turn, so the bridge
  waits for `turn/completed`. A shell the agent starts in background mode
  also holds its turn open until it ends; Muse then reports the result in a
  turn of its own.
- **Memory per thread**: each live thread holds one `muse serve`, about
  150 MB idle. bb releases idle sessions; a shared host per permission mode
  with per-turn instructions would cut this and fits the OptChat work.
- **Approvals Muse resolves on its own** (its reviewer, a timeout) leave bb's
  prompt open until it is answered; the answer is then ignored. bb has no
  bridge-side way to withdraw a prompt (see the upstream note in the
  repository README).

## Develop

```sh
npm install
npm run typecheck
npm test            # a scripted fake `muse serve`; spends no Muse quota
npm run build
node tests/live-smoke.mjs ~/scratch/muse-live            # real Muse, ~4 small turns
node tests/live-smoke.mjs ~/scratch/muse-live approval   # adds an accept-edits network approval
```

The live smoke runs `dist/host.js` exactly as the host daemon does, with
Muse's data and config isolated under the scratch directory (only
`auth.json` is linked from `~/.config/muse`). It checks a shell command, a bb
tool call over MCP, an interrupt, a bridge restart with a resumed session
that remembers the first turn, and the usage windows.
