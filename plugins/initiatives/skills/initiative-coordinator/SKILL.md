---
name: initiative-coordinator
description: Coordinate a durable BB initiative using its native tools and editable guidance.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. This skill only sums up the tools.

- `initiative_spawn` starts a worker: label, purpose and a complete brief (the task, the
  context it needs, explicit user instructions that matter, how to verify). Tasks are
  optional. Pick `kind`: `worker` (default; implement a known change), `experimenter` (try things,
  prototype, report options), `fast` (small, well-specified) or `analyst` (read lots and
  report; no building or running; `investigator` still works as an alias); Settings map each kind to a
  model, and an explicit `profile` overrides it. A review is `role:"review", reviews:"W12"`; W12's latest report is embedded.
  `handoffs:["W9"]` embeds earlier reports. The result lists warnings, such as another
  writer in the same checkout; overlap is never refused.
- `initiative_message` sends one message. To a worker with `tasks` or `work:true`, it is
  more work, and the worker reports on it again. Reviewers are never reused: work for a
  reviewer is refused. Each review round gets a fresh reviewer; after fixes, spawn one with
  `reviews:"<the latest worker on the change>", handoffs:["<the previous review's A#>"]`.
  Retire a reviewer once you have read its report, unless you first need to ask it a
  clarifying question (a plain message still reaches it).
- A worker's report arrives as one message, "W12 reported (done) on A301: <summary>",
  followed by the report itself when it is short. A longer one stays stored: the message
  ends with `initiative_read {refs:["A301"],detailed:true,fields:["report"]}`; read it only
  when the summary isn't enough. A "stopped without reporting" message means the worker is
  stuck: read its thread. Nothing is accepted or rejected: send fixes back, close the task (`initiative_task` close), and
  retire the worker (`initiative_worker` retire) when its batch is finished.
- `initiative_update` keeps the user informed. `initiative_decision` records the user's
  explicit choices (user-choice), your choices the user may want to veto (veto-request),
  and real questions. The decision log is the user's record; don't consult it to plan.
- `initiative_pr` keeps each PR's record for the dashboard's merge queue:
  `{prs:[{url, stage?, note?, category?, waitingOn?, changes?, decision?, worker?, assignment?, notes?, answered?}]}`.
  Stages: working, ready-for-review, in-review, ready-for-erwin, experiment or clear. Only
  given fields change; null clears one. Update it whenever a PR's state changes (you
  delegate, review or hand it over; a decision is made), so nobody relies on chat memory.
  A category is a free-form workstream ("Security", "CI"); reuse one from the result's
  `categories`, and merge near-duplicates with `{rename:[{from:"Sec",to:"Security"}]}`.
  `bb initiative pr '<json>'` is the CLI form.
- Each PR has an append-only notes log: `notes:[{kind?:"note"|"question"|"comment", text,
  link?}]` appends (the result gives each note's number `n`), `answered:[{n, text?}]`
  closes a question. Whatever you tell the user about a PR (caveats, questions, review
  comments) goes there too; open questions show as "?" on the dashboard. A worker's
  report lands on the PRs it names by itself, and workers may add notes to their own PRs.
- `initiative_read {view:"prs"}` answers "which PR next": what the user can review now,
  PRs by category and stage, the stacks, and where each PR stands with its open
  questions and latest note.
- `initiative_batch` runs several actions in one call, in order, and reports each:
  `{actions:[{tool:"task",action:"close",task:"T4",outcome:"done"},{tool:"worker",action:"retire",worker:"W9"}]}`.
  Use it instead of chaining calls; one failure doesn't stop the rest.
- Write tools answer with a short receipt (ref, new state, warnings, the new W# and
  thread), e.g. `{"tool":"task","ok":true,"ref":"T4","state":"done"}`. `initiative_read`
  with refs has the full records.
- In hybrid memory mode (your instructions then say so), every message of the Initiative is
  logged and summarized into a tree. `initiative_read {view:"memory"}` lists its one-line
  summaries, `id+n|text`; `initiative_zoom {id:64,n:32}` opens a line into its two halves
  (`n:1`: one message whole) and `initiative_date {id:64}` dates a message. Use them after a
  compaction, or whenever you need what your context no longer holds.
- `initiative_manage` handover replaces you with a fresh coordinator once your turn ends.
  GPT-6 Luna High writes its first message from recent activity.

Saving Settings does not change running sessions; do not restart or wake agents for it.
