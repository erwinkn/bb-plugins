# Ada live runtime

One Realtime model speaks and calls eighteen tools. Hidden root threads run
background tasks. No model coordinates those threads. Stored subscriptions,
receipts, native BB events, and the client sequencer supply the control flow.

`voice-agent.ts` owns the call, microphone, WebRTC events, and output sequencing.
It fetches `callStartContext` before enabling the microphone and injects one system
item. During the call it injects only tool results and `background_updates` batches.
`input-controller.ts` keeps word-checked interruption and the correction window.
A commit needs two signals: meter energy from the local AudioContext and
transcription deltas from the server. While live, `input.health` is logged every
thirty seconds with samples, peak level, deltas, unconfirmed items, and the meter
and connection state; `input.deltaUnsupported` is logged once per item when words
arrive with no meter energy; `meter.suspended` and `meter.resumed` record the
AudioContext state, and a suspended context is resumed. These only describe.

When the phone screen locks, iOS mutes the microphone track while the page is
hidden. The agent holds the call instead of hanging up: it marks the microphone
suspended, keeps the WebRTC connection, and revives the microphone when the track
unmutes or the page returns to the foreground. A deadline ends a held call only if
the microphone never comes back. A screen wake lock, re-requested on each return
to the foreground, keeps the phone awake during a call.

`output-sequencer.ts` holds calls until their response drains naturally. A response
without audio releases calls at generation completion. Calls run one at a time.
Interrupted responses close held calls without requesting a continuation. A failed
or unknown operation cancels the remaining calls in that response.

`live-client.ts` freezes the utterance and origin for every call. Server effects
wait two seconds after final text; drafts and navigation wait for final text.
Utterance IDs are unique across calls, while their versions retain the input
controller's correction behavior. Reads retain their data after interruption. An occurrence number identifies
repeated operations with identical arguments and stays fixed on a call retry.
Client effects use `beginClientEffect`, the validated native action, and
`finishClientEffect`. The nonce is checked again before the device acts.

`live-runtime.ts`, `operations.ts`, `watches.ts`, and `live-store.ts` own operation
receipts, workers, watches, inbox items, offers, and spoken-confirmation checks.
`target-matching.ts` scores spoken descriptions against names: tokens split on any
separator, category words are neutral, stems and small edit distances count, and
`find_targets` returns ranked candidates with scores instead of an exact filter.
The live prompt maps the spoken word "agent" to a root thread and "sub-agent" to a
child thread; the tools and the runtime keep their thread targeting unchanged.
Spoken `provider`, `model`, and `reasoning` on `create_thread` and `spawn_worker`
resolve against `providers.list` and `providers.models` with the same tolerant
matching; a model name alone can pick its provider, and an unresolved name fails
with the choices. `workspace` maps to the SDK environment: a managed worktree from
the default branch, the unmanaged main folder, or `reuse` of a seen thread's
environment. `list_models` reads the catalog; `read_threads` with `environment`
returns path, branch, base branch, kind, and pull request.
`permission_mode` is an explicit per-launch override. The normal resolution is
caller override, then a named worker profile's explicit mode, then BB's
destination-project default. Fresh profiles inherit BB by omitting
`permissionMode` from `threads.spawn`; BB uses its product fallback when the
project has no configured default. A `full` per-launch override is rejected
unless `permission_confirmed` is true after an explicit user authorization; full
access bypasses sandbox and approval controls. Existing saved profiles remain
explicit; new inheritance does not migrate their stored permission modes.

`update_thread` validates the entire patch in `thread-management.ts` before one
`threads.update` call. It resolves model names only within the existing provider's
environment catalog, rejects routed models from other providers, and validates
reasoning against the selected model. Model-only edits clear an unsupported
sticky reasoning override. Receipts say execution changes apply on the next
turn; the current turn continues. Rename-only skips execution discovery, and
the earlier `rename_thread` tool uses the same implementation.

`create_thread.handoff_from_thread_id` requires a remembered source with a ready
environment. It derives project, host, and execution from that source, keeps the
lower of source/explicit-profile permissions unless a per-launch permission
override was explicitly requested, and validates the target catalog in the
source environment. The new root gets agent-only recent conversation context
and its separate visible prompt through `threads.spawn.input`. Source provenance
and truncation metadata are saved in the operation receipt before dispatch and
remain attached after acceptance, recovery, and later messages. No migration is
needed: `receipt_json` stores the typed `ThreadHandoff` record. Source history is
bounded, and concurrent source work can continue after the snapshot. BB's native
fork API cannot provide a provider-independent handoff relationship; Voice owns
that metadata until an upstream handoff API exists.
`queued_messages` reads a thread's queue through `queuedMessages.list` and remembers
each ID; `send_now` (steer), `delete`, and `edit` (optimistic `expectedUpdatedAt`)
are effects on a remembered ID. When the item came from this conversation, the
matching operation moves to running, cancelled, or a new body.
`interaction-answers.ts` describes a pending interaction in spoken form (prompt,
options, single or multiple, free text, optional) and resolves spoken labels or
ordinals to option values before any SDK call. Provider questions resolve with a
`user_answer` resolution; Questions-plugin rounds are read and answered through
`bb.sdk.plugins.callRpc` with one draft per question and one submit. Watches describe
interactions before the transaction so rounds reach the inbox with their questions.
`spaces-bridge.ts` switches the Threads sidebar of the erwin-activity plugin:
it reads that plugin's cached space catalog and client state from local storage,
resolves a spoken name with the same ranked matching, writes `spaceId` the way the
plugin does, and dispatches the plugin's same-window state event so its store
re-reads. The library scope is a fixed `spaceId` sentinel (`LIBRARY_SCOPE_ID`),
resolved from "the library" and its synonyms before space names. `control_ui`
`switch_space` is a client effect; nothing is fetched, and a name that does not
resolve changes nothing. A test pins the keys, the event name, and the sentinel
to the activity plugin's exports.
Workers default to BB's personal project and the primary machine; `server.ts` builds
the call's tool schemas from the configured profiles so the model sees valid names.
`machines.ts` reads `bb.sdk.system.config().primaryHostId` for deterministic
default routing. `list_machines` returns current machine names, connection status,
and the default host; `spawn_worker.host_id` optionally selects another machine.
The worker's provider and model are validated on that destination. An unavailable
default or explicit host fails instead of silently moving work elsewhere.
Call-start context includes the machine inventory and a bounded client-reported
device descriptor. Its `hostId` is explicitly null: the SDK cannot map the call
owner's browser to a host. The live prompt directs device computer-use requests
to hidden Codex workers on the machine the user identifies.
The runtime keeps call state in memory but persists the owner record and every
target ID shown to the model in `voice_call_targets`. When the owner still matches
and the in-memory state is missing, as after a plugin reload mid-call, the runtime
rebuilds the state from the store instead of refusing every tool.
Background responses cannot authorize effects. Historical agent thread IDs are
readable but cannot receive new effects through the runtime.

At two seconds of quiet, with no speech, generation, held tool, or undrained audio,
the client requests `nextUpdateBatch`. It reports natural drains before closing
a delivered offer. Clear, no audio, and hangup close an offer as not delivered.
`remain_silent` defers or dismisses the offer. `finishUserExchange` runs once at
the exchange boundary; a quiet timer cannot trigger it.

`conversation-record.ts` owns current conversation and call records. The retired
store under `coordinator/` reads historical rows only. Historical thread views use
BB's timeline presentation without a composer. The old executors, registrations,
schedulers, event handlers, and write RPCs are removed.

The editable prompt roles are `aide` and `worker`. The UI labels `aide` as Live
prompt. With no saved row, it reads the approved default directly. Earlier `live`
and `coordinator` rows remain read-only history. New calls never read or write
`live`, which preserves that role for rollback. Worker launches use the saved
worker prompt. Both editors show defaults and version history.

Named worker profiles use `voice.worker-profiles.v2`. Startup converts an existing
v1 value once and keeps the original. A fresh installation reads defaults without
writing either key and gives its profiles the `inherit` permission choice. Stored
v2 profiles that omit the field still read as `accept-edits`, preserving the
previous release's behavior. The profile editor validates names, the default
selection, and provider capabilities on the selected machine before saving the
full draft.

The Tasks view uses `listLiveTasks` and `listLiveSubscriptions` with the active
nonce and conversation ID. Ended sessions read stored work through `getVoiceSession`.
This history read does not claim a call or change subscriptions. The view refreshes
on session events and every ten seconds while visible. Task rows use the native
open action when clicked. Historical coordinator timelines have no composer.

`legacy-migrations.ts` retains shipped statements. Tests compare both deployed
orders against the literal snapshots captured before this removal. The old tables
and session records remain in place.

Verification uses fake WebRTC, SDK, database, and UI tests plus both entry point
build checks. No physical audio, live call, installation, or reload is part of this
cutover. Earlier design documents are retained in `history/`.

## Rollback

The old build cannot see tasks created by the new runtime. Their threads remain
in BB; `bb thread list --include-hidden` shows them. The startup import preserves
legacy worker and watch records in the new runtime, but it does not copy new tasks
back to the old tables.
