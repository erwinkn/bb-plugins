# Chat memory

One chat that never ends, for any BB thread: every message is logged, GPT-6 Luna
summarizes the log into a binary tree of one-line summaries, and the agent reads
the tree back as a memory view and zooms into any line, down to the message
itself. It follows Victor Taelin's
[OptChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
(D459). Plugin id `chat-memory` (`memory` is BB's own durable-memory plugin).

It took over the Initiatives plugin's coordinator memory in T145 (D457): the log,
the tree, the modes, the memory tools and Claude Code's per-turn hook.
Initiatives only tells it which threads share an Initiative's memory.

## Scopes

A **scope** is one memory: one log, one tree, one mode, one compaction limit. Its
id is `<owner plugin>:<key>`.

- A plugin registers a scope and its current threads with the `setScope` RPC
  (plugins only; the caller is the owner). Initiatives registers
  `initiatives:<initiative id>` with its coordinator (and a coordinator being
  started); D446's discussion threads join the same scope. Workers never do.
  `threads: []` closes a scope: its log and tree stop and stay. `hold: true`
  holds its automatic compaction (a paused Initiative).
- An owner names the scope a thread it spawns will join in its own metadata on
  the thread, `{memoryScope: "<key>"}`, so the thread's first turn can wait for
  the registration instead of running without memory (below).
- A user can turn memory on for any other thread from its **Memory** panel: the
  thread gets its own scope, `chat-memory:<thread id>`, in Regular mode.

A thread is current in one scope at most. A thread an owner no longer lists is
retired: it is still read until it is quiet, so its last messages land, then
done.

## Modes (D431, D447)

The tree builds in every mode, so a switch is instant and applies from each
thread's next turn. One path per mode (D459):

| Mode    | A turn                                     | Compaction (idle, past)         |
| ------- | ------------------------------------------ | ------------------------------- |
| Regular | the thread's session goes on               | `regularCompactTokens`, 300k    |
| Hybrid  | the thread's session goes on               | `hybridCompactTokens`, 150k     |
| OptChat | a fresh session over the memory view        | never: a session never grows    |

A scope's own `compactTokens` wins over the setting for its mode; 0 is off.
Compaction runs after a current thread goes idle with BB's `threads.compact`,
once per context snapshot and at most every 30 minutes per thread, and never
while the scope's owner holds it. A failed compaction is never counted as done:
the thread's status keeps its error (a problem on the pill until one succeeds),
and the sweep tries the same snapshot again 2 minutes later, 3 times at most; a
later turn's snapshot starts over. Reading the context size is part of it: a
failed read is kept and shown the same way ("reading its context size failed:
…"), read again 2 minutes later by the sweep (3 times) and after each later
turn, and cleared by a read that works.

**Who switches (D452, D461).** Only the user, from the thread header's
**Memory · <mode>** pill or the thread's Memory panel. The `configure` RPC refuses
plugin callers; no agent tool or CLI command writes. BB gives a client RPC no
finer identity, so a local caller who knows the method can still reach it
(accepted).

**OptChat runs on every turn, or the turn fails (D458, D460, A471).** What
enforces the mode is the turn itself, not a gate in front of some of them. BB
resolves a thread's tools for every turn it starts, whatever started it: a
message, a queued one, BB's notice to a parent thread (a child finished), Send
now, a retry. Erwin's fork sends those tools with the turn (FORK.md, "per-turn
context from a hidden tool"), and:

- on Claude Code, a turn whose tools include `claude_code_turn_context` asks it
  how to run, however its session was built (an imported coordinator's, one
  built while memory was off, one built while another plugin held the hook);
- every other provider refuses a turn whose tools include it, with the reason
  in the thread, and never shows it to its model.

So this plugin selects the hook, whenever it holds it, for every Claude Code
thread of a scope in every mode (Regular and Hybrid answer `{}`: the session
goes on), and for a thread on another provider only while its scope is in
OptChat: each of its turns is then refused until the mode changes (Codex support
is T146). A thread that joins an OptChat scope later, or a memory turned back on
in OptChat, keeps the mode and needs nothing more.

The switch to OptChat is refused, with the reason, when a current thread runs on
anything but Claude Code, when another plugin still holds the turn hook, or when
BB's Claude Code provider is older than protocol 4 (a turn asked with protocol
3): that provider decided by the tools a session was built with, so a session
built without the hook would not ask. On it, OptChat turns that do ask fail and
OptChat messages are refused, until BB restarts with the new provider. Each
thread's status shows when its last turn asked and with which protocol
(`askedAt`, `askedProtocol`), which is how a cutover checks the provider.

**The turn gate.** Chat memory also answers BB's `message.dispatch` hook, which
runs before a message reaches a provider, to refuse early, with the reason, what
would fail anyway: an OptChat message to a thread on another provider, or on a
provider older than protocol 4. BB keeps the message (a queued one keeps its row
and shows the reason; a new one is handed back). What may pass (the hook still
held by another plugin, a failed read of where a new thread goes) holds the
message 5 s at a time, 3 times in all, with the reason on its row, then refuses
it. Messages that join a running turn, and every other thread's, go on.

## OptChat turns (D431 phase 2, D458)

BB's Claude Code provider (Erwin's fork) calls the hidden tool
`claude_code_turn_context` before each new turn whose tools include it
(protocol 4: `{input, requestId, sessionId}`; protocol 3, the fork before T145,
asked only in sessions built with it and also sent outcome reports, which are
ignored). The answer is `{}` (the session goes on) or
`{session: "fresh", sessionId, systemPrompt, input}`. A protocol 3 ask in an
OptChat scope fails (above).

An OptChat turn, as in the gist (§6):

1. finds the turn's request among the thread's last 300 requests;
2. reads the log through it, at most 3 failed reads;
3. waits until every earlier message is summarized;
4. answers a fresh session: the system prompt ends with the OptChat prompt and
   the view's older lines (kept turn after turn, so the prompt and the fork's
   session seed stay cached), and the first message holds the newest lines, the
   time and the message after "New message:".

Steps 2 and 3 share one deadline: 90 s for protocol 4 (the fork waits 120 s),
15 s for protocol 3 (it waited 20 s). **Any failure throws**: the provider
fails the turn visibly and keeps its message, never runs it in the old session.
For example, with the summarizer rate-limited:

> OptChat memory unavailable for this turn: 3 earlier messages have no summary
> yet: the summarizer is rate-limited (429 …). The message was not sent; send it
> again, or switch this thread's memory mode.

Leaving OptChat needs nothing: the thread's session is the last fresh one, whose
system prompt holds the view, and it goes on.

A new top-level thread of a plugin that owns scopes (a new coordinator) gets the
memory tools and hook when its session is built, before its owner can register
it. On another provider, its tools follow the scope its owner's metadata names
(`memoryScope`, which BB's fork gives every plugin's configure as
`origin.pluginMetadata`): in OptChat they have the hook (unless it was in that scope and left), so BB refuses its turns
on every path, Send now included, before its owner adds it (A473). Where BB does
not give that metadata, such a thread is treated as OptChat. On Claude Code, its
first turn tells a membership still to come from none: if its owner's
metadata names an OptChat scope, the turn waits for the registration until its
deadline, then fails; with no `memoryScope`, or one in another mode, or once it
left that scope, the session goes on at once. A thread or metadata read that
fails is tried again (3 times), then fails the turn. A retried turn's original
request is read the same way: a failed read fails the turn, never a wrong cut.

**The hook across reloads.** BB skips a tool registration whose name another
loaded plugin holds, and takes a registration later. While the Initiatives
plugin before T145 holds `claude_code_turn_context`, this plugin's part of a
thread's tools has no hook (a configuration BB accepts; Initiatives adds its
own), and OptChat messages are held at the gate, then refused. The gate, the
owner's `setScope`, the user's switch and the 30-second sweep register the hook
again: that takes the name the moment its holder lets it go, with no reload of
this plugin, and the next turn's tools have it. Nothing about a session is
remembered, so nothing has to be cleared. Between the moment the holder lets the
name go and the moment this plugin takes it, a turn BB starts without the gate
(a parent notice, Send now) has no hook and runs in its session: the cutover
holds coordinators still through it (below). While a reload stops this plugin,
configure, the gate and resident answers come from the members as it left them;
an OptChat turn fails visibly.

## The log

Append-only, one row per message, across all of a scope's threads, merged by
time, read from BB's own thread events (`client/turn/requested`,
`item/completed`, `turn/completed`, and Claude Code's compaction summary), the
same for every provider. Kinds: `user`, `agent` (replies; lines written before
T145 say `coord`), `tool`, `echo` (results, head and tail within 30,000
characters), `work` (`[name] …` from another thread, by its title; `[bb] …` from
BB, including `[bb] (stopped) …` after a stopped turn), `note` (a plugin's brief
or handover, compaction summaries). Thoughts are never logged; retries of a
request are logged once. It is read when a thread's turn ends, every second
while it works, and by the sweep, which reads the three least recently read
scopes not read for 5 minutes.

## The tree

As the gist and W216: message i becomes a line of at most 512 bytes
(`id+n|text`), adjacent lines merge in pairs; text that fits is kept with no
call. The chat view (what an OptChat turn sees) is a 128→64 KB sawtooth merged
by due = (T+1)/2^l − i; the memory view (`memory_read`, the context of every
summarizer call) is it merged further, 32→16 KB. Both are saved, never rebuilt.
GPT-6 Luna (`summarizerEffort`, high since D484) writes lines with the gist's
compaction prompt and its 512-dash ruler; a line too long is asked again for at
most 384 bytes, up to 5 tries, keeping the shortest (W315: Luna overshoots its
ask, so asking again for 512 took 3.5 calls a line; asking for 384 takes 2.1).
Up to `summarizerConcurrency` (8) calls run at once across every scope,
round-robin by scope, except that the lines an OptChat turn is waiting for, and
their merges, take the next free call before any other scope's backlog (W315).
A call gives up after 30 s, then 60 s, then 120 s for the same line (Luna at
high answers 95% of calls within 30 s), so a hung call frees its slot; a call a
turn waits for runs on to the turn's deadline instead, so a reply at 65 s still
makes a 90 s turn. A stopped turn stops waiting, and a call past its bound
that no turn waits for any more gives up at once. A line whose call fails 3 times
stays unsummarized and failed, never cut to fit (D458): it holds no build slot,
the pill shows it as a problem, an OptChat turn that needs it fails at once
("message 1234 could not be summarized (…)"), and it is tried again 30 minutes
later. Lines Initiatives cut before T145 are imported as they are ("cut after
failures" in the panel). A 429 pauses new calls with a growing backoff; an
unavailable route pauses 10 minutes.

Luna runs through the Account Pooler's isolated plugin route
(`/advisor/v1/responses`), one `session_id` per scope. Calls carry
`x-bb-thread` (the scope's first current thread), `x-bb-initiative` (for an
Initiatives scope) and `x-bb-purpose: memory-tree`, so the Pooler's ledger and
Usage stats attribute the spend.

## Tools and CLI

A current thread of a scope (and a candidate, above) gets, in every mode,
`memory_read` and `memory_zoom {id, n}` (loaded upfront, T143), one line of
guidance, and on Claude Code the hidden hook. Each zoomed line starts with the
UTC time of its first message: `2026-10-08 17:49Z 64+16|…`. Sessions built while
Initiatives owned memory still call `initiative_zoom` and `initiative_read
{view:"memory"}`: Initiatives keeps both as read-only aliases over this plugin's
`zoom` and `read` RPCs.

```sh
bb chat-memory status [thread-id]
bb chat-memory read [thread-id]
bb chat-memory zoom <id> <n> [thread-id]
```

## Settings

`regularCompactTokens` (300,000), `hybridCompactTokens` (150,000),
`summarizerEffort` (high), `summarizerConcurrency` (8).

## The move from Initiatives (T145)

The plugin never reads the Initiatives database at start. One command, at the
cutover, copies its `memory_*` tables once:

```sh
bb chat-memory import-initiatives
```

1. **Snapshot.** It opens `<dataDir>/plugins/initiatives/data.db` read only
   (SQLite `SQLITE_OPEN_READONLY`, through BB's own SQLite) and copies it with
   `VACUUM INTO`, one read transaction, to `initiatives-snapshot.db.partial`
   beside this plugin's database; checks it (`integrity_check`, the memory
   tables); then moves it to `initiatives-snapshot.db` with a manifest
   (`initiatives-snapshot.db.json`: SHA-256, size, source, time).
2. **Import.** It opens the snapshot read only, refuses it if it is the live
   file or does not match its manifest, and copies each Initiative's mode and
   limit, coordinator threads, log (`coord` → `agent`), nodes, and saved views
   with their totals in one transaction, so no summary is paid for twice. The
   import is recorded with the snapshot's path and hash.

The live database is never written; it stays as the rollback, and so does the
snapshot. Until the import, the Initiatives plugin's `setScope` is refused with
the command to run (it sends again at each sweep), so no Initiative gets an
empty memory first. A start that finds a verified snapshot not yet imported
imports it. On a fresh install (no Initiatives database) there is nothing to
import. On a copy of the 2026-10-08 22:12 backup: 11 scopes, 13 threads, 6,120
messages, 12,189 nodes, 11 trees, the source byte for byte unchanged
(`CHAT_MEMORY_IMPORT_DB=<copy> npm test`).

The full cutover, with what holds coordinators still and how to check the
restarted runtimes, is in [CUTOVER.md](CUTOVER.md).

`scripts/memory-replay.ts` builds a tree for a slice of a real thread, read
only, to measure Luna's lines and cost.
