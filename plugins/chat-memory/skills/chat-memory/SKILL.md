---
name: chat-memory
description: Read this thread's chat memory (log, summary tree, memory view) with memory_read, memory_zoom and the bb chat-memory CLI.
---

# Chat memory

Every message of this thread (and of the other threads that share its memory, such as an
Initiative's coordinator and its discussion threads) is logged and summarized into a binary tree
of one-line summaries. Nothing is ever lost: a compaction drops context, never the log.

- `memory_read`: the memory view, "id+n|text" lines, oldest first (16–32 KB). Read it after a
  compaction, or whenever you need older detail.
- `memory_zoom {id, n}`: open line id+n into the two lines it was made from; `n: 1` gives
  message id whole. Each line starts with the UTC time of its first message:
  `2026-10-08 17:49Z 64+16|…`.

Zoom before you act on any detail of the past; live state (threads, tasks, pull requests,
branches, files) moves on, so read it with your tools.

## CLI

```sh
bb chat-memory status [thread-id]     # mode, threads, log, tree, cost, problems
bb chat-memory read [thread-id]       # the memory view
bb chat-memory zoom <id> <n> [thread-id]
```

Without a thread id, the CLI reads the calling thread's memory.

## Modes

The user alone switches a memory's mode and compaction limit, from the thread's Memory pill or
panel (D452). Agents never do, and no tool or command writes it.

- Regular: one long session, compacted past 300k tokens.
- Hybrid: compacted past 150k; what a compaction drops stays one zoom away.
- OptChat: each turn is a fresh session over the memory view (Claude Code only). When the view
  cannot be built in time, the turn fails with its message kept; it never runs in the old session.
