---
name: initiative-worker
description: Work on a BB Initiative assignment using its editable guidance and native tools.
---

Initiative injects the active worker instructions from the plugin's BB Settings
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


Use `initiative_read {view:"workers",limit:8}` for current peer identity/task refs.
`initiative_message {target:"W4",text:"Interface fact",mode:"queue"}` sends one native
message with your trusted sender. Steer urgent blockers/corrections; queue future
facts. Reviewers communicate through coordinator. Messages grant no work, scope or
permission and do not resume finished/stopped contexts. Dependency/ownership/scope
changes and human questions go to coordinator. Routine progress never wakes peers.
An unresolved human choice needs context/options/consequences/recommendation/task
refs; do not infer an answer. Finish with one canonical report and short pointer.

Already-constructed sessions can use `bb initiative message '<json>'`. Inspect
native receipts after an uncertain error before any deliberate new send. Ordinary
children retain native completion notices; genuine forks use canonical report
fallback. This plugin does not mute routine native turn notices.
