# Voice Mode

Talk to BB while it works. Ada answers questions, reads thread results, sends
instructions, starts background work, and controls BB's native workspace.

Based on [bb-handsfree](https://github.com/swairshah/bb-handsfree) by swairshah,
originally copied at commit `79d5083`.

## Use Voice

Open **Voice** in BB's sidebar. Start a new session or continue an earlier one,
allow microphone access, and speak. The call controls remain available on other
pages. **Switch here** transfers a call after checking the new device's microphone.
Only the device that owns the call executes its tools. Switching devices keeps Ada
silent and preserves mute. Resuming an ended session still gives a spoken status.

After a connection loss, Voice shows **Reconnecting**. It allows ten seconds for
the existing connection to recover, then retries with a new connection for up to
one minute. A failed connection or closed event channel starts those retries
immediately. Recovery keeps the conversation and mute state, without a greeting
or repeating prior actions. Stop or a transfer to another device cancels recovery.
If the network stays unavailable, resume the session when it returns.

A new connection restores up to 100 saved turns and 32,000 characters of recent
transcript, plus recent action statuses and pending work. Shorter conversations
keep their full saved transcript. Longer ones keep the newest text and report
that earlier history was omitted. This is an interim text restoration; full
Realtime context continuity and compaction remain separate work.

The default shortcuts are Cmd+Shift+H to start or stop, and Cmd+Shift+U to mute.
Windows and Linux use Ctrl. Change them in Voice Mode's Keyboard shortcuts settings.

## Work with Ada

Ada uses one live model and eighteen tools. It can find, read, and rename threads, deliver
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

Say "rename that thread" or "use Astra with high reasoning on that thread" to
update its title or execution. `update_thread` accepts `thread_id`, optional
`title`, `model`, and `reasoning`; `provider` can assert the existing provider.
Model and reasoning changes apply on the next turn. They require a ready
environment and a model from the thread's existing provider. An unsupported
model or reasoning level fails before any title change. Changing only the title
does not require model discovery. `rename_thread` remains available for existing calls.

Say "hand this off to a new thread using Opus" to use `create_thread` with
`handoff_from_thread_id`, `title`, and `body`. Project and machine default to the
source; if supplied, they must match it. Omit `workspace` and `reuse_thread_id`.
The new visible root thread shares the source environment, including uncommitted
files. It inherits the source provider/model/reasoning unless overridden, and
can choose another provider. Its permission mode cannot exceed either the source
or the configured profile. The source keeps running; a handoff does not stop it.

Handoffs copy recent root user/assistant messages as agent-only context, capped
at 40 request/completed-item events, 4,000 characters per message, and 12,000
characters total. Tool payloads, reasoning, child-agent output, agent-only input,
system requests, and attachments are omitted.
Optional `handoff_context` adds up to 8,000 characters of older decisions or
constraints. The receipt records `handoff.sourceThreadId`, the snapshot's
`sourceSeqEnd`, message count, and truncation; `read_threads` also returns this
relationship after reconnects. This is a text snapshot, not a full provider
session clone. BB 0.42.1 has no native handoff origin, so the relationship is
stored in Voice's operation history rather than BB's native source-thread field.

Ask what is waiting on a thread to hear its queued messages. Then say "send it now"
to steer one into the active turn, "cancel that message" to delete it, or "change
that message to" followed by the new text.

With the Threads plugin's spaces, say "switch to the mobile space" or "show all
projects" to change the sidebar scope on the device that owns the call. Ada names
the space it applied, or lists the saved spaces when the name did not match.
Creating or editing spaces stays on the Threads page.

You can say "agent" instead of "thread". An agent is a root thread, and a sub-agent
is a child thread of that root. Ada applies this mapping when it resolves what you
said and answers with the word you used. Thread targeting inside the runtime does not
change.

Calls wait for preceding speech to finish playing. Effects also wait two seconds
after the final user text, so a correction can cancel work before dispatch. Unknown
results are not retried automatically. Drafts append by default and never submit.
A worker's turn ending is reported separately from whether its task is complete.

Ada reads a pending question with its options and answers it from what you say:
"the second one", the option's words, or free text. Questions from the Questions
plugin work the same way, one round at a time. A word that matches no option is
refused with the options, so nothing is answered by guess. Prompts from other plugins
must be answered in the app.

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

**Permission defaults.** Voice Mode does not add a plugin-wide permission
default. New visible threads and workers whose profile says **Use project/BB
default** omit `permissionMode` from `threads.spawn`; BB applies the destination
project's configured default, or its product fallback when the project has none.

A voice `create_thread` or `spawn_worker` call can explicitly override this with
`permission_mode`. `full` requires `permission_confirmed: true` after the user
explicitly authorizes that one launch, because it bypasses BB's sandbox and
approval protections. Existing saved profile modes remain explicit and continue
to override the project default; nothing is automatically migrated. BB still
enforces the destination machine and provider limits, which can clamp or refuse
a requested mode.

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

## Check changes

Run `npm run typecheck`, `npm test`, and `npm run build:check` in this directory.
The build check compiles both entry points without installing or reloading BB.
