# Three-tier integration and remaining input work

8 September 2026. The user authorized landing the prepared implementation on
PR 15 and reconciling the existing local changes. No new action-delay policy,
model choice, or permission rule was selected in this integration.

## Recovered source

The quoted prepared tree `6cb23d33c59bf137e489b8ae513dd0bba96951c7` is the tree
of commit `c855712`. Its workflow had already landed the implementation as
`0bae5f21485c5a9eb3b32353082e6a394fbf9a3c`. We checked the compressed payload's
SHA-256, all 25 feature-file blob IDs, and the root README append against that
implementation commit. A clean checkout passed 229 tests, typecheck, and the
BB build. The temporary payload/applier and workspace-upload steps are removed;
normal CI now also compiles both plugin entries.

## Integration decisions

| Decision | Alternative | Confidence and possible failure |
| --- | --- | --- |
| Keep the new live operator, fast coordinator, worker profiles, and shared action executor. | Restore the older coordinator-only work path. | High. This is the user's new architecture. Direct messages and worker creation can cause work under the recipient's normal permissions. |
| Restore local streaming, sequence playback, cancellation bookkeeping, relative target lookup, and immediate coordinator finals. | Drop the local changes or load the old build. | High for tested transitions. These preserve earlier requested behavior; physical audio is not established by unit tests. |
| Retire the separate voice_send tool; use voice_actions for new deliveries. Recover old saved receipts without sending again. | Keep two delivery implementations. | High. One ledger owns new effects. An old in-flight receipt remains unknown rather than being retried. |
| Prefer recorded action outcomes over trailing coordinator fallback text. Reject premature finals while an action is running. | Let an idle/failure event invent a result after dispatch. | High. Tests cover pending delivery, duplicate calls, unknown delivery, and one destination-specific final. |
| Treat a validated coordinator final as the end of its request. | Wait for the coordinator's idle event. | High for the contract; a model that tries another action after final will be refused. Instructions state the order. |
| Preserve both migration histories using the first divergent statement hash. | Reorder the deployed sequence migrations or the published operator migrations. | High for pinned SDK 0.4.47. Unknown history fails the SDK's existing hash check. Tests upgrade both histories twice; an installed database copy also retains its original ledger and history rows. |
| Decode the historical request message purpose as instruction only when reading saved envelopes. | Hide those historical requests or broaden the current live tool schema. | High. A regression test keeps historical requests visible while new calls still use the current schema. |
| Include request identity in the strict streaming snapshot schema. | Strip it at the client. | High. The client already emits it; a full RPC test now checks the assistant draft rather than a permissive RPC mock alone. |
| Capture view context when sound starts, without interrupting until words arrive. | Capture the target when transcription finishes. | High for the tested navigation race. Earlier interrupted-narration topic grounding still needs the separate reviewed work. |
| Keep server VAD until the reviewed input controller is implemented and tested. | Disable VAD during this merge without a replacement commit/endpoint controller. | Medium. This preserves a working input path but leaves the known noise interruption issue open. The README states that limit. |
| Compress coordinator instructions below the host limit and verify exact equality after host configuration. | Add sequence instructions beyond the limit. | High. The complete policy is 3,498 characters; the host test checks it is not truncated. |

I support this as the reconciliation of the requested implementations. I do not
claim the resulting voice experience is fully reliable: server VAD still clears
playback on noise, and the input bridge still needs the reviewed utterance
ownership changes. These are explicit remaining work, not a passed audio test.

## Earlier recommendations after this integration

| Recommendation | Applies now? | Reason |
| --- | --- | --- |
| Keep WebRTC; disable server VAD once a client endpoint controller exists. | Yes, unchanged. | Three model tiers do not alter the WebRTC input/playback path. The current flags do not prevent provider audio clears on raw VAD. |
| One input controller owns items, finals, utterances, and transcript deadlines. | Yes. | The bridge still has a second item table and a cursor; its last-turn filter can exclude earlier clauses. |
| Distinguish audio chunks, visible messages, and permission to act. | Yes, more important. | The live layer can now send implementation instructions and create workers directly. A five-second visual merge cannot retract an accepted action. |
| Reuse immutable utterance context across distinct operations. | Partly. | The new group supports up to four recorded effects, but a second tool call still runs into transcript consumption. Do not replace the effect ledger while fixing utterance ownership. |
| One shared effect record; never retry uncertain sends automatically. | Implemented and retained. | Live and coordinator actions share request/step identities and durable outcomes. |
| Preserve speech intent and exact source context when forwarding. | Improved and retained. | The new wrapper carries original words, transcript items, interpretation, destination, and provenance separately. Missing clauses must still be fixed at the input boundary. |
| Reduce coordinator context and the return delay. | Improved, not proven by timing. | Workers do substantive work; structured worker reports bypass another coordinator turn. Validated coordinator finals now publish without waiting for idle. |
| Stream conversation text and wait for real playback between narrated actions. | Restored in this integration. | The prepared implementation was based on the earlier committed source and did not contain these local changes. |
| Separate the narration currently playing from the last fully heard narration. | Still open. | Sequence playback was retained; the earlier stale-topic review remains relevant. |
| Avoid exact-name requirements for harmless navigation. | Retained. | Lookup includes creation/activity times and archived state, and instructions accept relative descriptions. |

Next: run the long-silence/no-VAD buffer experiment before implementing the
smaller input controller. Keep the new executor as its consumer. Then test desk
noise, speaker echo, quiet speech, stop/wait followed by a correction, long
pauses, missing finals, reconnect, and device transfer. The action continuation
window is a product timing choice; this integration does not invent a value.
