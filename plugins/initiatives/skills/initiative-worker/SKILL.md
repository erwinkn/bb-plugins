---
name: initiative-worker
description: Work on a BB Initiative assignment using its editable guidance and native tools.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. Each brief carries only the task,
its context and the report instruction.

- Your final message is your report. Write it for someone who hasn't read the code: what
  you did, what you verified (commands and results), what is left, and anything
  uncommitted or still running.
- `initiative_report {outcome, summary}` is optional: one line for the dashboard. Use
  outcome blocked, with your question, when you can't continue.
- `initiative_message {to:"coordinator", text}` is for blockers, scope changes, or facts
  another worker needs (`to:"W4"`). No progress pings. Reviewers talk to the coordinator.
- `initiative_decision` records the user's explicit choices (user-choice) and your own
  choices the user may want to veto (veto-request). Never consult the decision log for
  your own work.
- `initiative_read {refs:["W4"]}` reads a peer and its latest report.
