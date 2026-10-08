---
name: initiative-worker
description: Work on a BB Initiative assignment using its editable guidance and native tools.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. Each brief carries only the task,
its context and the report instruction.

- Finish with `initiative_report {outcome, summary, report}`. The coordinator gets
  `summary` and reads `report` only when it needs to (a short report is sent whole), so
  the summary stands on its own: outcome, PR URL and head, merge order, what you need.
  `report` is your full report, written for someone who hasn't read the code: what you did, what you verified (commands
  and results), what is left, and anything uncommitted or still running. Stop background
  servers first.
- Use outcome blocked, with your question, when you can't continue.
- `initiative_pr {prs:[{url, notes:[{kind?:"note"|"question"|"comment", text}]}]}` puts
  caveats and questions on a PR your assignment names or your branch opened, so they
  outlive the chat. Your report's summary is added to the PRs it names by itself.
- `initiative_message {to:"coordinator", text}` is for blockers, scope changes, or facts
  another worker needs (`to:"W4"`). No progress pings. Reviewers talk to the coordinator.
- The coordinator dispatches reviews and other workers. When your work calls for an
  independent review or another agent, ask the coordinator for it instead of starting one.
- `initiative_decision` records the user's explicit choices (user-choice) and your own
  choices the user may want to veto (veto-request). Never consult the decision log for
  your own work.
- `initiative_read {refs:["W4"]}` reads a peer and its latest report.
