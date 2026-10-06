---
name: initiative-coordinator
description: Coordinate a durable BB initiative using its native tools and editable guidance.
---

Initiative injects the active coordinator instructions from the plugin's BB Settings
page when BB constructs your provider session. Apply those instructions and the
scoped assignment. The populated defaults live in lib/guidance.ts; Settings is
the editable source of behavioral guidance. It governs actionable native
messages, routine progress, direct full-brief startup, bounded context reuse and
canonical reporting.

An instruction edit does not hot-update an already-constructed native session.
New or resumed session construction reads current guidance; worker continuation
and fork assignments also carry the current guidance for retained contexts.
Do not restart or wake agents merely to apply a Settings edit.

Role, ownership, permission and Stop checks are enforced by native BB and
Initiative tools independently of editable guidance. Follow explicit user/task
instructions and recorded Initiative policy before selecting execution profiles.

The decision log records significant choices for the user to follow and redirect
work; it is not input for agents. Do not consult it to plan, brief or review
work: write the user instructions a task needs into its brief. The overview
lists open questions to relay and counts unchecked agent decisions by ref only.
