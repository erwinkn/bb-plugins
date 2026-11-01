---
name: chat-memory
description: Read this thread's chat memory (log, summary tree, memory view) with memory_read, memory_zoom and the bb chat-memory CLI.
---

# Chat memory

Every message of this thread (and of the other threads that share its memory, such as an
Initiative's coordinator and its discussion threads) is logged and summarized into a binary tree
of one-line summaries. Compaction preserves the saved log. Canonical source availability depends on BB retention.

- `memory_read`: the memory view, "id+n|text" lines, oldest first (16–32 KB). Read it after a
  compaction, or whenever you need older detail.
- `memory_zoom {id, n}`: open line id+n into the two lines it was made from; `n: 1` gives
  original semantic evidence in bounded pages. Pass the returned `offset` to continue. Pass
  `attachment` with a listed attachment index to retrieve an image or text file. Source references
  and availability are explicit; missing retained output is never described as whole.

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

A memory's mode follows its role and nobody switches it (R3): an Adventure coordinator or private worker scope owned by Initiatives is
UniiChat, every personal scope stays Regular. Agents never write it, and no tool or command does.

- Regular: one long session, compacted past 300k tokens.
- UniiChat: each turn is a fresh session over the memory view (Claude Code only). When the view
  is preparing, BB queues the message durably. Final admission has a bounded deadline and
  cancellation; a failure preserves the message and never runs the old session.
