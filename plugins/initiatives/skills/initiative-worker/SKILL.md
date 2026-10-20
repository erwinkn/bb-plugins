---
name: initiative-worker
description: Work on a BB Initiative assignment using its editable guidance and native tools.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. Your brief ends with the reviewer
command and the standing rules; every later work message ends with the whole loop (the
current instructions, the reviewer command and the rules), which replaces anything earlier.

- You own your change to a clean review. Implement and verify it, then review it with the
  code-review skill: each round one fresh reviewer from the other model family, started as a
  BB child thread with the reviewer command in your brief (`--parent-self
  --lifecycle-owner-thread "$BB_THREAD_ID"`, in your checkout). Ask it for a verdict (correct
  or needs attention) and findings ranked P1 to P3. Copy the standing rules that
  matter for its job into its brief. While it runs, end your turn: its final message wakes
  you, and ending a turn reports nothing. Waiting on a child or a background job that will
  wake you is the only reason to end a turn without a report.
- A trivial change (one line or a handful of small tweaks), or one whose brief says "No
  review", skips the review loop: verify it and report done with "review skipped (trivial)".
- Fix the findings you agree with. A disagreement goes, with your evidence, into the next
  reviewer's brief and a PR note; a standing rule settles a dispute it covers.
- A review is clean when the verdict is correct with no P1 or P2. No fixed number of review
  rounds: keep reviewing while the P1s and P2s converge. Once only P3s remain, fix the cheap
  ones, list the rest in your PR notes and report done; don't re-review to confirm P3 fixes.
  If your brief asks for a second reviewer (Fable 5.1), consult it once, after the first has
  passed the head. Report done when the last verdict is clean. Stop and
  report blocked, with each open finding, your view and the options, on whack-a-mole (P1s,
  or P2s that keep reappearing in the same area round after round) or on scope creep. When a
  rule or the user's instruction settles the finding, your lead sends you back to review.
- Finish with `initiative_report {outcome, summary, report}`, the only thing that ends your
  work. It goes to your lead, the tab that gave you the work. The summary stands on its own:
  outcome, PR URL and head, review rounds and last verdict, what you need. `report` is your
  full report: what you did, what you verified (commands and results), what is left, and
  anything uncommitted or still running.
- `initiative_pr {prs:[{url, stage?, notes?:[{kind?:"note"|"question"|"comment", text}], initiative?}]}`
  keeps your own PRs' stage (set `ready-for-erwin` after a clean review) and notes: PRs your
  assignment names, you opened, or no one else holds yet. Your report's summary is added to the PRs it
  names by itself. A PR your thread (or its child) opened belongs to your Adventure;
  `initiative:"<name>"` moves one elsewhere, `initiative:null` unassigns it.
- Report blocked when you can't go on, a question included: never ask it in a plain message
  and then stop, since nothing wakes you and nothing shows on the dashboard. A question for
  your lead goes in the summary, and your lead decides what happens next. If only the user
  can answer something, add `question`, `options`
  (`[{label, consequences}]`) and `recommendation` (start it with the option's label). The
  user picks an option, or writes their own, on the Adventure's Inbox; the answer comes back
  to you or to your lead.
- `initiative_message {to:"lead", text}` is for facts your lead needs now while you keep
  working; `to:"W4"` reaches a peer. No progress pings. `to:"coordinator"` also reaches your lead.
- `initiative_read {view:"rules"}` lists the standing rules; `{refs:["W4"]}` reads a peer
  and its latest report.
- An adopted thread whose tools predate the switch uses the shell until its session
  restarts: `bb initiative report '<json>'`, `bb initiative pr '<json>'`,
  `bb initiative message '<json>'`.
