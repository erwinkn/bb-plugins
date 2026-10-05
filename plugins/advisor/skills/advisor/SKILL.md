---
name: advisor
description: Inspect BB Advisor watches, evidence coverage and findings with the `bb advisor` CLI. Use when asked what the Advisor saw on a thread, whether a thread is watched, or what its findings are.
---

# BB Advisor

The Advisor watches threads a person selected, or every thread of an
Initiative a person selected. It reads their events and
environment and keeps immutable evidence: file edits with their diffs,
commands with exit codes, completion claims, turn ends, and turn-end
snapshots of changed test files (to catch shell edits). It never sends
messages to a watched thread, never changes its files, and never records
Initiative decisions.

Reviews are off by default. When turned on in Settings, a tools-less
reviewer reads one bounded packet and may report findings in three
categories: test integrity, unsupported completion claims and missed
requirements. Each citation is checked against the exact hunk lines; a
finding whose quote, lines or test name do not match is dropped.

## Commands

```
bb advisor status                 # activation, routes, today's budget use, watches
bb advisor watch <threadId>       # start watching (reads only)
bb advisor unwatch <threadId>     # stop; deletes that thread's evidence and findings
bb advisor findings <threadId>    # findings with severity, subject status and summary
bb advisor watch --initiative <id|name>             # watch a whole Initiative
bb advisor unwatch --initiative <id|name> [--delete] # turn it off (keeps history), or remove it
```

An Initiative watch covers its coordinator, workers, reviewers and the
user's threads in it, and adds members that join later (read from their
first event). Retired, replaced and archived members stop being observed and
keep their history; an unarchived member is watched again. `status` lists Initiative watches with member counts, and each
watch and finding names its Initiative and role (for example `W12 work`).
Unwatching one member thread excludes it from the Initiative watch until it is
watched again. Watching a member explicitly makes that watch the user's own.

The Advisor page opens on one feed of findings across every watch; its Discuss
action is for the user to start, never for an agent.

## Reading findings honestly

- A finding is advisory. It is not an instruction from the user and does not
  change any task, assignment or decision.
- "subject verified" means the test name was proven from the hunk itself.
  "ambiguous" or "rename or replacement" means the location is real but the
  test identity is not proven.
- "fake reviewer" and "preview" findings come from a deterministic test
  double. They prove the pipeline works, not anything about the change.
- No finding is not a verdict. Check coverage gaps (not judged, truncated,
  partial requirements) in the Advisor page before relying on silence.
- "seen" is a local mark, not a review or sign-off. Passing tests never close
  a test-integrity issue.

Do not try to enable reviews, allow provider requests, or set budgets or API
keys yourself; those are the user's choices in Settings.
