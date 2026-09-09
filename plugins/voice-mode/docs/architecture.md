# Aide live runtime

One Realtime model speaks and calls fourteen tools. Hidden root threads run
background tasks. No model coordinates those threads. Stored subscriptions,
receipts, native BB events, and the client sequencer supply the control flow.

`voice-agent.ts` owns the call, microphone, WebRTC events, and output sequencing.
It fetches `callStartContext` before enabling the microphone and injects one system
item. During the call it injects only tool results and `background_updates` batches.
`input-controller.ts` keeps word-checked interruption and the correction window.

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

The prompt roles are `live`, `worker`, and historical `coordinator`. The approved
live default activates once, with earlier edits retained in prompt history.
Later user edits remain active. Worker launches use the current worker prompt.
Named worker profiles use `voice.worker-profiles.v2`; absent that key, the runtime
adapts the old role settings in memory. The future Tasks and profiles UI should
use `listLiveTasks` and `listLiveSubscriptions` with `{nonce, conversationId}`.

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
