# Voice Mode

Based on [bb-handsfree](https://github.com/swairshah/bb-handsfree) by
swairshah (copied at commit `79d5083`). Renamed, with the sidebar voice bar
removed; the composer button, the **Voice** sidebar page, and the keyboard
shortcuts remain.

**Talk to bb.** Voice Mode adds a voice agent to [bb](https://getbb.app): click
the little waveform button in the composer, start talking, and an assistant
with real control over bb does the work — finds threads, puts them on screen,
messages your coding agents, kicks off new work, and reads results back to
you.

## Quick start

1. Install and configure:

   ```sh
   cd plugins/voice-mode
   npm ci --include=dev
   bb plugin install . --yes
   # Optional: skip this when `codex login` is done on the bb server machine.
   bb plugin config voice-mode set openaiApiKey <your-openai-key>
   bb plugin reload voice-mode
   ```

2. Open any thread (or the New thread screen) in bb. Next to the mic button
   in the composer you'll see a **circle with a waveform**.

3. Click it. Allow microphone access the first time. When the bars start
   dancing, you're live — just talk. Click again to hang up.

The button has three states:

| Button | Meaning |
|---|---|
| Still bars | Idle — click to start |
| Pulsing outline | Connecting |
| Animated bars | Live — it's listening; click to stop |

Keyboard: **Cmd+Shift+H** (Ctrl+Shift+H on Windows/Linux) starts or stops a
call from anywhere in bb; **Cmd+Shift+U** mutes/unmutes during a call. Both are
also in the quick palette (Cmd+Shift+P) under Voice Mode. To rebind them, open
Settings → Plugins → Voice Mode → **Keyboard shortcuts**, click **Change**, and
press the new combination.

## Things you can say

- *"What's running right now?"* — lists your live threads
- *"Find the thread about the flaky login test and put it on screen"*
- *"Spotlight that pane"* / *"maximize it"* / *"restore it"*
- *"What did the agent say?"* — summarizes the latest output aloud
- *"Tell it to also add tests for the error path"* — messages the thread's agent
- *"Start a new thread in the replay project: fix the CI timeout"*
- *"Show me the diff for that thread"*
- *"Stop that thread"* / *"archive it"* / *"rename it to 'CI fix'"*
- *"Type a prompt for me: refactor the session store to…"* — writes into
  your composer so you can review and hit send yourself
- *"What automations do I have?"* — runs other installed plugins' `bb`
  commands (curate which with the `pluginCommands` setting)

The agent always knows which thread and project you're looking at — even as
you navigate mid-conversation — so "this thread" just works. If a project
lives on several machines, it checks which and asks before starting work.

A voice session is shared across all your bb windows and devices: the **Voice**
sidebar entry shows a live indicator with the call duration, and any window
can pick it up or stop it.

Background thread announcements wait until the conversation is quiet. Each
announcement uses a separate response with tools disabled. Thread titles and
results stay out of the main conversation. If a result is missing, Voice reports
the status and says that details are unavailable; ask for details to read the thread.

A disconnected network connection gets up to 10 seconds to recover. Voice
shows a reconnecting notice during this period. A failed connection ends the
call immediately. A closed event channel also ends the call because it cannot
resume speech events or tool responses.

## One Voice area on mobile and desktop

Start a call from Voice, the composer button, or the shortcut. A new call opens
Voice. Give instructions and hear progress and results in that conversation;
opening a work thread is not required.

Visual inspection is optional. Ask "show that thread" to see it inside Voice,
or "show my running threads" to add them to its thread switcher. Select
Conversation to return without ending the call. Closing a view does not stop
its thread. No extra Voice Mode entry appears in a work thread's side panel.
There is no fixed Views side-panel tab that opens automatically on desktop.

Opened threads stay in the switcher until you close them on desktop and mobile.
Opening a thread again selects its existing view. There is no setting for this.
The switcher lasts for the loaded app session; refreshing or reloading the plugin
clears it. Creating work and reading diffs never navigate to work threads.
A missing work prompt is requested by voice.

The embedded view uses BB's supported ThreadChat component. If it cannot open,
Voice reports that and keeps the call running. The current plugin routes native permission decisions to BB's approval UI,
which can be inspected inside Voice. The SDK exposes interaction response
methods; live support for each interaction kind still needs verification. The
plugin never automatically approves them.

Older mobile and desktop navigation proposals under docs/ describe the previous
flow. This dedicated Voice area supersedes their entry-point navigation rules.

## Coordinator mode

Every new call uses the coordinator. Settings → Plugins → Voice Mode →
**Coordinator** selects its provider, model, supported reasoning effort, and
fast service when the provider offers it. These choices apply to new logical
sessions. Existing sessions keep their coordinator and saved history.

The realtime voice model cannot change BB itself. It listens,
hands each request to a hidden BB thread (the coordinator) with the user's
original words, and speaks the coordinator's replies. The coordinator acts
through BB's own tools (the `bb` CLI) and reports back through a
coordinator-only `voice_reply` tool. It asks a question through `voice_ask`
only when the target or intent is materially ambiguous, or when BB requires an
approval. Clear requests run without a second confirmation; a conditional
request such as "we can archive it, nothing remains, right?" runs once the
coordinator has verified the condition.

The coordinator sends follow-ups, new feature requests, and comments with
`bb thread tell --mode queue`. Idle threads can start immediately; active threads
finish their current turn first. Steering is reserved for needed interruptions,
such as a wrong target, a constraint violation, or an explicit request to
interrupt. An ordinary correction does not by itself require steering. This
work-thread policy is part of the coordinator instructions; BB executes its
native commands. The bridge also queues routine requests to the coordinator.

What the plugin guarantees in this mode:

- The voice session has no tool that sends, starts, stops, archives, or renames
  threads, and the server refuses those tools. There is
  no fallback to the direct path on errors.
- A request is accepted only when a completed input transcript has been bound
  to it and recorded durably. Speech that starts before a handoff was sent
  holds that handoff; the model is told and may delegate again with the
  complete request. Partial speech at hangup creates no request. If transcription
  fails or times out, the server asks the user to repeat it and sends no work.
- Every dispatch is recorded before it is sent and its BB receipt (sent or
  queued) afterwards. An ambiguous network failure is reconciled against the
  coordinator's queue and timeline before any retry. An unknown result stays
  unknown when those checks fail or contain no receipt; Retry checks again
  without resending. An unknown create also blocks another coordinator spawn.
  These checks do not guarantee exactly-once execution of native agent commands.
- Final replies are spoken after the coordinator's turn settles and the user
  is quiet. Clarifications and approvals can reach the user while the
  coordinator waits. Background updates use the full idle gate: the user is
  not speaking, the current request is answered, the coordinator is idle, no
  question is blocking, playback is finished, and two seconds have passed.
- Only watched threads produce updates: threads the conversation discussed,
  delegated to, or that you watch explicitly. Each spoken batch carries at
  most two updates; failures are never hidden by later status changes.
- What the user actually heard is tracked separately from what was generated
  (generated, playing, delivered, interrupted). A bounded, labelled copy of
  each spoken reply is added to the voice context, so "which thread?" after an
  announcement resolves to that announcement.
- A question stays alive as a real pending interaction on the coordinator
  thread until an answer or an explicit cancellation. UI submission and
  delivery to the coordinator are tracked separately; a form submitted after
  the tool invocation was torn down is stored and redelivered. Hangup cancels
  the native row, keeps the question unresolved, and asks it again on resume.
- Hangup lets accepted work finish. Late results become queued updates and
  are read out as a brief digest after the opening request of the next call
  is answered. The coordinator runtime is released once its work settles.
- One coordinator per logical conversation. Calls resume the last
  conversation by default; **New session** on the Voice page starts a
  separate coordinator, and the old one finishes its work without speaking
  into the new call.

The coordinator runs in a personal-project environment on an automatically
chosen connected machine, with its own provider and model. The personal
project's default machine is preferred. There is no machine selector. An
unavailable provider or model is reported as a recoverable failure. Normal
permissions apply; the plugin never forces full permissions.

The Voice page opens to a list of logical sessions. Select one to read the
conversation, with one assistant identity. **Continue** resumes that session
and its coordinator; **New session** creates a separate conversation. Selecting
history starts no work. Old physical-call transcripts remain available and
are linked to their existing conversation where that association is known.
Continuing an older standalone call gives it a new logical session without
rewriting its history.

The session's **Coordinator** tab shows its hidden thread, pending work with
retry, questions, pending approvals, watched threads, and queued updates.
**Diagnostics** shows the original event log. Thread inspection stays inside
Voice and preserves the call. The composer pill shows "Working…" while a
request is with the coordinator.

The Prompt field always opens for editing. Saved instructions apply to new
voice calls and the next coordinator request. Unchanged preferences are omitted
from later requests. Existing prompt history is retained. The required tool and
reply contract stays in place. The nonfunctional Speaker selector is removed;
audio output follows system sound settings.

The conversation joins user speech fragments until assistant playback starts or
a pause reaches five seconds. It uses recorded audio boundaries when available,
then event times for older calls. Delayed transcripts keep their spoken order.
Raw events remain unchanged. This grouping does not delay audio responses or
change the provider's 700 ms VAD setting.

The user hears one assistant. The bridge gives one short, context-specific
acknowledgment after the tool response settles, unless that response already
spoke. It does not prompt another response after the tool result. Assignment
receipts and routine progress stay internal. Only a useful blocker, changed
result, or watched-work recap reaches the conversation. Routing details belong
in the debug tab unless the user asks for them. Repeated blockers, completed
batch replies, and replies to ended requests are suppressed.

Requests use compact structured context. Original transcript items are kept
once, in order; model interpretation is separate. Unchanged context is not
repeated. Identical background states are coalesced across event ids and
completed batches. Native BB messages still follow BB dispatch rules; this
revision does not intercept them. Their replies cannot attach to another voice
request or repeat a completed batch. SDK 0.4.47 has a `message.dispatch` hook
with wait and reject decisions, but no quiet consume-and-coalesce decision.

The bridge supplies the literal reply text in its speech instructions and
checks the returned transcript. A mismatch is logged separately and never
recorded as delivery of the intended words or replayed automatically. Live
model compliance and device playback still need physical call testing.

The coordinator can use `voice_overview` to get one fresh snapshot of up to 30
active or recent threads, drawn from the 200 most recent threads and the
existing 30-minute recent-work window. The snapshot includes titles and
runtime status and parent-thread IDs. Overviews group child work under its
parent and focus speech on parent workstreams by default. Child details are
included for useful status, blockers, or an explicit request for detail.
The snapshot is not evidence that a task is complete; detailed checks
still use native BB tools when required.

Speech logs include response, item, request and reply IDs, user-turn numbers,
and monotonic event timing. Playback events are matched to their response;
a late event cannot finish a different reply. The conversation view uses IDs
to combine transcript and playback records. Historical speech without those
IDs keeps an unknown playback state; matching words alone are not evidence.

Verified so far: deterministic fake-host and fake-realtime tests for bridge
ordering and recovery, and a disposable hidden thread spawned into a
personal environment on this machine through the same BB contracts. Not yet
verified: physical desktop and mobile calls (audio interruption, playback
tracking, embedded thread inspection), live model behavior for conditional requests,
and the 3–5 second first-useful-answer target.
The bridge logs `handoff.dispatched` (transcript wait) and `reply.playing`
(milliseconds since the end of speech and since the handoff) in each session
transcript for that measurement.

## Inspecting live threads from the terminal

The same "Live threads" view from the sidebar is available as a CLI, for you
and for your coding agents:

```sh
bb voice-mode live            # who's running right now
bb voice-mode live --json     # machine-readable
bb voice-mode read thr_xxxxx  # a thread's status + latest assistant output
bb voice-mode usage           # what your voice sessions cost, per day (estimated)
bb voice-mode stop            # stop an active voice session in any bb window
```

Agents discover these commands automatically through bb's plugin-commands
skill.

## Settings

Open the Voice Mode plugin settings for curated sections:

- **Models & voice** — the OpenAI Realtime model, the assistant voice (marin
  and cedar are the highest-quality options), and a badge showing which
  credential Aide will use.
- **Behavior** — whether Aide announces thread events, and which installed
  plugins' `bb` commands it may run (all / none / a specific list).
- **Audio** — pick and test the microphone with a live input-level meter. The
  chosen mic is stored in the current browser and applies to the next voice
  session; if it disconnects, Voice Mode falls back to the system default.
  Playback always uses your system-default speaker (change it in your OS Sound
  settings).
- **Keyboard shortcuts** — rebind the start/stop and mute keys: click
  **Change** and press the new combination (Esc keeps the current one). A
  binding needs ⌘/Ctrl or Alt, or a function key, so it can't fire while you
  type, and bb's own Cmd+Shift+P / Cmd+Shift+M are refused. Bindings are
  shared across your devices.

The only credential is the **OpenAI API key**, a secret stored in bb's plugin
secret store (0600 file, never in the db or frontend). It's optional: leave it
blank to use your ChatGPT subscription (`codex login`), or set `OPENAI_API_KEY`
in the bb server's environment. Set it in the settings field, or via the CLI:

```
bb plugin config voice-mode set openaiApiKey <your-openai-key>
```

Model, voice, and behavior are configured from the settings sections above (no
longer via `bb plugin config`).

## Troubleshooting

- **No button?** Composer actions hide in bb's compact layout — widen the
  window. Also check `bb plugin list` shows `voice-mode … running`.
- **"needs-configuration"** — set the API key (Quick start step 1).
- **Connects then drops** — check `bb plugin logs voice-mode -f` while clicking;
  the SDP exchange error (bad key, model name) is logged there.
- **No audio out** — the first click must come from you (browser autoplay
  rules); if you started it and hear nothing, check system output device.

Your audio goes directly from the bb app to OpenAI over WebRTC; the API key
never leaves the bb server, and no audio is stored by the plugin.

---

## For developers

Architecture: bb's plugin frontend runs in a real browser context, so mic
capture and playback live in `app.tsx` (getUserMedia + RTCPeerConnection +
data channel) with no native helper.

```text
app.tsx            composer button + Voice sidebar page registration
voice-agent.ts     WebRTC session, data channel, tool dispatch
voice-chrome.tsx   waveform button + session UI; sessions-panel.tsx sessions view
server.ts          API key + SDP exchange, bb tools via bb.sdk, `bb voice-mode` CLI
```

More detail: [architecture](docs/handsfree-voice-architecture.md)
and [docs/voice-scenarios.md](docs/voice-scenarios.md).

The [Voice conversation coordinator](docs/coordinator-plan.md) is implemented
as the required path for new calls. See
[Coordinator mode](#coordinator-mode) above.

Tool-call flow: model → data channel → `app.tsx` → plugin RPC `runTool` →
`bb.sdk` → output back over the data channel (function_call_output +
response.create).

Voice tools: `get_context`, `list_projects`, `list_machines`,
`list_live_threads`, `list_threads`, `search_threads`, `read_thread`,
`focus_thread`, `set_pane`, `send_to_thread`, `start_thread`, `stop_thread`,
`archive_thread`, `rename_thread`, `show_diff`, `update_instructions`,
`run_plugin_cli`, plus frontend-local `set_composer_text` /
`append_composer_text`.

Dev loop:

```sh
bb plugin dev          # rebuild + reload on save
bb plugin logs voice-mode -f # tool traffic and errors
```

Both clients support `focus_thread`, `focus_threads`, and `manage_views`
for optional inspection inside Voice. Native pane navigation is not exposed.

## Call controls and saved data

An app-wide controller keeps RPC and realtime controls active while settings
or another plugin page is open. Composer and Voice page bindings take priority
for tool context. This requires BB 0.42 and Plugin SDK 0.4.47 or later.

The server assigns a sequence number before microphone acquisition. The newest
call claim replaces the previous claim across windows. CLI Stop records an end
marker and stops a frozen owner when it reconnects. A failed or cancelled start
also records an end marker.

Agent requests to change standing instructions create a suggestion. Review the
suggestion in Voice Mode settings and press Save to activate it for later calls.
The agent cannot activate the suggestion through its tools.

Event payloads are limited to 64 KiB. Event storage stops accepting new entries
at 100,000 events or 128 MiB of event text. Existing transcripts are retained;
logging reports a warning when full, and Stop continues to work. These limits
cover session events, not token-usage accounting or the complete SQLite file.
There is no automatic deletion or retention policy.

BB controls access to plugin RPCs. Connected clients of the same BB installation
share session history and the configured plugin-command access. Session IDs and
call claims are routing data, not per-user access credentials. The host's plugin
RPC route checks browser origin and JSON content type. Voice Mode does not add
a separate multi-user permission system.

The sidebar options button is hidden by a content script scoped to BB 0.42 row
markup. Reloading or disabling the plugin removes that style. Check the selector
when upgrading BB. Physical mobile and native desktop audio validation remains
separate from browser and simulated-event tests.
