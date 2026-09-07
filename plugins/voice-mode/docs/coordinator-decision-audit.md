# Voice workspace decision audit

7 September 2026. Scope: the complete Voice reliability change in draft PR 15.
The user authorized implementation, the draft PR, and local reload for testing.
This audit describes the current design; it supersedes the earlier embedded
work-thread workspace and optional coordinator design.

## Core decisions

| Decision | Alternative considered | Confidence and limit |
| --- | --- | --- |
| Use one mandatory coordinator for each logical conversation, which can span several calls. | A fresh coordinator for each connection, or one shared across all conversations. | High. Reconnect preserves context; New conversation starts a separate history. Provider settings apply when its coordinator is created. |
| Keep the realtime model limited to delegation, silence, and ending the call. | Give it direct BB mutation or composer tools. | High. The server rejects other tools. The coordinator still interprets intent with a model; this does not make every action deterministic. |
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
