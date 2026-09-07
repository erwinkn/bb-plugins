# Coordinator implementation decisions

7 September 2026. Scope: the initial coordinator implementation and its draft PR.
The user authorized a draft PR and local activation for manual voice testing.
The decisions confirmed in Grill remain in coordinator-plan.md.

This records implementation choices where the plan left room for judgment.

| Decision | Alternative | Confidence | Failure case |
| --- | --- | --- | --- |
| Use a trusted agent prompt to interpret conditional authority and select watched threads. | Intercept every native action in BB core. | Medium | The coordinator can still misread intent or omit a watch entry. Live model tests remain necessary. |
| Resolve spoken answers in the plugin and cancel the corresponding native interaction row. | Verify and use the existing SDK response methods. | Medium | BB history says cancelled even though the plugin delivered an answer. The plugin stores submission and delivery separately. |
| Keep unknown delivery unknown when history lookup fails or returns no marker. Retry checks again without resending. | Retry after a timeout or missing marker. | High | A request that never arrived can remain blocked until the user inspects the coordinator. This avoids an automatic duplicate action. |
| Retain an unreachable coordinator's identity, and block a second create after an unconfirmed create. | Replace an unreachable thread immediately. | High | Recovery may need a new logical conversation after the user checks the old one. |
| Wait up to four seconds for transcription, then reject incomplete input at the server. | Execute the voice model's interpretation or wait without a limit. | Medium | Slow transcription asks the user to repeat a valid request. This needs measurement in real calls. |
| Allow a digest after fifteen seconds when a resumed call has no user request. | Wait for an opening request without a time limit. | Medium | A user who joined only to listen receives a digest; a user preparing to speak may find it early. Active speech still blocks delivery. |
| Use the personal project's default connected machine, then the first connected machine, unless a machine is selected. | Require a machine choice before the first call. | Medium | With several machines, the default may be different from the one the user expects. The settings allow an explicit choice. |
| Default the coordinator to Codex and resolve its catalog default model. Store the resolved choice per conversation. | Pick a fixed model or inherit project defaults. | Medium | A catalog default may be slower than the target. Existing conversations retain their coordinator; a new model setting applies to a new coordinator. |
| Keep coordinator mode off by default in source; enable it only in the user's local configuration for this test. | Enable it for every installation. | High | Other users must enable the option before they receive the new behavior. |
| Store versioned conversation, request, reply, question, watch, and update rows in the plugin database. | Keep state only in model history or KV. | High | Schema changes require append-only migrations; retained history grows over time. |
| Bound context and lookups: 200 client transcript items, 20 transcript items per handoff, 8 recent replies, 20 timeline segments and 100 coordinator candidates for reconciliation. | Send or scan all history on each request. | Medium | Old evidence may be outside these windows. An absent receipt cannot authorize a resend. |
| Preserve failures and blockers when coalescing updates, and limit a batch to two threads. | Keep every status event or always prefer the newest event. | Medium | An old failure may be spoken after recovery unless later evidence resolves it. |
| Serialize coordinator creation and request dispatch with per-conversation in-process locks, plus durable receipts. | Add distributed locks and a native idempotency API. | Medium | Process loss can leave pending state that needs reconciliation; this does not guarantee exactly-once native actions. |
| Fall back to bounded final assistant text when no structured reply exists. | Remain silent and show a failure only. | Medium | A model that omits the reply tool may produce a less useful spoken summary. The fallback is not parsed as executable work. |
| Keep composer text and mobile drawer controls on the realtime model. | Route every presentation change through the coordinator. | High | A mistaken presentation request can change the local view or draft text, but cannot send that draft. |
| Use a one-hour native question timeout and preserve unresolved questions on cancellation. | Leave questions pending indefinitely. | Medium | A long absence requires the question to be presented again. |
| Log and retain state after background delivery or cleanup errors where possible. | Fail the entire voice call for every auxiliary error. | Medium | A lost delivery report can cause an update to be presented again; logs and persisted state support diagnosis. |
| Test with fake SDK/realtime hosts and a disposable native thread before manual calls. | Require a full live agent and physical mobile test before a draft. | Medium | Prompt quality, real audio interruption, drawer focus, and the 3–5 second target are not established by the local suite. |

Verdict: I stand behind this as a draft for controlled user testing. I do not
claim that the live voice workflow is fully verified. The remaining exceptions
are live model interpretation, physical audio behavior, latency, and the SDK
interaction workaround. No merge or general release is part of this change.

## Dedicated Voice area follow-up

The user requested this revision in the same branch and PR on 7 September.

| Decision | Alternative | Confidence | Failure case |
| --- | --- | --- | --- |
| Put optional Threads content in the Voice page, with Conversation returning to the preserved history view. | Register fixed side-panel tabs on both clients. | High | Fixed tabs open automatically on the first desktop visit. The in-page choice avoids that unsolicited inspection. |
| Preserve the existing view preference storage key and apply it to both clients. | Rename the key and migrate it. | High | The old internal name says mobile, although the UI now explains the shared behavior. |
| Keep the conversation component mounted while inspection is shown. | Unmount and reload its history each time. | High | Hidden listeners need to avoid handling Escape or stealing focus; the Escape handler is disabled while hidden. |
| Remove the work-thread panel entry and reject legacy native navigation RPCs. | Keep them as alternate entry points. | High | A stale frontend reports that it needs an update; it cannot navigate a voice request into another work thread. |
| Open Voice through the app-wide binding when a new call starts. | Leave new calls on whichever work thread was open. | Medium | Actual mobile navigation and microphone continuity still need a physical call test. Call ownership stays in the existing app-wide singleton. |
| Keep native permission decisions in BB's UI until the existing SDK response methods are verified and wired to explicit spoken answers. | Infer approval from speech and bypass BB's interaction API. | High | Some permission requests still need the user to look at the app, inside Voice's optional thread view. |

Verdict: suitable for the existing draft and local user test. Physical desktop
and mobile microphone continuity remains unverified. No new branch, PR, merge,
or session-data reset is part of this revision.

## Unified sessions and speech follow-up

The user approved implementation and reload of the session and speech proposals.
These are the remaining implementation choices for that iteration.

| Decision | Alternative | Confidence | Failure case |
| --- | --- | --- | --- |
| Keep native VAD settings; add response IDs, monotonic timing, and matching playback handling. | Tune silence thresholds without a new trace. | Medium | A false VAD turn may still interrupt speech. The next physical test must establish its cause. |
| Give the bridge the acknowledgment after the original tool response settles, unless that response already spoke. | Let both models decide when to acknowledge. | High for bridge behavior; medium for live model compliance | A realtime model may ignore the silent-delegation instruction and speak more than requested in its initial response. The bridge does not add another acknowledgment. |
| Keep request progress in diagnostics and accept one final reply per request. Preserve clarification and digest delivery. | Speak useful interim progress on a timer. | Medium | Long tasks are quiet until a question or final answer arrives. A changed answer needs a new request rather than a second final for the old request. |
| Use titles and runtime status in a 30-item overview from the 200 most recent threads and the existing 30-minute window. | Read many thread transcripts for every overview. | Medium | Old blocked work outside the window may be absent; titles can be stale. The tool states its scope and does not certify completion. |
| Group calls using recorded conversation IDs, request receipts, and a new call relation. Adopt standalone legacy calls only when Continue is selected. | Rewrite old event records or assign a coordinator while browsing. | High | An old call with no recorded association remains separate until explicitly continued. |
| Retain unknown playback for old assistant transcript rows. Do not merge by matching words. | Infer delivery from adjacent reply text. | High | An older transcript cannot prove which audio reached the speaker. Diagnostics retain the requested reply text. |
| Use 40-session pages and read-only aggregation over retained history. | Add a separate materialized session index immediately. | Medium | Large histories cost more to list; no records are dropped. |
| Embed the coordinator thread in its secondary session tab; work-thread inspection remains within Voice. | Navigate to the hidden thread's main page. | High | Native embedded interaction rendering still needs a physical device test. |

Validation covers deterministic backend, realtime-event, transcript projection,
and rendered React flows. It does not measure the next physical call's latency
or prove that acoustic interruptions are resolved. I stand behind this as a
draft for the requested testing, with those limits stated.
