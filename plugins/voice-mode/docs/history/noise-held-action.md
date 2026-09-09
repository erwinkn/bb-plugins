# Raw activity rejected a valid navigation request

8 September 2026. Call `2754a5a8-36e4-49cb-a2d6-3c2ebf568b88`, conversation
`conv_a4e21e8c729ea`. Times below are Europe/Paris.

| Event | Time | Evidence |
| --- | --- | --- |
| Final user request | 20:48:53.178 | Event 3110: request to switch to the editor/diff thread; utterance 3. |
| Target lookup | 20:48:55 | Events 3116/3118: lookup returned the active Pierre editor thread and older archived matches. |
| Navigation attempted | 20:48:56.995 | Event 3120: quick_action open_thread for the resolved active thread. |
| Navigation rejected | 20:48:57.001 | Event 3121: "Held: the user continued speaking." No request reached the action executor. |
| Next recognised words | 20:50:17.129 | Event 3125: utterance 4; its final text was "still there". |
| Navigation eventually completed | 20:50:23 | Events 3131 onward: another tool call opened the requested thread. |

The request and response still belonged to utterance 3 at the failed action.
There was no new words-confirmed event, interruption, or invalid-response event
between the final request and the refusal. The failed condition was the
`userSpeaking` check, which read raw meter activity from `InputController.speaking`.
It did not require recognised words. Thus, raw sound could leave playback intact
but reject a valid tool call as if the user had started speaking. The same getter
could also invalidate a response between response.create and response.created.

The logs do not establish the acoustic source. It could be room noise or audio
pickup; no microphone recording was stored. They do establish that the error
was not evidence of new spoken words. Server VAD was confirmed disabled in
session.configuration events 3080 and 3082.

## Change and decision

Separate `audioActive` (raw meter activity) from `speaking` (activity with a
confirmed, unfinished spoken item). Raw activity remains useful for input commit
timing and the two-second wait before consequential effects. It cannot mark a
new spoken turn, erase the final snapshot, or cancel an eligible response.
Navigation can use the complete prior instruction without a false speech error.
Actual new words still interrupt, change utterance identity, and cancel unsent
work. Tool-call diagnostics now include both signals and response/utterance IDs.

This fixes the shared input-state definition instead of removing the check from
one tool. Lowering microphone sensitivity would only hide the incorrect state
coupling. Confidence is high for the control-flow cause; the sound source and
physical microphone tuning remain unverified.

Two event replays failed before the change: noise at tool execution, and noise
between response request and creation. Both pass after the fix. A third test
checks that raw activity still delays consequential work without destroying its
complete transcript. Existing word-interruption, failed-transcript, correction,
and effect-identity tests remain in the full suite.
