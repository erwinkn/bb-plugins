# Voice controls the BB workspace

The native UI mechanics below are retained. The live/coordinator responsibility
split is updated by [the three-tier operator architecture](live-operator.md).

Voice is one conversation that continues as the user moves through BB. The
Voice page contains session history, the conversation, and optional debugging
views. BB owns work-thread pages, project navigation, splits, drafts, and file
previews. Voice does not maintain a second collection of work-thread views.

## Responsibilities

- The realtime model listens, invokes bounded operator tools, and speaks actual
  action receipts. It does not invent UI capabilities or execution outcomes.
- The coordinator handles brief checks and coordination, using the same operator
  executor. Substantive work goes to independently configured strong workers.
  Routine thread instructions queue; explicit task stops use a separate operation.
- The server validates coordinator calls and records request and UI-command
  delivery. UI commands belong to an explicit request and its physical call.
- The client that owns the call applies structured commands through native BB
  SDK controls. Other windows may show call status but do not apply UI commands.
- Native BB components own composer drafts, permission handling, thread layout,
  and preview rendering. A nonvisual composer binding supplies the actual scope
  without adding a Voice button to every thread.

## UI actions

| Action | Result |
| --- | --- |
| `open_thread` | Open an existing thread, optionally with BB's split placement. |
| `open_project` | Open a project in BB. |
| `prepare_draft` | Prepare text for an explicit thread or new-thread composer. |
| `preview_file` | Open a file using its complete workspace, host, or thread-storage target. |
| `show_voice` | Return to the Voice conversation. |

The coordinator uses `voice_ui` and waits for its result before describing the
outcome through `voice_reply`. A speech reply carries no navigation instruction.
A background update cannot issue UI commands. New work does not automatically
navigate the user away from what they are viewing.

Users name threads, projects, or files in speech. BB lookup happens internally;
the user need not paste an ID, URL, or search manually. Ask one spoken question
when more than one plausible target remains.

## Command lifecycle

Each command has a unique ID, request ID, conversation ID, and physical call
nonce. The server records it before publication. The owning client claims it
before invoking the SDK and reports the result afterward. Duplicate signals
must not repeat an action. A command from an ended or replaced call cannot
operate on a later call.

A started action with an unknown outcome is reported as unknown; it is not
replayed automatically. This is especially important for composer drafts. The
client serializes UI actions and rechecks ownership around asynchronous work.
Changing the route must not unmount the call owner or its command receiver.

Preparing a draft does not submit it. Appending is the default. Replacing text
requires an explicit replacement command. The target must match the current
composer's actual scope; an inline queued-message editor or unrelated side chat
must not receive the text. If the user navigates away during preparation, cancel
rather than repeatedly pulling the UI back to the target.

The SDK's acceptance result is not proof of visual rendering. Thread and project
navigation should use observable context where available. A preview accepted by
BB is reported as accepted; it must not claim that a file rendered successfully
unless that was observed. Split placement follows BB's rules, including compact
viewport fallback and the pane cap. File preview uses the active page or
composer surface capability; the global app overlay has no preview handler in
BB 0.42.1. A page without that capability reports it as unavailable.

## Speech and continuity

Requests preserve the user's material wording. The voice acknowledgment is
owned by one layer. Work runs quietly; only a material blocker or useful result
adds speech. Parent threads lead spoken work overviews, with child work grouped
under the parent. Internal routing and coordinator receipts stay in diagnostics.

Microphone input, response generation, tools, and playback take precedence over
watched-thread digests. The server coalesces background state changes; a digest
waits until the full idle gate is clear. An interrupted digest returns to the
inbox. Existing question and request recovery remain part of the architecture.

A logical conversation can span several calls. Call ownership is physical and
cannot transfer a live WebRTC connection between windows. Session data survives
reload; the live call itself does not. Native mobile backgrounding remains a
platform boundary and needs physical testing.

## Data and removal policy

Delete executable fallback modes, obsolete settings, duplicate work-thread
navigation, and tests that only preserve those removed modes. Keep readers for
recorded events and append-only database migrations needed to open existing
sessions. These preserve user data and are not alternative runtime modes.

Do not rewrite saved user instructions or historical transcripts during the
change. Document any new database migrations and verify existing event rows
remain unchanged after reload.

## Verification

- A spoken request can open another project's thread using native navigation.
- Only the call owner acts, even with another BB window open.
- Duplicate delivery, reconnect, timeout, and failed receipt reporting do not
  repeat effects. Old calls, completed requests, and background batches cannot
  navigate or edit drafts.
- Thread/project navigation, split fallback, file preview, and return to Voice
  preserve the local call and its conversation identity.
- Draft preparation waits for its target, preserves existing text by default,
  does not send, and cancels after user navigation or hangup.
- Call controls stay usable at narrow phone widths and with the keyboard open.
- Existing questions, interrupted speech, watched updates, and session history
  retain their regression coverage.
- Browser tests verify host integration; physical desktop/mobile calls verify
  microphone and playback continuity. Report these separately.
