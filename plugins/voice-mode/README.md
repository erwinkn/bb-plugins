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
call immediately.

## Mobile views beside the call

On mobile, “show that thread” opens a drawer without leaving the voice call.
“Show all my running threads” keeps them in the drawer's thread switcher.
These are views inside one drawer, not separate native bb tabs. Closing a view
does not stop its thread or the call. To start a thread during a mobile call,
dictate its prompt. A request without a prompt asks for one and keeps the call
on screen.

Behavior → Mobile thread drawer controls whether a new thread replaces the
shown one or joins the switcher. “Always keep threads in the mobile drawer”
saves that preference; an explicit request can override it. The collection lasts
for the current app session. Supported destinations are the Voice page and
existing thread panels; unsupported mobile surfaces report the limitation.

Desktop `focus_thread` continues navigating to the requested thread from both
the composer and Voice page. Mobile settings do not change that behavior.
Per-entry-point desktop navigation/side-panel settings and native multi-tab
behavior are a [separate design](docs/desktop-navigation-plan.md).

See [the mobile design and device checklist](docs/thread-views.md) for SDK limits
and the shared session/plugin logging behavior.

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

Mobile calls additionally expose `focus_threads`, `manage_views`, and
`set_view_behavior` for the drawer. Desktop retains its navigation tool set.

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
