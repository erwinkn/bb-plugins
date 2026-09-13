# Ada server runtime, step 2

The live client now uses the seventeen tools and the durable runtime. The retired
coordinator is available only through historical session data. See
[the current architecture](docs/architecture.md) for the complete client flow.

## Client contract

All RPCs require the current call nonce. Fetch `callStartContext` before using the
runtime. `conversationId` must match the conversation linked to that nonce.

`ToolInput` is `{nonce, conversationId, utterance: {id, version, text, startedAt} | null,
responseOrigin: "user" | "background", tool, args, occurrence?: number}`. Times are
Unix epoch milliseconds. The sequencer assigns occurrence, starting at zero, and
retains it on retries. It is not a model tool argument.

| RPC | Input | Output |
| --- | --- | --- |
| `runTool` | `ToolInput` | Read data or `{operationId, status, asOf, ...receipt}`. Refusals have `{status:"failed", error, asOf}`. `find_targets` returns ranked `threads` and every project with a `match` score from 0 to 1, `foundInMessages` on BB search hits, `createdAt`, and `searched.words`; `parent_id` lists one thread's children by creation time. |
| `beginClientEffect` | `ToolInput` for `prepare_draft` or `control_ui` | `{execute, operationId, receipt, action}` |
| `finishClientEffect` | `{nonce, operationId, status, result}` | Stored receipt. Status is `succeeded`, `failed`, `cancelled`, or `unknown`. |
| `nextUpdateBatch` | `{nonce}` | `{offerId, items, asOf}` or `null`. Up to three roots; each item can include child results and `offered_before`. |
| `closeOffer` | `{nonce, offerId, outcome, responseId?}` | `{closed}`. Outcome is `delivered`, `not_delivered`, `deferred`, or `dismissed`. |
| `reportDrain` | `{nonce, responseId, at}` | `{ok:true}` |
| `finishUserExchange` | `{nonce, utteranceId}` | `{ok:true}` |
| `callStartContext` | `{nonce, conversationId, view?:{threadId?, projectId?}}` | `{type:"call_start_context", view, tasks, pendingInteractions, pendingUpdates, recentTurns, asOf, truncated}` |
| `listLiveSubscriptions` | `{nonce, conversationId}` | `{items, asOf}` with watch rows |
| `listLiveTasks` | `{nonce, conversationId}` | `{items, asOf}` with task rows and bounded output tails |

`action` is the validated native UI action, with a resolved environment for workspace previews.
Apply a client effect only when `execute` is true. Check the nonce again immediately
before the UI action. A retry returns the stored receipt, including an in-flight
`accepted` receipt. A restart makes an unfinished client effect `unknown`; it must
not be applied again.

Report only natural audio drains. A cleared response or a response with no audio
is not a drain. Report drain before closing a delivered offer. Pass `responseId`
when known; without it, `closeOffer` uses the most recent drain after the offer.
Call `finishUserExchange` once after each user exchange, including a silent one.
The quiet timer alone must not call it. This extra RPC supplies the defer boundary
that the server cannot infer from tool calls or audio drains.

`remain_silent` and `end_call` return sequencer directives. The client applies them
at the correct response boundary. It must keep the existing final-transcript,
correction-window, ordering, interruption, and continuation checks.

## Persistence and recovery

`live-store.ts` declares exactly five new tables. Added columns store the first
utterance text, SDK delivery evidence, event keys, watch output evidence, and offer
eligibility. All old SQL statements keep their order and contents. The feature
migration function now also returns the existing utterance and prompt migrations,
so the new statements follow their deployed indexes.

The ledger key includes the conversation, utterance ID and version, tool, canonical
argument hash, and occurrence. The call nonce is evidence, not part of the unique
key. This permits a device-transfer retry to return the old receipt. One partial
unique index stores the source utterance text only on its first operation row.

Spawn uses an operation-ID watch placeholder until BB returns the thread ID. An
unconfirmed spawn stays unknown and consumes worker capacity. Workers have no
parent and use hidden visibility; created threads are visible. A created thread
needs a project. A worker without `project_id` runs in BB's personal project with a
personal workspace on the primary machine: `host_id` if given, else the connected
machine that hosts the most projects. The receipt reports `profile`, `outsideProject`,
and the machine. The call schema enumerates configured profile names; a missing
`profile` is the default, an exact configured name wins over the `default` alias, an
approximate name resolves by stem, and an unknown name fails with the configured list. Worker capacity is global to this plugin, as in
the previous executor. Before reserving a slot, lifecycle reads release finished
workers, including muted workers. An unavailable worker keeps its slot.

Native events and recovery run on one queue. A send's SDK call and receipt write
share that queue so an early dispatch callback cannot lose its operation match.
Each watched child gets its own event cursor and retains the same root grouping.
Recovery reads pages of 100 events (BB 0.43 caps a page at 100). Each stored turn keeps its own available
assistant text; missing historical text is marked missing. Lifecycle snapshots
cover a fast completion that had no recorded event. Event keys suppress repeats.

Delivery reconciliation compares exact stored bodies against queued messages and
native user-message items in the 200 most recent events. It does not retry an
uncertain SDK effect. More than one matching native message stays uncertain.
Failures to read a watched thread retain its cursor and are logged; recovery
continues for other threads.

Watches, tasks, receipts, inbox items, and offers survive restart. Allowed IDs,
archive previews, drains, and spoken-confirmation marks belong to the active call
in memory. Reload requires a fresh call-start context and a new spoken preview or
interaction explanation before a confirmation can apply.

## Decision 1 evidence

On 9 September 2026, the installed SDK 0.4.47 declarations allowed hidden root spawn,
`includeHidden`, direct reads, and direct open. The disposable thread
`thr_pdaua8mima` in project `proj_gm9vbxuk89` verified those operations through the
current CLI. It returned `parentThreadId: null` and `visibility: "hidden"`, appeared
in the hidden-inclusive list, reached idle, and opened with `file: null`. Open
reported delivery to four app connections. The thread was then archived; BB returned
that same ID in `archivedThreadIds`. No Voice session was opened or changed. No
plugin was installed or reloaded. This verifies command delivery, not a visual
inspection of the resulting pane.

## Decision audit

These choices supplement the task specification. They are ordered by confidence.
The user explicitly authorized commits, so this audit does not add a new approval
step.

| Choice | Alternative | Confidence | Possible failure |
| --- | --- | --- | --- |
| Keep archive previews and spoken marks only in the current process and call. | Persist them in an additional record. | Medium | Reload makes the user hear and confirm the item again. It cannot reuse an old yes. |
| Match unknown delivery in the latest 200 events and leave ambiguous matches unknown. | Search all history or inject a thread marker. | Medium | A busy thread can retain an unknown receipt after its matching event leaves that window. |
| Use epoch milliseconds for drain and utterance times. | Add a clock synchronization protocol. | Medium | A client clock ahead of the server can have its drain rejected as a future timestamp. |
| Add `finishUserExchange` for the next-exchange defer trigger. | Infer the boundary from a tool or drain. | High | Missing client wiring leaves deferred items waiting until another listed trigger. |
| Keep five tables and add evidence columns; store source text once on the first operation row. | Add separate utterance and delivery tables. | High | Ledger pruning must preserve the row that owns an utterance's source text. No pruning is implemented. |
| Use per-child cursors and one event queue. | Use one cursor for a root or process callbacks independently. | High | A slow recovery read delays other event processing. Cursors retain evidence if a read fails. |
| Keep unconfirmed workers in the global quota; refresh lifecycle state before reservation. | Count only active watches or confirmed launches. | High | An inaccessible or unidentified worker can hold capacity until its state is resolved. |
| Use the first qualifying natural drain after an item was returned. | Require a separate item-to-response binding RPC. | High | This implements the requested coarse spoken check; it cannot prove which exact sentence the model said. |
| Bound output tails at 6,000 characters, summaries at 600, target results at 50, and target scans at 1,000 per archive state. | Return unbounded data. | High | A broad search may need a narrower query. Truncation is reported. |
| Use a 30-second SDK mutation timeout. | Wait indefinitely or retry. | High | A slow accepted action can return unknown and need reconciliation. |
| Read named profiles from v2, or adapt v1 in memory without writing it. | Migrate settings during this server step. | High | The later settings UI must write v2 before custom named profiles become editable. |
| Reject a different effect while the same utterance has an unknown operation. | Trust only the model's no-retry instruction. | High | The user must make a new explicit request after reading the uncertain receipt. |
| Log recovery read failures and preserve the original evidence. | Fail the entire plugin startup. | High | One root's update can wait for a later recovery attempt while other roots continue. |
| Verify with fake SDK tests, a synthetic database copy, and one live disposable root. | Install the unfinished runtime and test a live call. | High | Physical audio and final client integration remain for the next step, as requested. |

I stand behind this server implementation within these stated limits. The client
cutover and physical playback checks remain separate work.


## Settings and UI update

The named-profile migration, prompt history editor, and Tasks view are now built.
Startup migrates v1 settings to v2 once and retains v1. The active live prompt now
uses role `aide`; roles `live` and `coordinator` are read-only history for rollback.
See [Settings and Tasks handoff](docs/settings-and-tasks.md) for the changed settings
RPC shape, stored work snapshots, and validation. The earlier server-step audit
above records the choices at that step; this update supersedes its deferred UI work.
