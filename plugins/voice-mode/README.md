# Voice Mode

Talk to BB while it works. Aide answers questions, reads thread results, sends
instructions, starts background work, and controls BB's native workspace.

Based on [bb-handsfree](https://github.com/swairshah/bb-handsfree) by swairshah,
originally copied at commit `79d5083`.

## Use Voice

Open **Voice** in BB's sidebar. Start a new session or continue an earlier one,
allow microphone access, and speak. The call controls remain available on other
pages. **Switch here** transfers a call after checking the new device's microphone.
Only the device that owns the call executes its tools.

The default shortcuts are Cmd+Shift+H to start or stop, and Cmd+Shift+U to mute.
Windows and Linux use Ctrl. Change them in Voice Mode's Keyboard shortcuts settings.

## Work with Aide

Aide uses one live model and fourteen tools. It can find and read threads, deliver
messages, create visible threads or hidden workers, prepare unsent drafts, navigate,
stop work, manage subscriptions, prepare and confirm archives, and answer native
questions or approvals. Archive and approval actions require a later spoken
confirmation after their explanation has drained.

Calls wait for preceding speech to finish playing. Effects also wait two seconds
after the final user text, so a correction can cancel work before dispatch. Unknown
results are not retried automatically. Drafts append by default and never submit.
A worker's turn ending is reported separately from whether its task is complete.

Background updates wait for a quiet boundary and cannot navigate or act. Watches
are automatic when work is sent or started. Unsubscribing mutes updates without
stopping the work; a later send does not re-enable a disabled watch.

## Settings and history

Settings expose the live and worker prompts. Prompt edits retain version history.
The existing worker settings remain available while the Tasks and named-profile
editor are developed. Runtime profiles use `voice.worker-profiles.v2` and fall back
to the earlier settings when that key is absent.

Each Voice session is a logical conversation across calls. The default view shows
what was said. Diagnostics remain available. Sessions that used a coordinator can
show its read-only timeline; new sessions have no coordinator view or runtime.

See [the architecture](docs/architecture.md) and [the RPC contract](live-runtime-notes.md).
Earlier design documents are in [docs/history](docs/history).

## Check changes

Run `npm run typecheck`, `npm test`, and `npm run build:check` in this directory.
The build check compiles both entry points without installing or reloading BB.
