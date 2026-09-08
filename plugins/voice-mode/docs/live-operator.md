# Live operator, fast coordinator, strong workers

8 September 2026. These are three roles, not three mandatory inference hops.

## Routes

The live model receives `lookup_targets`, `read_thread`, `quick_action`,
`delegate_to_coordinator`, `remain_silent`, and `end_call`. `quick_action` admits
one resolved operation or a group of at most four operations per speech input:
native navigation/preview/drafts, queued instruction delivery, worker creation,
and explicit task stopping. No arbitrary tool name, shell string, workspace
deletion, archival, permission override, or implicit draft submission exists.

The coordinator uses `voice_actions` for the same semantic operations, with
an accepted request that belongs to its mapped conversation. Background update
batches cannot authorize actions. It can inspect briefly, ask one material
question, or dispatch a worker and release its turn. Do not wait for workers
synchronously. Native BB tools remain available under BB's policy; the typed
path is not a sandbox for the coordinator or its workers.

Worker roles (`investigate`, `plan`, `implement`, `review`) map server-side to
provider, model, supported reasoning effort, and service tier. Settings live
independently from the coordinator. Actual destination catalogs are validated;
unsupported models fail, never silently fall back. A missing profile uses that
provider's explicit default, not the coordinator model and not necessarily the
largest model. The settings UI supports per-machine catalog preview.

## Shared execution and durable state

`live-action-executor.ts` and `live-action-store.ts` implement both actors'
operator path. Group admission fixes the actor and complete arguments. Effect
identities are the request ID plus array position; the model cannot provide
fresh step IDs to repeat an effect. Calls for one request serialize. Each step
is persisted before its SDK call. Known repeated calls return receipts, including
after reload. Partial groups never resume remaining steps merely because a
receipt later arrives. Independent new speech remains a new request, not a retry.

An asynchronous preflight may look up threads, hosts, and models. Ownership and
cancellation are rechecked before committing. The 20-second budget limits waiting,
not the duration of a native operation already accepted by BB. A lost send/create
response is unknown, not failure-with-permission-to-retry. Late confirmed results
update the ledger and produce a separate notification; they do not start remaining
group steps. Hangup does not stop previously accepted work.

Worker creation is serialized around a quota reservation. Creating, active, and
unknown workers consume slots (default 8, configurable 1–64). A verified terminal
state without queued messages releases the slot. Unknown creations remain charged
and are never adopted by a matching title. `bb voice-mode workers --json` exposes
up to 200 recent mappings; `bb voice-mode actions --json` exposes recent compact
receipts. The original request and full instruction are retained in request/thread
history. Recent coordinator context omits large instruction payloads.

## Intent, targets, and messaging

The bridge captures the UI target context when speech begins, rather than when
transcription finally arrives. Viewed, discussed, and selected execution targets
are different concepts. All committed utterance fragments still require usable
transcripts; late recognition does not restart rejected work. The live tool may
supply reference interpretation, but not replace the original words with a rewrite.

Messages include original transcript/context, an optional matching excerpt,
separate interpretation, and application-generated request/step provenance. Real
implementation instructions go directly to the existing thread using
`queue-if-active`. A user comment or status query remains distinguished from an
implementation request. There is no English operation-word blacklist. This is
consequential delegation: the recipient can change state under its normal policy.
Voice delivery cannot grant additional permissions.

New threads are visible, unparented to the hidden coordinator, use the requested
project and an explicitly resolved connected machine, and select a managed
worktree/default base for standard projects (personal workspace for the personal
project). Multiple matching machines require selection. New workers use
`accept-edits`; investigate/review are scope instructions, not hard read-only
permissions. No arbitrary initialization script or model-selected permission
mode is accepted.

## Results and speech

The action service creates factual receipts naming destinations, material scope,
and actual status. Live fast actions skip an extra starting acknowledgment.
The bridge schedules a single result announcement; it never equates send/queue,
thread creation, or stop-request acceptance with task completion. Full details
remain available separately from short speech. Interrupted speech is not marked
heard. Native UI execution and claimed command ownership are unchanged.

Voice-created workers receive only `voice_worker_report` from this plugin. The
server checks their persisted thread mapping. A worker submits a short outcome
and verification limits, then ends its turn. At idle, structured reports enter
the coalesced inbox. All-structured report batches return directly through the
quiet speech scheduler, without starting a coordinator turn. Legacy/native
thread output and mixed batches use the coordinator for a digest. Reports are
claims/data, not new action authorization; no report path executes tools.

## Verification boundaries and upstream needs

Tests exercise both entry points, role selection, strict schemas, effect replay,
partial groups, lost receipts, late completion, cancellation, quotas, native UI
ownership, transcript recovery/context capture, worker settings, and quiet result
delivery. `npm run build:check` compiles the server and browser entries. This is
not a live BB install/reload or a measurement of speech latency.

SDK 0.4.47 does not expose standalone managed-worktree creation or a hard
read-only spawn mode, and plugin tool selection does not remove native agent
capabilities. Those require upstream BB support to enforce stronger isolation.
This implementation exposes managed worktree creation as part of thread spawn,
not a nonexistent standalone API. Model accuracy, multilingual intent handling,
microphone quality, phone backgrounding, and real interrupt latency still need
physical voice testing. No merge or installed-plugin reload is part of this change.


## Reliability integration — 8 September 2026

The live operator, fast coordinator, and worker profiles share the action ledger.
The integration also retains streaming conversation text, destination lookup by
recency, narrated UI/speech sequences, and immediate publication of validated
coordinator finals. A coordinator final ends its request; trailing output cannot
publish another final. If a coordinator ends without a reply after voice_actions,
stored action receipts supply the answer instead of an unrelated fallback.

The old voice_send tool is retired. Its historical receipt table remains readable
for recovery; it cannot initiate another send. Both published migration histories
retain their original statement indexes and gain the missing tables on upgrade.

Noise handling still needs the reviewed client utterance controller. The current
input path uses server VAD with automatic response/cancellation flags disabled;
WebRTC tests showed that those flags do not prevent raw VAD from clearing audio.
The five-second visible message merge is not an action-acceptance window. Neither
the input-controller replacement nor a new continuation delay is part of this
integration. The input bridge still binds by its existing turn/cursor logic.
