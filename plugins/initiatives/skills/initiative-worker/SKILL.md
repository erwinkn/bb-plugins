---
name: initiative-worker
description: Work on a BB Initiative assignment using its editable guidance and native tools.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. Your brief ends with the reviewer
command and the standing rules; every later work message ends with the whole loop (the
current instructions, the reviewer command and the rules), which replaces anything earlier.

- You own your change to a clean review. Implement and verify it, then review it with the
  code-review skill: each round a fresh reviewer from the other model family, started as a
  BB child thread with the reviewer command in your brief (`--parent-self
  --lifecycle-owner-thread "$BB_THREAD_ID"`, in your checkout). Copy the standing rules that
  matter for its job into its brief. While it runs, end your turn: its final message wakes
  you, and ending a turn reports nothing.
- A trivial change (one line or a handful of small tweaks), or one whose brief says "No
  review", skips the review loop: verify it and report done with "review skipped (trivial)".
- Fix the findings you agree with. A disagreement goes, with your evidence, into the next
  reviewer's brief and a PR note; a standing rule settles a dispute it covers.
- At most 4 review rounds. Report done when the last verdict is clean; still rejected after
  round 4, report blocked with each open finding, your view and the options. Your lead may
  grant 4 more rounds when a rule or the user's instruction settles the finding.
- Finish with `initiative_report {outcome, summary, report}`, the only thing that ends your
  work. It goes to your lead, the tab that gave you the work. The summary stands on its own:
  outcome, PR URL and head, review rounds and last verdict, what you need. `report` is your
  full report: what you did, what you verified (commands and results), what is left, and
  anything uncommitted or still running.
- `initiative_pr {prs:[{url, stage?, notes?:[{kind?:"note"|"question"|"comment", text}]}]}`
  keeps your own PRs' stage (set `ready-for-erwin` after a clean review) and notes, on PRs
  your assignment names or your branch opened. Your report's summary is added to the PRs it
  names by itself.
- `initiative_message {to:"lead", text}` is for blockers or facts your lead needs now;
  `to:"W4"` reaches a peer. No progress pings. `to:"coordinator"` also reaches your lead.
- `initiative_read {view:"rules"}` lists the standing rules; `{refs:["W4"]}` reads a peer
  and its latest report.
- An adopted thread whose tools predate the switch uses the shell until its session
  restarts: `bb initiative report '<json>'`, `bb initiative pr '<json>'`,
  `bb initiative message '<json>'`.
