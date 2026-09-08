# Overview consistency: 8 September 2026

## Evidence

Call `59a2dea8-dd22-422c-9aaf-221b36448100`, conversation
`conv_f44f03a5d62bv`, asked for a quick tour of active and recently active work.

- Event 3425 called an empty target lookup. Event 3427 contains archived threads
  and child reviews. The old query limited the unfiltered list before selecting
  current work, so children and archives could displace parent workstreams.
- One realtime response issued three reads. The source response ended at event
  3433, before the first result at 3434. The remaining results arrived at 3436
  and 3438.
- Each read completion called requestResponse. That method checked whether a
  response was active, but did not wait for pending tools. The first result could
  start an answer; the others scheduled another continuation.
- Events 3445 and 3448 are the partial and repeated overviews. The first said the
  child outputs were still loading. The second repeated the editor summary and
  added the two child reviews. No new user request occurred between them.

The deterministic three-read replay failed before the change: a response started
with only one result. It passes after the change, with one response after all
three results and no extra response after the summary ends.

## General rules

A response may continue after both its generation and its requested tool batch
finish. This is a data-readiness rule, not an overview-specific delay. It adds no
fixed timer. A later handoff owns its response; an old handoff cannot clear a new
user's pending answer. Interruption still prevents stale reads from reviving work.

For summaries and comparisons, the prompt requires the checks needed to support
the conclusion. Discovery metadata is not a verified overview. One acknowledgment
is enough; routine reads do not need narration. A useful partial result must state
its missing evidence. The runtime cannot know which additional checks the model
should have requested, so that part remains prompt guidance.

By default, a thread means the parent workstream plus its child work. Use the
parent for overview, navigation, and messaging. Child work can inform the parent's
status without being listed as separate work. A request for child-level detail,
including a specifically named child, can opt in. Broad target discovery defaults
to non-archived parents; both children and archives remain available explicitly.
Thread reads include parent metadata for resolving the hierarchy.

## Decisions and limits

- Reuse the pending-tool count and the coalesced continuation flag instead of a
  new timer or overview state machine. Confidence: high. Tests cover the exact
  race, a final handoff, interruption, and a newer request arriving during an old
  handoff. This does not stop a model from speaking a premature conclusion before
  it calls its tools.
- Filter broad lists at the SDK boundary with archived and parent filters; apply
  the same eligibility checks to search results. Confidence: high. An alternative
  was prompt-only filtering of a flat list. Results remain bounded; a capped
  search may omit a parent and must not be described as exhaustive. Hidden threads
  stay hidden even with both opt-ins.
- Route general workstream overviews and tours to the coordinator, which already
  has voice_overview and can inspect family context. Confidence: medium. This can
  cost more than a single live read, but avoids making a broad answer from a target
  picker. Small, specific checks remain available to the live model.
- Edit only the changed paragraphs in saved prompts, after matching their current
  versions. Confidence: high. User edits elsewhere remain intact. The coordinator
  prompt remains within the host's 4,096-character limit.

I stand behind these changes within these limits. They address tool-result timing
and discovery scope. They do not claim to prove the model's spoken summaries or
its choice of necessary checks.

## Acceptance checks

1. Three reads, completed at different times, produce one continuation only after
   all results have been posted.
2. A final handoff consumes an earlier read continuation; it does not cause a
   duplicate answer. A newer user request is not consumed with the old handoff.
3. Interruption prevents a late read from answering an old request.
4. Broad lookup returns current parents. Explicit child/archive flags work for
   list and search, without exposing hidden threads.
5. In a physical call, an overview groups work under parents and avoids repeating
   a partial overview. An explicit request to inspect a child still works.

Checks 1–4 are automated. Check 5 remains a user test.
