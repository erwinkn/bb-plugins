# Voice Mode

Talk to BB while it works. Ada answers questions, reads thread results, sends
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

## Work with Ada

Ada uses one live model and seventeen tools. It can find, read, and rename threads, deliver
messages, create visible threads or hidden workers, prepare unsent drafts, navigate,
stop work, manage subscriptions, prepare and confirm archives, and answer native
questions or approvals. Archive and approval actions require a later spoken
confirmation after their explanation has drained.

Spoken names are approximate. Searches rank threads and projects with a match score,
accept word stems and small mishearings, and always list the projects. When one
search does not settle what you meant, Ada starts a worker to look instead of asking
for exact names or IDs. Workers run outside any project unless the task needs a
repository; they can read every BB project and thread. A worker uses the default
profile unless Ada picks one of the configured names.

Name a provider, model, or reasoning level when you ask for new work and Ada uses
it, then confirms the model it resolved; ask "what models are there" for the list.
Say "in the main folder" or "alongside that thread" to choose where the work runs;
otherwise it gets a new worktree. Ask for a thread's environment to hear its folder,
branch, and pull request.

Ask what is waiting on a thread to hear its queued messages. Then say "send it now"
to steer one into the active turn, "cancel that message" to delete it, or "change
that message to" followed by the new text.

You can say "agent" instead of "thread". An agent is a root thread, and a sub-agent
is a child thread of that root. Ada applies this mapping when it resolves what you
said and answers with the word you used. Thread targeting inside the runtime does not
change.

Calls wait for preceding speech to finish playing. Effects also wait two seconds
after the final user text, so a correction can cancel work before dispatch. Unknown
results are not retried automatically. Drafts append by default and never submit.
A worker's turn ending is reported separately from whether its task is complete.

Background updates wait for a quiet boundary and cannot navigate or act. Every
thread Ada messages, starts, or stops reports back in the call when it finishes,
fails, or asks a question, also after a reconnect. A send result is the receipt:
sent and queued are both final delivery, and Ada says it will keep you informed
rather than asking you to check later. Unsubscribing mutes updates without
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
