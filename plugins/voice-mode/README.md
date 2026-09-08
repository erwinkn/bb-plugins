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

When the call is active elsewhere, other devices show **Call on another device**
with **Switch here**. The switch checks local microphone access, disconnects the
previous device, and continues the same conversation. Only one device sends or
plays call audio at a time. Another window in the same browser is labelled
**Call in another window**. A failed microphone check leaves the original call
running; a connection failure after transfer requires reconnecting.

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
projects. Partial descriptions such as "the latest voice mode thread" are enough.
For navigation, Voice uses context and recency to choose the strongest match.
It asks only when equally plausible targets remain after lookup.

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

## Three tiers, without mandatory extra hops

The **live operator** handles bounded reads, native UI actions, unsent drafts,
real thread instructions, task stops, and creating new workers directly. The
**fast coordinator** handles brief checks, ambiguous targets, and cross-thread
coordination. **Workers** do investigation, planning, implementation, and review
using independently configured model profiles. Difficult work is not a reason
to route a clear dispatch through the coordinator first.

Examples:

| Say | Path |
| --- | --- |
| “Open Build Fix and ask it to add regression tests.” | Live resolves the target, opens it, and queues the instruction. |
| “Start a thread in BB Plugins to investigate the retry problem.” | Live creates a visible investigation worker in a managed worktree. |
| “Prepare a reply in that thread.” | Live edits an exact draft target, without submitting. |
| “Stop the build task.” | Live requests a stop; acceptance is not proof every process exited. |
| “Coordinate these three overlapping fixes.” | The fast coordinator checks briefly and delegates technical work. |
| “Delete the old worktree.” | No direct live deletion tool; this requires the consequential-operation workflow. |

Each live tool call may contain a group of up to four resolved actions.
Distinct tool calls can use the same complete spoken request. Effects have
durable request/step identities and an utterance/action identity, so another
tool call cannot repeat the same effect under a new request ID.
Replays return recorded receipts, never repeat effects or resume unexecuted
remaining steps after a partial/unknown outcome. New speech cancels pending
live actions, not previously accepted worker tasks. An SDK send already in
flight cannot be recalled. Late results are recorded and reported separately.

Thread messages are **real delegated instructions**, not a read-only boundary.
The original transcript, exact optional excerpt, reference interpretation, and
application provenance remain separate. The English operation-word blacklist
is removed. Sending an instruction does not escalate the receiving thread’s
permissions; normal BB approvals remain in effect.

Fast actions produce one concrete announcement, rather than an acknowledgment
plus a generic “sent”: “Queued for Build Fix: add regression tests.” Worker
creation names the task, project, machine, and role. Sent, queued, created,
stop-requested, and completed are different states. The bridge owns speech
scheduling and interrupted delivery. Internal RPC/model plumbing stays quiet;
user-relevant assignments do not.

Voice-created workers have a `voice_worker_report` tool. Structured reports
are held until the worker turn settles and the call is quiet, then delivered
without another coordinator turn. Other thread output and mixed update batches
still use the coordinator for a short digest. Worker reports are claims, not
permission to start follow-on work.

Input uses WebRTC with server voice detection disabled. The client waits for
recognised words supported by sustained microphone activity before it interrupts
speech. Noise energy alone cannot interrupt. Empty detections, punctuation, and
filler-only fragments stay quiet. Short words such as “stop,” “wait,” “yes,” and
“no” remain valid. The microphone stays disabled until the provider confirms
manual input control and the required transcription model.

One input controller owns the transcript items, commits, and utterances. It
commits after 800 ms without new words or microphone activity. Final transcripts
allow a response and simple navigation. Sending work, creating workers, task
stops, drafts, and coordinator requests wait for **two seconds after the last
final transcript**. Speaking during this window cancels unsent work and adds
the continuation to the complete request. An accepted send cannot be recalled.
Microphone or connection loss invalidates unsent work across recovery.

Every clause must have a final transcript before work can start. A final missing
for four seconds causes one request to repeat the full instruction. Late text
repairs the visible transcript but cannot restart work. Separate operations use
the same complete utterance; they do not consume its words. History from older
calls remains readable. The plugin stores no raw microphone audio.

User transcription and assistant output text stream in the Conversation view.
Final text replaces its draft by identity. Consecutive fragments can share a
visible message across pauses shorter than five seconds; this display rule is
separate from the two-second action window. Generated text is separate from
playback. The current or interrupted narration identifies its own thread, while
the last fully delivered answer remains separate context.

The activity thresholds and word recognition delay still need physical testing
with quiet speech, desk noise, speaker echo, and phone backgrounding. A real API
probe with the actual input controller passed interruption, automatic commit,
and full transcription. A separate three-minute silence probe also passed.

Live drafts use bounded, coalesced snapshots shared across devices, not a new
persistent event for every token. Reopening the page fetches the current draft;
finals and unfinished text retained at hangup come from durable session history.
Older calls and stale revisions cannot overwrite the active call's snapshot.
The view follows new text only when the user is already at the live end.

A validated final reply commits its request and becomes available for speech
immediately, without waiting for the coordinator's idle event. Existing user
speech and audio playback still take priority. A completed request cannot
produce another final answer from trailing coordinator text.

For a requested sequence of actions and explanations, the coordinator returns
`voice_sequence`: an ordered list of native UI actions and speech steps. Voice
runs the list as soon as the final plan is recorded. Each action waits for its native
receipt. Each speech step waits for audio playback to finish before the next
step starts. This supports tours, file reviews, comparisons, and other sequences;
it is not limited to thread tours. One-step navigation still uses the direct path.

Say "pause", "continue", "skip", "back", or "stop" to control a sequence.
Speaking pauses it so you can ask a question without losing the current step.
Skip moves to the next action and omits the explanation of a skipped action.
Back moves one step; it cannot cross a draft edit. A device switch or manual
navigation pauses the sequence. Resume restores preceding view actions before
repeating unfinished narration where those actions can safely run again.
A failed or unknown action pauses the sequence; its success narration does not
play. Draft edits are never submitted or repeated. Routine updates wait across
the whole sequence, including pauses. The cursor survives call transfer and
plugin reload. Destructive actions and arbitrary tool calls are not plan steps.

Live actions, `voice_actions`, `voice_ui`, and sequence actions share one UI command
path. Neither uses speech text to trigger navigation. The server records each command and binds it to the request and
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

New installations use GPT-5.4 mini with medium reasoning for the coordinator.
Saved provider, model, reasoning, and Fast selections remain unchanged.

- **Model & voice:** realtime model, voice, and credential source.
- **Behavior:** editable instructions for how Voice speaks and responds.
- **Coordinator:** provider, model, supported reasoning effort, and Fast when
  the provider supports it. These execution choices apply to new sessions.
- **Workers:** independent provider/model/reasoning/Fast profiles for investigation,
  planning, implementation, and review, plus a creation limit (default 8).
  The machine picker previews its catalog; execution validates the actual target.
  New profiles use the provider default until you select a model; they never
  inherit the coordinator model. Unsupported selections fail without substitution.
- **Audio:** microphone selection and a microphone test. Playback uses the
  system's selected output device.
- **Keyboard shortcuts:** start/stop and mute bindings.

The coordinator remains available and is warmed during call setup, but direct
actions do not require a coordinator turn or a working coordinator provider.
Choose a fast coordinator separately from larger worker models. Existing
coordinator settings and user-saved instructions are retained.

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
npm run build:check
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
bb voice-mode actions --json
bb voice-mode workers --json
bb voice-mode read thr_example
bb voice-mode usage
bb voice-mode stop
```

## Data and verification limits

The plugin retains existing recorded events and database migration history.
Historical call records remain readable; they do not enable an old execution
mode. The app-wide call controller survives route changes within its runtime.
A live WebRTC connection cannot transfer between browser windows or devices.

Automated tests cover direct instruction delivery, worker role selection,
creation limits, duplicate and partial groups, cancellation/late outcomes,
speech-time target snapshots, worker settings, report routing, coordinator delivery, native UI command ownership,
context changes, draft targeting, speech scheduling, and session history.
Browser checks cover the BB controls and responsive layout. Physical desktop
and phone calls still need microphone, interruption, playback, backgrounding,
and keyboard tests. Passing a browser test does not establish those results.

New workers use BB’s `accept-edits` mode. Investigation/review scope is an
instruction, **not an enforced read-only sandbox**. SDK plugin tool selection
does not remove native tools from a coding agent. This plugin does not claim
that the coordinator or workers cannot bypass a typed operation through their
native capabilities. The live surface itself has no shell, archive, delete,
permission-grant, or composer-submit tool.

Worktree creation uses `threads.spawn` with a managed worktree and default base
branch. SDK 0.4.47 has no standalone environment/worktree creation method, so
this change does not expose an unimplemented standalone creation tool. Unknown
worker creation consumes its quota slot and is not automatically retried or
adopted by title. Inspect diagnostics; a fresh user request is a separate action,
not a safe retry. Test actual hardware calls and model behavior before relying
on the new paths for consequential work.

See [the operator architecture](docs/live-operator.md) for contracts and limits.

Current BB boundaries and desired upstream improvements are recorded in the
[repository README](../../README.md#desired-upstream-changes).
