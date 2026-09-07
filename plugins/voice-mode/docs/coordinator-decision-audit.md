# Coordinator implementation decisions

7 September 2026. Scope: the initial coordinator implementation and its draft PR.
The user authorized a draft PR and local activation for manual voice testing.
The decisions confirmed in Grill remain in coordinator-plan.md.

This records implementation choices where the plan left room for judgment.

| Decision | Alternative | Confidence | Failure case |
| --- | --- | --- | --- |
| Use a trusted agent prompt to interpret conditional authority and select watched threads. | Intercept every native action in BB core. | Medium | The coordinator can still misread intent or omit a watch entry. Live model tests remain necessary. |
| Resolve spoken answers in the plugin and cancel the corresponding native interaction row. | Wait for a new SDK response API. | Medium | BB history says cancelled even though the plugin delivered an answer. The plugin stores submission and delivery separately. |
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
