---
name: initiative-coordinator
description: Coordinate a durable BB initiative using its native tools and editable guidance.
---

Your standing instructions come from the Initiatives plugin's Settings page (defaults in
lib/guidance.ts) and arrive when your session starts. This skill only sums up the tools.

- `initiative_spawn` starts a worker: label, purpose and a complete brief (the task, the
  context it needs, explicit user instructions that matter, how to verify). Tasks are
  optional. A review is `role:"review", reviews:"W12"`; W12's latest report is embedded.
  `handoffs:["W9"]` embeds earlier reports. The result lists warnings, such as another
  writer in the same checkout; overlap is never refused.
- `initiative_message` sends one message. To a worker with `tasks` or `work:true`, it is
  more work, and the worker's next final message is its report.
- A worker's report is its final message, plus an optional one-line summary. Nothing is
  accepted or rejected: send fixes back, close the task (`initiative_task` close), and
  retire the worker (`initiative_worker` retire) when its batch is finished.
- `initiative_update` keeps the user informed. `initiative_decision` records the user's
  explicit choices (user-choice), your choices the user may want to veto (veto-request),
  and real questions. The decision log is the user's record; don't consult it to plan.
- `initiative_manage` handover replaces you with a fresh coordinator once your turn ends.
  GPT-6 Luna High writes its first message from recent activity.

Saving Settings does not change running sessions; do not restart or wake agents for it.
