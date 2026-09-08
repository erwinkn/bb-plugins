# Editable prompts and internal workers

The user requested full editable live and coordinator prompts, clear model
selection, and hidden internal workers under the hidden coordinator.

## Decisions

| Choice | Alternative | Confidence and limit |
| --- | --- | --- |
| Store complete prompts by role and send their text verbatim. | Continue exposing only appended preferences. | High. BB and the voice provider still supply their own base instructions. Tool descriptions and per-call context remain separate from the editable role prompt. |
| Preserve old custom preferences in the visible live prompt. | Discard existing edits on upgrade. | High. Older prompt history stays in its table. Reset restores the new default after Save. |
| Limit the coordinator prompt to 4,096 characters. | Accept more text and risk host truncation. | High. This is the installed SDK limit. The editor shows a count and rejects oversized saves. |
| Apply coordinator edits through BB's agent-configuration callback. | Interrupt an active coordinator to restart it immediately. | Medium. New conversations receive the saved text; an existing provider runtime applies it when BB next configures that agent. No running work is restarted. |
| Resolve clear action requests directly, use the coordinator for unresolved targets or scope. | Require exact names, or guess after lookup still leaves ambiguity. | High. Model interpretation still needs live testing. Discussion is not implementation authorization. |
| Allow one material early coordinator update per request. | Ban all progress or permit repeated acknowledgments. | Medium. The live bridge owns the acknowledgment. The model must supply a useful finding; the runtime limits this update to one and retains the request for work and final results. |
| Make internal workers hidden children of their conversation coordinator. | Keep workers as visible root work threads. | High for the SDK contract. Ordinary user work threads are separate. No existing worker rows were present to migrate. |
| Allow messages and stops for hidden workers only from their recorded Voice conversation. | Reject all hidden targets or allow every hidden thread. | High. Workers remain controllable without exposing unrelated hidden threads. |
| Create or reuse the coordinator before an internal worker. | Permit parentless workers when creation fails. | High. A cold coordinator adds startup latency. If its identity cannot be established, worker creation fails rather than creating an orphan. |
| Keep role-specific model choices as overrides of a default worker profile. | Remove existing role settings. | High. A default change updates roles that matched the previous default and retains distinct choices. Existing workers retain their execution model. |
| Keep internal assignments out of speech; retain regular-thread destinations. | Announce every internal worker or hide all action receipts. | High. Voice says the investigation or work started, then reports results. It still distinguishes started work from completed work. |

The existing two-second correction window, complete-utterance requirement,
effect ledger, and playback sequencing are unchanged. These choices follow the
user's stated scope and prior authorization to implement, update the same draft
PR, and reload. No merge is performed.

## Validation

Tests cover exact prompt delivery to both model entry points, independent saves,
legacy preference preservation, coordinator length limits, failed saves and
unsaved drafts, default and role-specific worker choices, hidden worker parent
identity, asynchronous worker reports, and one early update followed by a final.
All 288 tests, typechecking, and both entry-point builds pass.
The live settings page is also inspected at desktop and narrow-phone widths.
