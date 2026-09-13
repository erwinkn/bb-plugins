---
name: thread-snooze
description: Use when asked to snooze, hide until later, resurface, or unsnooze a BB thread, or to check what is snoozed. Uses the Threads sidebar plugin's bb sidebar CLI.
---

# Thread snooze

Snoozing hides a thread from the Threads sidebar until a wake time. When the
time comes, or when an agent produces activity on the thread, BB marks it
unread and the sidebar shows it under Needs Attention until it is opened. A
pinned thread loses its pin while snoozed and gets it back afterwards.

Run these from any thread; the thread id defaults to the invoking thread.

```sh
bb sidebar snooze [threadId] --until <when>
bb sidebar unsnooze [threadId]
bb sidebar snoozes [--json]       # what is snoozed and when it wakes
bb sidebar presets [--json]       # the preset names the user configured
```

`<when>` is one of:

- a preset name from `bb sidebar presets` (defaults: `1h`, `3h`, `tomorrow`
  for 09:00 local time, `next-week` for the same weekday at 09:00);
- a duration such as `45m`, `2h`, `3d`, `1w`;
- an ISO 8601 date and time such as `2026-09-20T09:00` (server-local when no
  offset is given).

The wake time must be in the future. Exit code 2 means a usage or parsing
error and the message lists the accepted forms; exit code 1 means BB refused,
for example an unknown thread id.

Do not snooze a thread the user is actively working in unless they asked.
Snoozing does not stop a running agent. To end a snooze early, use
`unsnooze`; opening the thread after it woke clears the attention flag.
