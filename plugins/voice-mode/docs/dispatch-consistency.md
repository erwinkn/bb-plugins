# Dispatch consistency: 8 September 2026

## Evidence

Call `2754a5a8-36e4-49cb-a2d6-3c2ebf568b88` in conversation
`conv_a4e21e8c729ea` reproduced three connected failures.

- Event 3177 selected a direct send to the editor thread correctly. Its rewritten
  message failed the exact-excerpt check. The manager silently sent request
  `r_b38de159723040ad` to the coordinator, dropping the selected action from the
  coordinator's formatted context. Event 3185 then opened Voice directly.
- Coordinator events 74–99 show a rejected group, a separate open, then a rejected
  send because the request already had a different action group. Native thread
  tools were then used. This was not a reliable ordered execution.
- Event 3311 used prepare_draft although the user asked to queue the report.
  Event 3341 tried the correct send_message with the report, but the same excerpt
  check caused another silent delegation. The coordinator received only the
  correction, without the report or resolved destination. Event 3373 announced
  the earlier PR question against the stale discussed thread. A later correction
  sent that earlier question to Voice instead of the report.
- Events 3307 and 3373 contain coordinator-authored raw IDs in speech. The bridge
  read those replies verbatim.

## Changes and decisions

1. **Model-authored message bodies are separate from original words.** The optional
   text can hold a requested report or previous draft. Both it and the full
   transcript reach the selected destination, with explicit provenance and the
   user's scope taking precedence. The exact-substring check is removed; it was
   not a semantic intent check. Alternative: require verbatim excerpts only and
   a separate report-delivery tool. Confidence: medium. A model can still compose
   an incorrect body; recipient permissions and the original words remain the
   authority. This change does not prove semantic correctness of every message.
2. **One execution path per utterance version.** Existing durable request rows
   record ownership. Mixed paths are rejected, not silently rerouted. This applies
   to all effectful operations in that utterance, including independent clauses.
   Alternative: add model-declared sequence IDs. Confidence: high for ordering;
   medium for flexibility. If a capability gap is discovered after a direct step,
   the remaining work stops instead of changing paths. Prompts require lookup and
   path selection before effects.
3. **Separate direct calls wait for preceding receipts.** Known actions should be
   grouped, but separate calls are also ordered. Failure or unknown delivery stops
   later steps. Alternative: rely only on group instructions. Confidence: high.
   This waits for message acceptance, not the target agent's completion. Existing
   action timeouts, cancellation, and late receipts still apply.
4. **Queue and draft have distinct instructions.** Queue/send uses send_message;
   prepare_draft requires an explicit request for unsent composer text.
   Alternative: remove drafting. Confidence: high. Intent selection is still a
   model decision, not an English keyword filter.
5. **Speech uses names.** Coordinator replies containing raw thread IDs are
   rejected with a correction instruction unless the user asked about IDs.
   Structured IDs remain intact. Alternative: silently replace IDs in speech.
   Confidence: medium. A rejected reply needs another model call; the live model's
   own speech still relies on its prompt. Tool descriptions also state that a
   thread's latest output cannot prove message delivery or justify a resend.
6. **Saved prompts retain user edits.** Only matching changed policy paragraphs
   were replaced through the settings UI, after checking their saved versions.
   Alternative: reset prompts to the new defaults. Confidence: high. Existing
   coordinator runtimes receive settings when BB next configures them; a new
   conversation is the reliable way to test the updated coordinator prompt.

7. **Message receipts confirm delivery without a recap.** The service now says
   “Sent to Editor” or “Queued for Editor” without appending dictated or composed
   text. Both role prompts use the same rule. The alternative was summarizing the
   body for every send. Confidence: high. The complete body and original words
   remain in the action record; readback is available when the user asks. Existing
   tests assert the concise receipt and preservation of the complete payload.

The fixes belong in Voice Mode. The SDK already provides queued delivery and
native UI receipts. Coordinator access to native provider/BB tools is broader
than the Voice action service: these guards cannot intercept arbitrary shell or
native-tool calls. The coordinator instructions forbid bypassing failures, but
this is not a new host-wide permission boundary.

## Validation

The suite checks authored-body provenance and destination, direct receipt ordering,
unknown delivery stopping navigation, both mixed-path directions, and spoken names
with structured IDs. Existing duplicate-effect, group failure, cancellation,
hangup, transcript, and migration tests remain in place. Physical speech and
model tool selection still need a user call.

I stand behind these changes within those limits. I do not claim that tests prove
all model-generated message bodies are faithful or that native coordinator tools
are constrained by the Voice action ledger.
