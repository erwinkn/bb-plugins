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

Spoken names are approximate. Searches rank threads and projects with a match score,
accept word stems and small mishearings, and always list the projects. When one
search does not settle what you meant, Aide starts a worker to look instead of asking
for exact names or IDs. Workers run outside any project unless the task needs a
repository; they can read every BB project and thread. A worker uses the default
profile unless Aide picks one of the configured names.

Calls wait for preceding speech to finish playing. Effects also wait two seconds
after the final user text, so a correction can cancel work before dispatch. Unknown
results are not retried automatically. Drafts append by default and never submit.
A worker's turn ending is reported separately from whether its task is complete.

Background updates wait for a quiet boundary and cannot navigate or act. Watches
are automatic when work is sent or started. Unsubscribing mutes updates without
stopping the work; a later send does not re-enable a disabled watch.

## Settings and history

Settings let you add, rename, and edit named worker profiles. Each profile has a
provider, model, reasoning level, Fast option, permission mode, and instructions. Choose a default
profile and a worker cap. Saving checks every profile on the selected machine;
launch checks the actual destination again.

The Live prompt and Worker prompt editors show their full defaults and saved
versions. Previous live and coordinator prompts remain read-only under Previous
prompts. The new live prompt uses the separate `aide` role, so rollback still reads
the old `live` rows. Existing v1 worker settings convert to v2 once; the old value
stays in place.

Each Voice session is a conversation across calls. Conversation shows what was
said. Tasks shows workers, created threads, their latest text, and active or muted
subscriptions. Open a task row to view its thread. Diagnostics shows session events.
Sessions that used a coordinator also have Coordinator history, a read-only timeline.

See [the architecture](docs/architecture.md) and [the RPC contract](live-runtime-notes.md).
Earlier design documents are in [docs/history](docs/history).

## Check changes

Run `npm run typecheck`, `npm test`, and `npm run build:check` in this directory.
The build check compiles both entry points without installing or reloading BB.
