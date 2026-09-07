# Voice Mode

Talk to BB while it works. Voice answers questions, sends instructions to work
threads, reports useful results, and controls BB's native workspace on request.
The conversation continues as you open threads, projects, splits, and files.

Based on [bb-handsfree](https://github.com/swairshah/bb-handsfree) by swairshah,
originally copied at commit `79d5083`.

## Start a call

1. Open **Voice** in BB's sidebar.
2. Start a new session, or select an existing session and choose **Continue**.
3. Allow microphone access and speak.

The call controls stay available when you leave the Voice page. Mute and end
call also work by voice. The command palette provides start/stop and mute
commands. The default keyboard shortcuts are Cmd+Shift+H for start/stop and
Cmd+Shift+U for mute; Windows/Linux use Ctrl instead of Cmd. Change these under
Settings → Plugins → Voice Mode → Keyboard shortcuts.

A voice session is one logical conversation with its own hidden coordinator.
Continue reuses that conversation across calls. New session starts another.
The Voice page opens the conversation by default. Its view picker also offers
Coordinator and Diagnostics for debugging. Work-thread pages remain native BB
pages; there is no separate thread workspace inside Voice.

## Control BB by voice

| Say | Voice does |
| --- | --- |
| “What are we working on?” | Summarizes parent workstreams, grouping child work beneath them. |
| “Show the build thread.” | Resolves the name and opens that thread in BB. |
| “Put that thread beside this one.” | Requests BB's native split placement. |
| “Open the website project.” | Opens the project. |
| “Prepare a reply for the build thread.” | Writes a draft in that thread without sending it. |
| “Show the file we changed.” | Resolves the file and opens BB's preview. |
| “Back to our conversation.” | Returns to Voice. |
| “Ask the build thread to add error tests.” | Queues that follow-up for the thread. |
| “Stop that change now; it is the wrong target.” | Interrupts the work when the request calls for it. |

You do not need to paste IDs or links, search manually, or start Voice in the
thread you want to control. Voice resolves spoken names and context across
projects. It asks a short question when the target is ambiguous.

Opening a view is separate from changing work. A thread update does not move
your screen. Starting work does not open its thread unless you ask to see it.
Draft preparation appends by default; replacement requires a replacement
request. Drafts are not submitted automatically by the UI command.

BB decides split placement and may use normal navigation on compact screens or
when splits are disabled. File previews use BB's supported target types, with
an explicit environment, host, or thread-storage location. Acceptance of a
preview request does not prove that its contents rendered successfully. Preview
requires a page with a native BB preview handler; Voice reports when the current
page cannot open one.

## One assistant, one request lifecycle

Voice gives one short acknowledgment, works quietly, and reports useful results
or a material blocker. It does not narrate internal dispatch or coordinator
activity. The realtime model handles conversation and speech; the coordinator
resolves intent and works through BB's native tools. There is no direct realtime
mutation path or fallback mode.

Empty or failed transcripts cannot start work. Voice cancels the affected
realtime response and asks once for the missed sentence. Requests wait up to
four seconds for transcription; a late transcript is retained but does not
restart rejected work. The conversation marks speech with no usable transcript,
and Diagnostics records per-item results, timing, and provider error details.
The plugin does not record raw microphone audio.

The coordinator requests UI actions through `voice_ui`, separately from
`voice_reply`. The server records each command and binds it to the request and
physical call. Only the client running that call applies it. Other BB windows
can show call status without changing their own workspace. Commands are claimed
before execution, so repeated delivery cannot repeat a draft edit or navigation.
An ambiguous outcome is reported as unknown, rather than retried automatically.

Watched-thread updates wait until you finish speaking and Voice finishes its
answer. The idle check includes response generation, tool work, and playback.
Updates are coalesced per thread. An interrupted digest returns to the inbox.
Pending questions survive hangup and resume; an unrelated “yes” does not answer
an earlier question.

See [architecture and verification](docs/native-workspace.md) for the command
boundaries, ownership rules, and failure cases.

## Settings

- **Model & voice:** realtime model, voice, and credential source.
- **Behavior:** editable instructions for how Voice speaks and responds.
- **Coordinator:** provider, model, supported reasoning effort, and Fast when
  the provider supports it. These execution choices apply to new sessions.
- **Audio:** microphone selection and a microphone test. Playback uses the
  system's selected output device.
- **Keyboard shortcuts:** start/stop and mute bindings.

The coordinator is required. There are no coordinator enable/machine,
Announcements, plugin-exposure, or thread-opening preference controls.

Saved instructions apply to the next realtime call and the next coordinator
request. They customize behavior within the request and delivery rules. Saving
instructions does not rewrite earlier sessions or change ongoing work.

## Install and develop

The plugin requires BB with Plugin SDK 0.4.47 or later. From this repository:

```sh
cd plugins/voice-mode
npm ci --include=dev
bb plugin build .
bb plugin install . --yes
```

Choose an available credential source in settings. The plugin supports an
OpenAI API key, the server's `OPENAI_API_KEY`, or available ChatGPT subscription
credentials. Credentials stay on the server. Microphone audio goes to OpenAI
through WebRTC; this plugin stores transcripts and events, not audio recordings.

```sh
npm run typecheck
npm test
bb plugin build .
bb plugin reload voice-mode
```

Reload ends the current frontend generation and its live call. End the call
before reloading. Session history and saved settings remain available afterward.

For diagnosis:

```sh
bb plugin list --json
bb plugin logs voice-mode -f
bb voice-mode live --json
bb voice-mode read thr_example
bb voice-mode usage
bb voice-mode stop
```

## Data and verification limits

The plugin retains existing recorded events and database migration history.
Historical call records remain readable; they do not enable an old execution
mode. The app-wide call controller survives route changes within its runtime.
A live WebRTC connection cannot transfer between browser windows or devices.

Automated tests cover coordinator delivery, native UI command ownership,
context changes, draft targeting, speech scheduling, and session history.
Browser checks cover the BB controls and responsive layout. Physical desktop
and phone calls still need microphone, interruption, playback, backgrounding,
and keyboard tests. Passing a browser test does not establish those results.

Current BB boundaries and desired upstream improvements are recorded in the
[repository README](../../README.md#desired-upstream-changes).
