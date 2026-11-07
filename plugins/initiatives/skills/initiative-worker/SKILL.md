---
name: initiative-worker
description: Work on a BB Initiative assignment using its editable guidance and native tools.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. Your brief ends with the reviewer
command and the standing rules; every later work message ends with the whole loop (the
current instructions, the reviewer command and the rules), which replaces anything earlier.

- You own your change to a clean review. Implement and verify it, then review it in rounds
  with the repository's own review-loop skill when it has one (such as autoreview), which
  decides what each round checks and when the loop stops. Each round has one fresh reviewer
  from the other model family, running the code-review skill, started as a BB child thread
  with the reviewer command in your brief (`--parent-self --lifecycle-owner-thread
  "$BB_THREAD_ID"`, in your checkout). Ask it for a verdict (correct or needs attention) and
  findings ranked P1 to P3, grouped by root cause with every instance. If it can't run (usage
  limit, model unavailable), the plugin reruns it on the fallback and tells you until when to
  use it (no fallback command in your brief: report blocked); name those rounds in your
  report. Copy the standing rules that matter for its job into its brief. While it runs, end
  your turn: its final message wakes you, and ending a turn reports nothing. Waiting on a
  child, a background job or a watched PR, each of which will wake you,
  is the only reason to end a turn without a report.
- A trivial change (one line or a handful of small tweaks), or one whose brief says "No
  review", skips the review loop: verify it and report done with "review skipped (trivial)".
- Fix the findings you agree with. A disagreement goes, with your evidence, into the next
  reviewer's brief and a PR note; a standing rule settles a dispute it covers.
- With no such skill, the plugin's default loop: before round 1, for every branch, filter,
  check or field the change deletes or moves, say where its behaviour lives now or why
  nothing needs it. Fix each root cause and sweep the whole change for its other instances,
  then ask the next reviewer whether each cause is closed and the delta is clean. Keep going
  only while each round has fewer and smaller findings and none caused by the previous fix.
- A review is clean when the verdict is correct with no P1 or P2. No fixed number of review
  rounds. Once only P3s remain, fix the cheap ones, list the rest in your PR notes and report
  done; don't re-review to confirm P3 fixes. If your brief asks for an expert second reviewer
  (Fable 5.1, or Muse Wonder Full: muse-wonder-full-1.0, xhigh), consult it once, after the
  first has passed the head; if it asks for a design first, the expert reviews that design
  once before you code. Report done when the last verdict is clean. Stop and report blocked,
  with each open finding, your view, the options and the design cause you suspect, when the
  loop stops converging, the review-loop skill would ask the user, or the scope creeps. When
  a rule or the user's instruction settles the finding, your lead sends you back to review.
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
- `initiative_pr_watch {pr}` after you open or push a PR: the plugin then wakes you when it
  changes on GitHub (checks failing, required checks passing, new comments or reviews, a
  conflict, no check 15 minutes after a push), until it merges or closes. End your turn while
  you wait: your lead isn't told you stopped. The answer shows the PR as it is now, which wakes
  nobody later: handle a failure, a conflict or checks that already passed at once.
  `initiative_pr_unwatch {pr}` once you hand the PR off or stop caring. Never wait on CI
  yourself (sleep, loops, `gh pr checks --watch`).
- Report blocked when you can't go on, a question included: never ask it in a plain message
  and then stop, since nothing wakes you and nothing shows on the dashboard. A question for
  your lead goes in the summary, and your lead decides what happens next. If only the user
  can answer something, add `question`, `options`
  (`[{label, consequences}]`) and `recommendation` (start it with the option's label). Your
  lead asks the user and continues you with their answer.
- `initiative_message {to:"lead", text}` is for facts your lead needs now while you keep
  working; `to:"W4"` reaches a peer. No progress pings. `to:"coordinator"` also reaches your lead.
- `initiative_read {view:"rules"}` lists the standing rules; `{refs:["W4"]}` reads a peer
  and its latest report.
- An adopted thread whose tools predate the switch uses the shell until its session
  restarts: `bb initiative report '<json>'`, `bb initiative pr '<json>'`,
  `bb initiative message '<json>'`.
