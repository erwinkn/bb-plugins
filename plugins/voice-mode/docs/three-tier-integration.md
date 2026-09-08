# Combined operator and input design

8 September 2026. The user authorized implementation, push to draft PR 15,
and a local plugin reload. They selected a two-second correction window.
No merge is authorized.

## Model and input boundaries

The live operator handles resolved navigation, thread messages, and worker
creation. The fast coordinator resolves ambiguity and coordinates work. Workers
perform substantive investigation and implementation. They share the action
ledger, existing BB permissions, worker profiles, and delivery receipts.

Input is a separate system. WebRTC stays in use, with server VAD disabled.
One client controller owns energy samples, streamed words, commits, final
transcripts, utterance identity, and the deadline for a missing final.
The bridge consumes immutable utterance snapshots. Its duplicate item table,
transcript cursor, repair state, and four-second handoff timer are removed.

The client interrupts on recognised words with sustained microphone evidence.
It commits after 800 ms of quiet. A final permits speech and simple navigation;
work, drafts, task stops, and coordinator requests wait two seconds after the
last final. A continuation during that window invalidates the unsent operation
and includes every clause in the next snapshot. A failed clause blocks work
from the whole utterance. Late finals repair the display only.

Distinct operations reuse the snapshot. The existing request/step ledger still
owns results. An additional utterance/action identity prevents another tool
call from repeating the same effect with a new request ID. Unknown delivery
never causes an automatic resend. Accepted sends cannot be retracted by later
speech. Microphone or transport loss invalidates unsent work across recovery.

Current and interrupted narration have their own thread and text context.
Only delivered playback updates the last fully heard answer. The client sends
its current narration with the request, so delayed server events cannot replace
it with the previous step.

## Decision audit

| Decision | Basis | Remaining risk |
| --- | --- | --- |
| Keep the three model tiers and replace only input ownership. | Both designs were explicitly requested together. | Model target selection and intent interpretation still need real calls. |
| Disable server VAD and retain WebRTC. | Live probes showed server VAD cleared output despite both automatic flags being false. Manual mode still streamed words before commit. | Other devices and longer calls need testing. |
| Require settings confirmation before enabling the microphone. | The provider can initially report default server VAD. | Incorrect settings cause a bounded connection failure; no silent fallback. |
| Use 120 ms of sustained energy with recognised words, then 800 ms of quiet to commit. | Energy alone must not interrupt; waiting for finals makes interruption slow. The actual meter/controller passed a live API probe. | RMS thresholds need tuning for quiet microphones and sustained noise. |
| Use two seconds after final transcription before work. | The user selected this value. | It adds latency. A correction after acceptance cannot retract work. |
| Keep five-second visible grouping separate. | Audio chunks, visible messages, and authority to act have different purposes. | A long pause can start another request even when the user intended a continuation. |
| Require every clause to be final; no silent truncation. | Negations and conditions were lost by the earlier cursor. | A failed clause requires the user to repeat the full request. |
| Retain the shared ledger; add utterance-level effect deduplication. | Several distinct actions may come from one utterance. | A deliberate identical repeat needs a new request or an explicit repeated step in one group. |
| Keep silence buffers without periodic clears. | Three minutes of silence followed by speech and a manual clear passed. | This does not prove unlimited buffer duration. |
| Publish validated coordinator finals immediately. | Waiting for the coordinator turn to become idle added delay. | The coordinator must complete its action receipts before final; later work is rejected. |
| Keep both published migration histories. | Both have installed users and different statement ordering. | Unknown migration histories fail validation rather than being rewritten. |

These are implementation choices within the user's stated design. The two-second
window is the only new product timing choice, and the user confirmed it.
Physical microphone and mobile tests remain necessary after reload.

## Recovery and validation evidence

The quoted prepared tree `6cb23d33c59bf137e489b8ae513dd0bba96951c7` belongs
to recovery commit `c855712`. Its workflow had already landed the implementation
as `0bae5f21485c5a9eb3b32353082e6a394fbf9a3c`. The payload hash and all 25
feature blobs were checked. Commit `a115099` combined that code with the earlier
local reliability changes. Temporary recovery payloads and the applier workflow
were removed; regular CI typechecks, tests, and compiles both entries.

All 283 tests, typechecking, and both plugin builds pass.
The new event tests cover noise, short words, missing finals, correction timing,
multiple actions, duplicate effects, connection loss, configuration confirmation,
and interrupted narration. A copy of the installed database upgraded without
changing its 3,036 session events, 41 requests, three sequences, or one historical
send receipt. Original migration hashes remained unchanged.

Live probe artifacts are in the local artifact directory:
`/Users/erwin/.bb/artifacts/voice-review-2026-09-08/`:

- `no-vad-long-silence-probe.json`: 180 seconds of silence, then correct speech
  transcription, manual commit and clear, with no API error.
- `input-controller-probe.json`: actual microphone meter and input controller,
  one word-triggered interruption, one automatic commit, and the full final
  sentence, with no API error or repair prompt.

These probes use synthetic audio and do not establish physical microphone,
speaker echo, mobile background, or full live delegation quality.
