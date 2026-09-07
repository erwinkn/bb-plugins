# Voice workspace decision audit

7 September 2026. Scope: the complete Voice reliability change in draft PR 15.
The user authorized implementation, the draft PR, and local reload for testing.
This audit describes the current design; it supersedes the earlier embedded
work-thread workspace and optional coordinator design.

## Core decisions

| Decision | Alternative considered | Confidence and limit |
| --- | --- | --- |
| Use one mandatory coordinator for each logical conversation, which can span several calls. | A fresh coordinator for each connection, or one shared across all conversations. | High. Reconnect preserves context; New conversation starts a separate history. Provider settings apply when its coordinator is created. |
| Give the realtime model bounded navigation and informational thread-message tools, while other work uses the coordinator. | Delegate every interaction. | Medium. This follows the later user request. The quick-action audit below covers its semantic limits. |
| Let the native BB workspace own thread pages, projects, splits, composers, and file previews. | Embed and maintain a second work-thread workspace in Voice. | High. The global call owner survives page changes. BB controls split fallback and pane limits. |
| Use a separate structured `voice_ui` tool and wait for its receipt before speaking the result. | Put navigation hints in `voice_reply` or parse speech into UI actions. | High. Speech never causes navigation. Background batches cannot issue UI commands. |
| Execute UI commands only in the client that owns the physical call. | Use a server navigation broadcast to every BB window. | High within the trusted frontend. BB plugin RPC does not expose an authenticated client identity; the nonce is a routing identifier, not a secret credential. |
| Record each command before publication, claim it before effects, and never replay a started command. | Retry effects after a timeout. | High. An uncertain outcome remains unknown. A lost receipt can prevent a valid action from being reported as complete; it cannot authorize a duplicate draft edit. |
| Revoke pending UI work on request completion, cancellation, hangup, or connection loss. | Let pending composer waits finish after their request ends. | High for the tested lifecycle. Reconnect reconciles cancellations before enabling new effects. A completed synchronous SDK call cannot be undone. |
| Prepare drafts only in an exact thread or new-thread composer, with append as the default. | Use whichever composer happens to have focus. | High. Queued-message editors and side chats are excluded. A draft action never submits text. |
| Observe native context after navigation and report uncertainty where the SDK gives no completion result. | Treat every void SDK call as successful rendering. | Medium. BB has no complete request-scoped result API. Preview acceptance does not prove that file content rendered. |
| Resolve spoken names and context with BB tools. | Require IDs, links, or manual search. | High for the available tools. Ambiguous names require a spoken question; inaccessible targets still fail under BB permissions. |
| Keep one contextual acknowledgment, then work quietly and speak useful results or material blockers. | Speak acknowledgment, assignment, progress, and completion for every request. | High for bridge scheduling. Live models can still produce unwanted wording, so actual voice tests remain necessary. |
| Queue routine follow-ups and group spoken work overviews under parent threads. | Steer every active thread or list every child separately. | Medium. Coordinator tool choices remain model-driven. Explicit interruption requests can steer. |
| Preserve the original transcript items in compact request context. | Summarize spoken instructions before dispatch. | High. This reduces repeated wrapper text without discarding material wording. |
| Coalesce watched-thread updates and hold digests until speech, tools, response generation, and playback are idle. | Inject every event as soon as it arrives. | High for deterministic scheduling. BB can still deliver native messages to a coordinator outside this plugin's inbox. |
| Preserve append-only migrations and historical event readers while deleting obsolete runtime paths. | Rewrite old rows or retain old execution modes. | High. Existing sessions stay readable; old configuration fields do not restore direct tools. |

## Recovery and retained behavior

Requests are recorded before native delivery. An uncertain send is reconciled
against BB history before any retry; absence of evidence is not permission to
resend. An uncertain coordinator create does not spawn a second coordinator.
Questions retain separate submission and delivery state across hangup. Accepted
work can finish after hangup, with results queued for the next call.

Conversation rendering groups speech fragments at the recorded pause boundary
or assistant playback. Raw events remain unchanged. Old playback without IDs
stays unknown rather than being inferred from matching text. Saved user
preferences remain separate from the required execution contract.

## Validation and release limits

Focused tests cover request delivery, replies, questions, quiet update batches,
UI claims, duplicate signals, cancellation, disconnect, reconnect, and draft
scope. Frontend tests cover native navigation bindings and the session views.
Full-suite, build, browser, and installed-bundle results are reported with the
change rather than frozen here as counts that become stale.

Physical desktop and mobile calls are still needed to measure microphone and
playback continuity, acoustic interruptions, latency, keyboard interaction, and
spoken model compliance. Browser route tests cannot establish those properties.
Desired BB improvements for UI completion receipts and native-message admission
are recorded in the repository README.

I support this design for the user's requested draft and local test. No merge
or general release is authorized. The user's existing publication and reload
instructions cover this revision; no additional approval gate is required.


## Empty transcription recovery — 7 September 2026

The latest call produced two committed speech items with no usable transcript.
The bridge marked them available; the server rejected the resulting empty
request. No work was delivered for that request.

| Decision | Alternative | Confidence and possible failure |
| --- | --- | --- |
| Keep the transcription model and VAD settings for this patch. | Switch models or change microphone thresholds. | Medium. The log has no raw audio to establish why transcription was empty. Recognition can still fail; a physical call is needed. |
| Cancel only the affected realtime response once its transcript is known to be unavailable. | Wait for transcription before every spoken response. | Medium. This keeps existing latency, but speech heard before a late failure cannot be taken back. Coordinator replies and newer user turns are excluded. |
| Reject missing input locally and give one fixed recovery question for that failure. | Send an invalid envelope and rely on the server's error reply. | High. This avoids duplicate recovery messages. The server's independent validation remains. The four-second wait is unchanged. |
| Require a new spoken request after recovery, even if the old transcript arrives later. | Automatically restart rejected work on a late result. | High. A user must repeat a sentence that later becomes available. Late words remain in the transcript. |
| Validate every fragment of the current utterance; retain earlier failed items as missing context. | Let an earlier failed turn block all future requests. | Medium. A later instruction that depends on missing earlier words still needs clarification by the coordinator. |
| Show one missing-transcript marker, separated from actual user words; replace it if text arrives later. | Omit failed speech from the conversation. | High. Historical calls without the new result event cannot gain this marker from evidence that was never saved. No stored events are rewritten. |
| Log bounded provider error fields, result length, item identity, turn, and time since commit. | Record raw microphone audio. | High. These fields improve diagnosis but cannot establish microphone signal quality. |
| Use deterministic event tests for cancellation, retry, ordering, partial input, and pending questions. | Treat a build as evidence of live audio quality. | High for the tested state transitions. Physical playback and recognition remain unverified. |

I stand behind this recovery change for the user's draft PR and local test.
It fixes the confirmed availability and recovery defects. It does not establish
that the underlying transcription service will recognize the next recording.
The user's existing PR and reload authorization covers this update.


## Direct quick actions — 7 September 2026

The user requested direct realtime navigation and simple thread messages. The
optional scope question has no answer yet. The default is comments and read-only
status requests; small implementation requests still use the coordinator.

| Decision | Alternative | Confidence and possible failure |
| --- | --- | --- |
| Limit direct messages to quoted comments and read-only status requests. | Also send small implementation requests directly. | Medium. This is the narrower interpretation of simple requests while clarification is pending. It can keep some short requests slower. |
| Use a strict action schema, verbatim text checks, and conservative operation-word routing for messages. | Add a model-based intent classifier before each message. | Medium. Phrase meaning remains model-driven. The word check is not a multilingual safety boundary. Recipient instructions explicitly prohibit state changes for these messages; an agent could still misinterpret quoted content. There is no direct destructive SDK operation. |
| Reuse the stored request, reply, watched-update, and UI command paths. | Add a separate fast-path conversation or browser automation. | High. Quick requests have a distinct running state so coordinator idle events cannot settle them. |
| Admit one quick effect per spoken input and queue every direct message. | Permit multiple effects or direct steering. | High. Multiple targets or steps must use the coordinator. A second tool call does not imply a second user authorization. |
| Cancel pending quick work on new speech, hangup, or expiry; preserve cancellation before submission. | Let accepted UI waits finish after a correction. | High for tested transitions. An SDK send already in flight cannot be undone; cancellation records uncertainty and does not retry it. |
| Bound direct SDK waits by the existing UI action budget of 20 seconds. | Wait indefinitely or retry after a timeout. | Medium. A slow valid operation can be reported as uncertain. Its effects are not repeated. |
| Preserve unknown delivery across reload and watch message targets before sending. | Resend when no response arrives. | High. Later thread results can still reach Voice. A missing receipt may require inspection rather than a retry. |
| Use read-only search with hidden-thread filtering and explicit truncation. | Require pasted IDs or silently treat a partial list as complete. | High. Ambiguous names still require a spoken question. |
| Speak stored results through the bridge, including sent versus queued status. | Let the realtime model improvise tool completion replies. | High for delivery ownership. The fixed quick-result text is currently English, as are the existing bridge recovery messages. Live voice wording and latency still need testing. |

I support this bounded fast path for the draft and local test. I do not claim
that a word filter proves arbitrary natural-language messages harmless. Direct
implementation requests remain outside this revision pending the user's answer.


## Device switch — 7 September 2026

| Decision | Alternative | Confidence and possible failure |
| --- | --- | --- |
| Show a remote-call label and Switch here; hide local mic and stop controls on that indicator. | Hide the remote call entirely or show it as Connected. | High. Shared presence already identifies remote ownership. Same-browser windows use a separate label. |
| Transfer one active audio connection while retaining its logical conversation and coordinator. | Add simultaneous call participants. | High. The current WebRTC transport and request ownership assume one active device. A switch starts a new physical call, with a short audio gap. |
| Acquire the new device's microphone before claiming ownership. | Disconnect the old device before requesting permission. | High. Permission denial leaves the original call running. SDP or network failure after the claim can still end the transfer; automatic rollback is not implemented. |
| Compare the expected old call nonce before transfer and keep the coordinator runtime during the change. | Replace whichever call is active when permission resolves. | High. A stale button cannot take over a different call, and the old hangup does not release the resumed coordinator. |
| Verify ownership, permission failure, stale transfer, and UI controls with deterministic tests. | Treat these tests as proof of desktop/mobile audio continuity. | High for the tested behavior. Physical device switching remains a user test. |

I support this device-switch implementation for the existing draft and local
reload. Joining as a second simultaneous participant is not part of this change.
