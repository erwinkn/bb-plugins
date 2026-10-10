# Chat memory

One chat that never ends, for any BB thread: every message is logged, GPT-6 Luna
summarizes the log into a binary tree of one-line summaries, and the agent reads
the tree back as a memory view and zooms into any line, down to the message
itself. It follows Victor Taelin's
[OptChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
(D459). Plugin id `chat-memory` (`memory` is BB's own durable-memory plugin).

It took over the Initiatives plugin's coordinator memory in T145 (D457): the log,
the tree, the modes, the memory tools and Claude Code's per-turn hook.

## Scopes and threads (T153)

A **scope** is one memory: one log, one tree, one mode, one compaction limit. Its
id is `<owner plugin>:<key>`. Every thread chat memory meets has one row: the
scope it writes to now (or none) and its **cursor**, the last BB event of it
that is logged. Nothing else is kept per thread or per turn (D487).

- **Spawned into a scope.** An owner names the scope of a thread it spawns in
  its own metadata on the thread, `{memoryScope: "<key>"}`. BB's fork shows it
  to this plugin's configure (`origin.pluginMetadata`), which attaches the
  thread right there, before its first turn. Initiatives does this for its
  coordinators and successors (and D446's discussion threads); workers carry
  no key. Only a thread met for the first time is attached this way, so a later
  move or detach stands.
- **Attached by its owner.** An owner attaches a thread it did not spawn with
  the `attach` RPC (plugins only, to the caller's own scopes): Initiatives,
  when it adopts a thread as coordinator.
- **Turned on by the user.** A user can turn memory on for any other thread
  from its **Memory** panel: it gets its own scope, `chat-memory:<thread id>`,
  in Regular mode, and turning it off detaches it.

Attach, move and detach are one write of the row's scope (D491). What a thread
logged stays in the scope it was logged to; its cursor stays, so its next
completed turns go to the new scope and nothing is logged twice. A former
coordinator stays attached: a later turn of it is logged in the Initiative's
memory (D487).

## Modes (D431, D447)

The tree builds in every mode, so a switch is instant and applies from each
thread's next turn. One path per mode (D459):

| Mode    | A turn                                     | Compaction (idle, past)         |
| ------- | ------------------------------------------ | ------------------------------- |
| Regular | the thread's session goes on               | `regularCompactTokens`, 300k    |
| Hybrid  | the thread's session goes on               | `hybridCompactTokens`, 150k     |
| OptChat | a fresh session over the memory view        | never: a session never grows    |

A scope's own `compactTokens` wins over the setting for its mode; 0 is off.
Compaction runs after an attached thread goes idle with BB's `threads.compact`,
once per context snapshot and at most every 30 minutes per thread (a paused
Initiative's coordinator too: it is idle, so at most one runs, D487). A failed compaction is never counted as done:
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
context from a hidden tool", protocol 4), and:

- on Claude Code, a turn whose tools include `claude_code_turn_context` asks it
  how to run, however its session was built;
- every other provider refuses a turn whose tools include it, with the reason
  in the thread, and never shows it to its model.

So this plugin selects the hook for every thread of a scope in OptChat, and in
no other mode (D490): a switch applies at the next turn either way. A Claude
Code thread's turns then ask for their view; a thread on another provider has
each of its turns refused until the mode changes (Codex support is T146).

The switch to OptChat is refused, with the reason, when a thread of the scope
runs on anything but Claude Code.

**The turn gate.** Chat memory also answers BB's `message.dispatch` hook, which
runs before a message reaches a provider, to refuse early, with the reason, what
would fail anyway: a new turn of an OptChat thread on another provider. BB
keeps the message. Messages that join a running turn, and every other thread's,
go on.

## OptChat turns (D431 phase 2, D458)

BB's Claude Code provider (Erwin's fork) calls the hidden tool
`claude_code_turn_context` before each new turn whose tools include it
(protocol 4: `{input, requestId, sessionId}`). The answer is `{}` (the session
goes on) or `{session: "fresh", sessionId, systemPrompt, input}`. An OptChat
turn:

1. copies the thread's own completed turns (its previous one, and any whose
   idle BB never delivered, say during a reload), at most 3 failed reads;
2. views the scope the thread writes to then: the whole log, since it holds
   completed turns only and this one has not started;
3. shows the newest messages that have no summary yet whole
   (`id+1|kind: text`), up to 32 KB, and waits for the summaries of every
   message before those (D487);
4. answers a fresh session: the system prompt ends with the OptChat prompt and
   the view's older lines (kept turn after turn, so the prompt and the fork's
   session seed stay cached; a message shown whole is never among them), and
   the first message holds the newest lines, the time and the message after
   "New message:".

Steps 1 and 3 share one deadline, 90 s (the fork waits 120 s), and stop as soon
as BB stops the turn. **Any failure throws**: the provider fails the turn
visibly and keeps its message, never runs it in the old session. For example,
with the summarizer rate-limited and more than 32 KB without a summary:

> OptChat memory unavailable for this turn: 3 earlier messages have no summary
> yet: the summarizer is rate-limited (429 …). The message was not sent; send it
> again, or switch this thread's memory mode.

Leaving OptChat needs nothing: the thread's session is the last fresh one, whose
system prompt holds the view, and it goes on.

Two tabs of one memory (a coordinator and a discussion) never wait on each
other: each turn copies only its own thread, and a turn still running in the
other tab is not in the log yet, so it is not in the view.

## The log

Append-only, one row per message, across all of a scope's threads, read from
BB's own thread events (`client/turn/requested`, `item/completed`,
`turn/completed`, and Claude Code's compaction summary), the same for every
provider. Kinds: `user`, `agent` (replies; lines written before T145 say
`coord`), `tool`, `echo` (results, head and tail within 30,000 characters),
`work` (`[name] …` from another thread, by its title; `[bb] …` from BB,
including `[bb] (stopped) …` after a stopped turn), `note` (a plugin's brief or
handover, compaction summaries). Thoughts are never logged.

A thread's events are copied **through its last `turn/completed`** (D487),
which BB writes for every turn that ends: completed, failed or stopped. A turn
in progress waits for its end, and is never read: a copy first looks up the
newest `turn/completed` and pages only up to it. One copy runs per thread at a time; it appends
to the scope the thread's row names when the append commits, and moves the
cursor in the same transaction, so a message is logged once whatever triggers
it. A thread moved mid-turn has that whole turn logged in the new scope
(accepted: which memory a turn "used" is not tracked). Turns of different
threads land in the order they are copied. The requests of a turn that failed
before any output because OptChat could not get its memory are left out (D502:
the `provider/error` of the turn says "OptChat memory unavailable for this
turn"): the model never saw them, BB keeps the text for the user to send again,
and the resend is logged. Any other failed turn (a 429, an overloaded provider)
keeps its requests, so BB's automatic retry finds the question in memory. A
retry itself is never logged: it re-sends a request that is logged already, or
says "Please continue." after it.

Copies run when a thread goes idle, fails, or is archived (its final copy,
D485), before each of its OptChat turns, and from a sweep: at start over every
attached thread, then every 5 minutes over those not archived, copying any
whose last `turn/completed` is past its cursor. BB's announcements are
fire-and-forget; the cursor makes a duplicate copy nothing and a missed one
wait for the next trigger. A thread BB deleted is forgotten. A stop ends the
sweep at once, even mid-read: it touches the database no more.

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
stays unsummarized and failed, never cut to fit (D458), unless every reply was empty
(a retry gets the same): that line is built at once with its text cut to 512 bytes
(its message, or its two lines joined; counted under "fallbacks"). A failed line holds no build slot,
the pill shows it as a problem, an OptChat turn that needs it fails at once
("message 1234 could not be summarized (…)"), and it is tried again 30 minutes
later. Lines Initiatives cut before T145 were imported as they are ("cut after
failures" in the panel). A 429 pauses new calls with a growing backoff; an
unavailable route pauses 10 minutes.

Luna runs through the Account Pooler's isolated plugin route
(`/advisor/v1/responses`), one `session_id` per scope. Calls carry
`x-bb-thread` (the scope's first thread), `x-bb-initiative` (for an
Initiatives scope) and `x-bb-purpose: memory-tree`, so the Pooler's ledger and
Usage stats attribute the spend.

## Tools and CLI

A thread attached to a scope gets, in every mode, `memory_read` and
`memory_zoom {id, n}` (loaded upfront, T143) and one line of guidance; in
OptChat, the hidden hook. Each zoomed line starts with the
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

## The move from Initiatives (T145) and to one row per thread (T153)

T145 copied the Initiatives plugin's `memory_*` tables once, from a verified
read-only snapshot (`bb chat-memory import-initiatives`; [CUTOVER.md](CUTOVER.md)).
That import is done on Erwin's install, so T153 removed it. T153's migration
is additive: it creates the `threads` table and fills it from T145's `members`
(a thread current in a scope keeps that one, else its latest; a personal memory
the user had turned off stays off; the cursor is the furthest any of the
thread's memberships read), and leaves `members`, `scopes.hold`, the log, the nodes and
the trees as they were. Rolling back is reinstalling the T145 code, which reads
`members` again: its cursors stop at the migration, so turns logged since would
be logged a second time (there is no backward migration).

`scripts/memory-replay.ts` builds a tree for a slice of a real thread, read
only, to measure Luna's lines and cost.
