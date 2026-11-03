# Chat memory

One chat that never ends, for any BB thread: every message is logged, GPT-6 Luna
summarizes the log into a binary tree of one-line summaries, and the agent reads
the tree back as a memory view and zooms into any line, down to the message
itself. It follows Victor Taelin's
[UniiChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
(D459). Plugin id `chat-memory` (`memory` is BB's own durable-memory plugin).

It took over the Initiatives plugin's coordinator memory in T145 (D457): the log,
the tree, the modes, the memory tools and Claude Code's per-turn hook.

## Scopes and threads (T153)

A **scope** is one memory: one log, one tree, one mode (its role's), one compaction limit. Its
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

## Modes (D431, D447, R3)

**The mode follows the role; nobody chooses it** (Erwin, 2026-10-17, R3). An
Adventure (Initiative) coordinator's memory, every scope the `initiatives`
plugin owns, is UniiChat. Every other memory is Regular. The scope's mode is read
from its owner each time, never from the stored `mode` column, which only mirrors
it for code that still reads it (a rollback). At every start the plugin sets the
column of every scope to its role's mode, so the scopes that existed before R3
(Verification, Solera, erwinkn.com: Regular; one Hybrid scope) and any an older
version created after a rollback follow too. A compaction error recorded while a
coordinator's scope was Regular is no longer shown, and the sweep skips it. There is no
mode setting, RPC or UI, and Hybrid is gone: the `configure` RPC takes no `mode`
(a request for one fails validation) and `hybridCompactTokens` is no setting.

The tree builds either way. One path per mode (D459):

| Mode    | A turn                                     | Compaction (idle, past)         |
| ------- | ------------------------------------------ | ------------------------------- |
| Regular | the thread's session goes on               | `regularCompactTokens`, 300k    |
| UniiChat | a fresh session over the memory view        | never: a session never grows    |

A Regular scope's own `compactTokens` wins over the setting; 0 is off.
Compaction runs after an attached thread goes idle with BB's `threads.compact`,
once per context snapshot and at most every 30 minutes per thread. A failed compaction is never counted as done:
the thread's status keeps its error (a problem in the Memory panel until one succeeds),
and the sweep tries the same snapshot again 2 minutes later, 3 times at most; a
later turn's snapshot starts over. Reading the context size is part of it: a
failed read is kept and shown the same way ("reading its context size failed:
…"), read again 2 minutes later by the sweep (3 times) and after each later
turn, and cleared by a read that works.

**Who writes (D452).** The thread's Memory panel (turn a personal memory on or
off, set a Regular scope's compaction limit) calls `configure`, which refuses
plugin callers; no agent tool or CLI command writes. BB gives a client RPC no
finer identity, so a local caller who knows the method can still reach it
(accepted). The thread header has no memory entry any more; the panel shows a
memory's mode, problems, threads, log, tree and cost read-only.

**UniiChat runs on every turn, or the turn fails (D458, D460, A471).** What
enforces the mode is the turn itself, not a gate in front of some of them. BB
resolves a thread's tools for every turn it starts, whatever started it: a
message, a queued one, BB's notice to a parent thread (a child finished), Send
now, a retry. Erwin's fork sends those tools with the turn (FORK.md, "per-turn
context from a hidden tool", protocol 4), and:

- on Claude Code, a turn whose tools include `claude_code_turn_context` asks it
  how to run, however its session was built;
- every other provider refuses a turn whose tools include it, with the reason
  in the thread, and never shows it to its model.

So this plugin selects the hook for every thread of a coordinator's scope, and no
other (D490). A Claude Code thread's turns then ask for their view; a coordinator
on another provider has each of its turns refused, visibly (a problem in the panel,
the turn gate's reason), with no fallback, until it is replaced with a Claude Code
thread (Codex support is T146).

**The turn gate.** Chat memory also answers BB's `message.dispatch` hook, which
runs before a message reaches a provider, to refuse early, with the reason, what
would fail anyway: a new turn of an UniiChat thread on another provider. BB
keeps the message. Messages that join a running turn, and every other thread's,
go on.

## UniiChat turns (D431 phase 2, D458)

BB's Claude Code provider (Erwin's fork) calls the hidden tool
`claude_code_turn_context` before each new turn whose tools include it
(protocol 4: `{input, requestId, sessionId, elapsedMs?}`). The answer is `{}` (the session
goes on) or `{session: "fresh", sessionId, systemPrompt, input}`. An UniiChat
turn:

1. catches up stable semantic events using bounded, coalesced reads;
2. cuts history before the incoming request if it was already accepted;
3. waits for every needed historical leaf summary, with cancellation and a 90-second final admission deadline;
4. returns a fresh session with the frozen summary prefix and growing summary tail, followed by the new message. Historical views contain no raw tail or clipped fallback.

**A reload during the wait (W570).** BB aborts the old plugin instance's tool
calls with the reason `plugin-disposed` before it disposes it. The turn then
fails with the fixed `TURN_CONTEXT_RESTARTING` error ("…chat-memory is
restarting…"), not "the turn stopped". A provider that sees it may ask the new
instance again with `elapsedMs`, the time since its first ask: the 90-second
wait still ends 90 seconds after that first ask. Asking again needs a change in
the fork (it asks once today); without it, the turn fails visibly with that
error, as before. Both errors start with "OptChat memory unavailable", so the
unsent message stays out of memory (D502).

The dispatch hook answers immediately with core's durable `wait` decision while
history or summaries are preparing. It supplies a 30-second recovery due time and
calls `experimental_hooks.recheck("message.dispatch")` when a waiting scope becomes
ready. BB retains queued reviewer returns, question returns, retries and user work.
The final turn hook remains strict even when a user bypasses a dispatch policy.
`tree.ready` proves actual leaf completion, a fully built selected historical view
of at most 128,000 UTF-8 bytes, and no ingestion in flight;
It can become ready during a merge batch once that bound is met, without waiting
for unrelated ancestors. `tree.summarized` remains the existing feed count. `tree.requiredFailure` is
a terminal error for a required failed leaf or an oversized view whose merge
work has exhausted its runnable paths. While legitimate merges remain in
flight, preparation continues. Unused failed ancestors do not block a complete
bounded view. Dispatch returns a visible rejection for required failure,
preserving core's input/failure handling; transient preparation stays queued. `tree.ingesting` distinguishes
history preparation from summary preparation. Attach and status never wait for a
model. A newly attached existing worker begins catch-up immediately, before its
next message; only attached workers are swept. No retired worker is attached or
backfilled by this plugin.

`experimental_thread.events` is debounced by core at most once per second.
Only stable semantic event types are read, never token deltas or thoughts.
Log rows carry a stable semantic-entry ordinal and the request ID whose
acceptance logged that input, while the original sequence remains its canonical
source. Exact acceptance identity determines the historical cut; a queued input
with no logged entry cannot remove later replies of the preceding turn.
Requests are durable pending records until `turn/input/accepted`, so queued work
is not presented as acted-on history. Pending state, log append and cursor advance
commit together. Historical providers without acceptance events retain their
terminal-turn recovery path; failed UniiChat admission requests are excluded.
Pending requests belong to their original scope and cannot leak after a move.

`memory_zoom {id,n:1}` and the read-only zoom RPC retrieve the selected canonical
semantic message via its original thread/sequence, including text clipped in the
memory log. Responses carry source, availability, byte range and explicit next
`offset`, in 24,000-byte UTF-8 pages. A split stored entry identifies its canonical
semantic message; pages expose that message, not unrelated event fields.
`attachment` selects an attachment index listed in the result. A group of tool
uses zooms to every use in full, each call then `→` and its result, read from
its events `seq` through `end_seq`; its result images are indexed in order
across the group. The row keeps its number of uses (`uses`), so a group missing
any of its events, its ends or one inside, falls back to the saved copy. Screenshots its text leaves out can pass BB's 8 MiB response
limit together, so a page of the group's events that fails is read again at half
the size, down to one event. A row of one tool use (logged by a6413e6, before
groups) zooms to its call and result; a call or an echo logged apart before
W571 zooms to that part alone. The log, not the text, tells them apart: a row logged
that way is an echo, or a tool row its event's echo row follows. Thoughts and nested subagent items are excluded. Inline
image data is omitted from summary input and returned only as tool image content.
The RPC remains text-valued, with an image-available notice for compatibility.

### Desired upstream APIs

The SDK hydrates retained output on `threads.events.list`, but core rejects a
single hydrated event over 8 MiB. A source output range API keyed by
`threadId/sequence/semantic field` is needed to retrieve every byte beyond that
limit without loading the entire event. Retention-expired middles cannot be
reconstructed. Zoom explicitly reports source-read failure or retained-output
truncation and preserves the saved copy; it does not promise a whole original.

SDK tool results support text and images, with no general file/resource content.
A resource attachment result and ranged attachment reads would allow arbitrary
binary files to be returned directly. Current zoom reads project attachment
images as proper image content and pages text files. Other binaries and remote
image URLs are reported with their source path/URL and availability limitation.
No upstream issue has been filed.

## The log

Append-only, one row per message, across all of a scope's threads, read from
BB's own thread events (`client/turn/requested`, `item/completed`,
`turn/completed`, and Claude Code's compaction summary), the same for every
provider. Kinds: `user`, `agent` (replies; lines written before T145 say
`coord`), `tool` (tool uses in a row, each its call, then `→` and its result,
the result's head and tail within 30,000 characters, as in `Bash git status` /
`→ exit 0` / `clean`; uses are separated by a blank line), `echo` (a result
logged apart from its call, before W571), `work`
(`[name] …` from another thread, by its title; `[bb] …` from BB,
including `[bb] (stopped) …` after a stopped turn), `note` (a plugin's brief or
handover, compaction summaries). Thoughts are never logged.

W571: a run of tool uses (those between two other messages, whatever the
parallel batches) is logged as groups of at most 8 uses or 16,000 bytes,
whichever comes first; a use larger than that is a group alone, and a group
longer than 30,000 characters is split like any text. A group is logged only
once closed: by the next other message, by its turn's `turn/completed`, by the
caps, or by the thread's archive (its final copy). A copy that ends inside an
open group logs what came before it and leaves the cursor just before the
group's first use; the next copy reads those events again. No open group is
saved anywhere, so no logged row ever grows and a scope move, a detach or a
restart needs nothing of its own: the group is logged by the copy that closes
it, to the scope the thread writes to then. A request queued inside the parked
range is kept as read, in the ingestion state, with the seq it was read through,
so the next copy skips it; a copy that moves no cursor (the run is still open)
saves that state too. A moved thread's ingestion state starts afresh in its
new scope (its requests read but not yet accepted stay out of it, parked or not)
but keeps two facts of the thread: whether its provider sends acceptances (a
re-read run is grouped again, never taken for a legacy turn), and that seq. A
copy whose whole read (2,000 events) is
one open run logs it as it stands, so the cursor always moves on. A thread BB
deletes mid-run loses its unlogged group (at most 8 uses). Rows logged before
(one use per row, a legacy call and echo) stay as they are.

A thread's events are copied **as they are stable**, mid-turn too (since
6b5c51a; D487 first copied through the last `turn/completed` only): a copy
reads the semantic events after the thread's cursor, up to 2,000 per read, and
stops before an open group of tool uses (above). One copy runs per thread at a
time; it appends to the scope the thread's row names when the append commits,
and moves the cursor in the same transaction, only if the cursor and the
ingestion state are still as its read began, so a message is logged once whatever triggers it. A thread
moved mid-turn has what was copied before the move in the old scope and the
rest in the new one. Turns of different threads land in the order they are copied. The requests of a turn that failed
before any output because UniiChat could not get its memory are left out (D502:
the `provider/error` of the turn says "UniiChat memory unavailable for this
turn"): the model never saw them, BB keeps the text for the user to send again,
and the resend is logged. Any other failed turn (a 429, an overloaded provider)
keeps its requests, so BB's automatic retry finds the question in memory. A
retry itself is never logged: it re-sends a request that is logged already, or
says "Please continue." after it.

Copies run when a thread goes idle, fails, or is archived (its final copy,
D485), before each of its UniiChat turns, and from a sweep: at start over every
attached thread, then every 5 minutes over those not archived, copying any
whose newest event is past its cursor (a parked group keeps it so: the sweep
reads it again). BB's announcements are
fire-and-forget; the cursor makes a duplicate copy nothing and a missed one
wait for the next trigger. A thread BB deleted is forgotten. A stop ends the
sweep at once, even mid-read: it touches the database no more.

## The tree

As the gist and W216: message i becomes a line requested at 512 bytes and stored at most 576 bytes
(`id+n|text`), adjacent lines merge in pairs; text that fits is kept with no
call. The chat view (what an UniiChat turn sees) is a 128→64 KB sawtooth merged
by due = (T+1)/2^l − i; the memory view (`memory_read`, the context of every
summarizer call) is it merged further, 32→16 KB. Both are saved, never rebuilt.
GPT-6 Luna (`summarizerEffort`, high since D484) writes lines with the gist's
compaction prompt and its 512-dash ruler; a reply over the 576-byte hard maximum is asked again once,
for at most 384 bytes (W315: Luna overshoots its ask, so asking again for 512
took 3.5 calls a line; asking for 384 fits 3 times in 4). If the shorter reply
is still over 576 bytes, it is cut at the last word boundary and ends in
` [cut]`, at most 576 bytes in all, and the log says so. When that boundary is
more than 64 bytes back (a long hash or path), the cut falls on a character
boundary inside the word instead. No new line is over 576 bytes, and none is
cut without ` [cut]` (lines saved before this cap keep their length);
both prompts tell the reader a `[cut]` line's rest is in what it was made from.
The initial task and ruler remain 512 bytes; the 576 maximum applies to model
acceptance, exact free leaves, free joins and storage validation. Existing 512-byte
nodes stay unchanged. There is no runtime sizing setting and no data rewrite.
The actual historical view still has a 128000-byte upper bound, measured from
rendered lines. Cutoff-feedback prompts are not used.
Up to `summarizerConcurrency` (8) calls run at once across every scope,
round-robin by scope, except that the lines an UniiChat turn is waiting for, and
their merges, take the next free call before any other scope's backlog (W315).
After those, a scope of higher priority goes before every scope of lower
priority (W568): an owner sets it with the `prioritize` RPC, and Initiatives
gives each Adventure coordinator's memory 1, so coordinators' trees build ahead
of the workers' (0); scopes of one priority still take turns. Permits are given
out once per macrotask, after every call asked for in it waits, so a scope whose
call just ended has its next one in the running.
A scope whose threads are all archived rests (W568): its log stays whole, but it
gets no summarizer calls (a build running when the thread is archived stops, its
calls in flight cancelled) until a thread comes back, starts a turn, or a turn
waits for its memory, even one that comes while a build is reading whether to
rest. A turn's demand is its need on the builder, so it lasts exactly as long as
the turn waits: a build asked for while the archive is still cancelling the run
starts again once it has ended, and rests again unless a thread woke or a turn
still waits. A run a waiter started stops when its last waiter leaves (the
admission expires or is released, the turn ends or stops), so it never drains the
rest of an archived backlog. Whether a thread is archived is read
once, at the startup sweep or first build, then kept from BB's archive events;
a failed read counts the thread as awake until a later read succeeds, and a read
that finds it archived stops the run like its archive event would. Once the
service stops, none of this touches the database again (BB may have closed it).
A call gives up after 30 s, then 60 s, then 120 s for the same line (Luna at
high answers 95% of calls within 30 s), so a hung call frees its slot; a call a
turn waits for runs on to the turn's deadline instead, so a reply at 65 s still
makes a 90 s turn. A stopped turn stops waiting, and a call past its bound
that no turn waits for any more gives up at once. A line whose call fails 3 times
stays unsummarized and failed, never cut to fit (D458), unless every reply was empty
(a retry gets the same): that line is built at once from its input cut to fit with
` [cut]` (its message, or its two lines joined; counted under "fallbacks"). A failed line holds no build slot,
the panel shows it as a problem, an UniiChat turn that needs it fails at once
("message 1234 could not be summarized (…)"), and it is tried again 30 minutes
later. Lines built before the cap (some over 512 bytes, fallbacks ending in `…`)
and lines Initiatives cut before T145 stay as they are: nodes are never rebuilt
("cut after failures" in the panel counts fallbacks). A 429 pauses new calls with a growing backoff; an
unavailable route pauses 10 minutes.

Luna runs through the Account Pooler's isolated plugin route
(`/advisor/v1/responses`), one `session_id` per scope. A call's older memory
view lines, in whole blocks of 4, go in a developer message and the rest of
`<chat>` and the task in the user message (W565): since 2026-10-16 the Codex
backend shares a cached prefix between different requests only through
instructions and developer messages, and calls for nearby lines share their
older lines but not their tasks. Calls carry
`x-bb-thread` (the scope's first thread), `x-bb-initiative` (for an
Initiatives scope) and `x-bb-purpose: memory-tree`, so the Pooler's ledger and
Usage stats attribute the spend.

## Tools and CLI

A thread attached to a scope gets `memory_read` and
`memory_zoom {id, n}` (loaded upfront, T143) and one line of guidance; in
UniiChat, the hidden hook. Each zoomed line starts with the
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

`regularCompactTokens` (300,000), `summarizerEffort` (high), `summarizerConcurrency` (8).

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

`scripts/summarizer-bench.ts` (W572) compares summarizers and prompts on the
same real compactions: it samples leaves and merges from the live database
(read only), runs each arm through the builder's own request and retry, and has
Claude Opus 5.5 rank the lines blind. The compaction prompt's "Mistakes to
avoid" examples come from real failures in the live tree: the agent's own
messages and plugin notices credited to the user, a merge direction flipped
into a merged PR, and a user's question cut from a merge.
