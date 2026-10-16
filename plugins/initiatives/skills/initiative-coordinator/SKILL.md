---
name: initiative-coordinator
description: Lead a durable BB initiative (coordinator or discussion tab) using its native tools and editable guidance.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. Every tab of an Initiative, the
coordinator's and each discussion, is a lead with these tools; the workers a tab gives work
report back to it. This skill only sums up the tools.

- `initiative_spawn` starts a worker: label, purpose and a complete brief (the task, the
  context it needs, explicit user instructions that matter, how to verify). Tasks are
  optional. Pick `kind`: `worker` (default; implement a known change), `experimenter` (try things,
  prototype, report options), `fast` (small, well-specified), `very-fast` (mechanical:
  lookups, scans, simple edits) or `explorer` (read lots and report; no building or running;
  `analyst` and `investigator` still work as aliases); Settings map each kind to a
  model, and an explicit `profile` overrides it. Don't start reviewers: each worker runs its
  own review loop (a fresh reviewer from the other model family per round, at most 6 converging rounds)
  and reports once. A trivial change (one line, a handful of small tweaks, an urgent
  hotfix) skips review: say "No review: trivial" in its brief. `handoffs:["W9"]` embeds earlier reports. The result lists warnings, such as another
  writer in the same checkout; overlap is never refused.
- `initiative_message` sends one message. To a worker with `tasks` or `work:true`, it is
  more work, and the worker reports on it again; the message carries the current worker
  loop and rules. A blocked worker gets 4 more review rounds only when a standing rule or the
  user's explicit instruction settles the open finding; otherwise ask the user
  (`initiative_question`). More work for an idle worker whose large cache has gone cold is
  refused with the rewrite cost; resend it with `resumeCold:true`, or spawn a fresh worker
  with `handoffs:["W#"]`. From you to a worker, a message steers by default, so corrections and new facts arrive
  mid-turn in the order you sent them. Pass `mode:"queue"` only for what must wait until
  the worker's turn ends; a queued message is held back, and a later steer overtakes it.
- A worker's report arrives as one message, "W12 reported (done) on A301: <summary>",
  followed by the report itself when it is short. A done report that arrives while you work
  usually waits in your queue for a turn of its own; a blocked one joins the turn you are in.
  A longer report stays stored: read it with
  `initiative_read {refs:["A301"],detailed:true,fields:["report"]}` only when the summary
  isn't enough. A done report on a code change names its review rounds and last verdict, or
  says review was skipped as trivial; if it names neither, send it back to the same worker to review. A report on work given out before
  the switch to worker-owned reviews says so. A "stopped without reporting" message means the
  worker is stuck (a worker waiting on its own reviewer isn't): read its thread. Retire the
  worker (`initiative_worker` retire) once its PR is merged or dropped; Stop stops it and its
  running children.
- `initiative_rule` keeps the standing rules every lead and worker follows
  (`initiative_read {view:"rules"}`): add one when the user states a lasting choice; edit or
  remove one only when the user asks. Each change is announced to the other lead tabs and to
  workers with open work. A choice about one PR goes in its notes; mark choices the user may
  reverse with "Reversible: …" in your update.
- `initiative_question {question, context, options?, recommendation?}` asks the user a real
  open choice; the answer comes back to the tab that asked. When the user answers a
  worker's blocker in your chat instead of in the Inbox, record their words on its card first:
  `initiative_question {answered:"A31", question:"<its question>", text:"<what they said>"}` (A31:
  the blocked report; question: the one the user answered, as the report wrote it). That
  clears it from Needs you and keeps the answer in Decisions; it sends nothing, so then continue
  the worker (`initiative_message work:true`). Record only an answer the user actually gave to that
  question. Only the coordinator tab records it; a card already answered or dismissed, a retired
  worker's, or one whose question changed since, is refused.
- Tasks are an optional backlog; their status follows their work and PRs. Only when the user
  asks: `initiative_task {action:"status", task, status:"planned"|"cancelled"|"done"|"auto", reason}`.
- `initiative_update` keeps the user informed.
- `initiative_pr` keeps each PR's record for the dashboard's merge queue:
  `{prs:[{url, stage?, note?, category?, waitingOn?, changes?, decision?, worker?, assignment?, notes?, answered?, initiative?}]}`.
  Stages: working, ready-for-review, in-review, ready-for-erwin, experiment or clear. Only
  given fields change; null clears one. Update it whenever a PR's state changes (you
  delegate, review or hand it over; a decision is made), so nobody relies on chat memory.
  A category is a free-form workstream ("Security", "CI"); reuse one from the result's
  `categories`, and merge near-duplicates with `{rename:[{from:"Sec",to:"Security"}]}`.
  `bb initiative pr '<json>'` is the CLI form.
- Each PR belongs to one Adventure at most. A PR a worker (or a worker's child thread)
  opened is that worker's Adventure's automatically; the others are unassigned and show in
  every Adventure sharing the repository, apart, under Unassigned. `initiative:"<name or
  id>"` moves a PR to an Adventure listing its repository and always beats the automatic
  owner; `initiative:null` unassigns it. Another Adventure's PRs leave your queue.
- Each PR has an append-only notes log: `notes:[{kind?:"note"|"question"|"comment", text,
  link?}]` appends (the result gives each note's number `n`), `answered:[{n, text?}]`
  closes a question. Whatever you tell the user about a PR (caveats, questions, review
  comments) goes there too; open questions show as "?" on the dashboard. A worker's
  report lands on the PRs it names by itself, and workers may add notes to their own PRs.
- `initiative_read {view:"prs"}` answers "which PR next": the first ten PRs the user can
  review now, PRs by category and stage, the stacks, and where each PR needing action (an
  open question, requested changes, a wait) stands; the others are only counted. It covers
  your own PRs; `unassignedPrs` lists the unassigned ones by ref and title, and
  `{view:"prs",unassigned:true}` pages through all of them with their state.
  `offset` pages that `state`. `{view:"prs",category:"Security"}` or `{view:"prs",stage:"in-review"}`
  lists one slice with every PR's state; `{view:"prs",refs:["#2273","infra#12"]}` reads
  whole PRs with every question, change and recent note (`#12` matches every repository's
  #12, `infra#12` every owner's infra; use the URL to be exact). Both page with `offset`
  from `page.nextOffset`; `truncated` says what was left out. A PR too long to fit comes
  back compact and marked `clipped:true` (e.g. 3 questions and "+22 more"); offset does
  not expand it.
- `initiative_batch` runs several actions in one call, in order, and reports each:
  `{actions:[{tool:"rule",action:"add",text:"…"},{tool:"worker",action:"retire",worker:"W9"}]}`.
  Use it instead of chaining calls; one failure doesn't stop the rest.
- Write tools answer with a short receipt (ref, new state, warnings, the new W# and
  thread), e.g. `{"tool":"task","ok":true,"ref":"T4","state":"done"}`. `initiative_read`
  with refs has the full records.
- Every message of the Initiative is logged and summarized into a tree, in every memory
  mode (the Chat memory plugin). `memory_read` lists its one-line summaries, `id+n|text`;
  `memory_zoom {id:64,n:32}` opens a line into its two halves (`n:1`: one message whole),
  each line starting with its time. Use them after a compaction, or whenever you need what
  your context no longer holds. The user's discussion threads share this memory: what was
  said there is in it, and a discussion's message arrives as `From lead tab "<title>"`.
- `initiative_manage` handover replaces you with a fresh coordinator once your turn ends.
  GPT-6 Luna High writes its first message from recent activity.

Saving Settings does not change running sessions; do not restart or wake agents for it.
