# T145 cutover: memory moves from Initiatives to Chat memory

Three things change together:

| Piece | Before | After |
| --- | --- | --- |
| Initiatives plugin | owns memory, holds `claude_code_turn_context`, answers protocol 3 | no memory, no hook; registers its coordinators with Chat memory (`setScope`) |
| Chat memory plugin | not installed | owns memory and the hook; answers protocols 3 and 4 |
| BB fork (`erwin`) | turn context protocol 3: a turn asks only if its session was built with the hook; host protocol 227 | turn context protocol 4: a turn asks if the tools BB resolved for *that turn* have the hook, other providers refuse such a turn, and a session started for a turn serves that turn's tools; host protocol 228; configure sees the origin plugin's metadata |

Two protocols move, and they are different things. The **turn context
protocol** (3 → 4) is what the Claude Code bridge sends Chat memory's hook; each
thread's status shows the last one it asked with (`askedProtocol`). The **host
protocol** (227 → 228) is what a machine's daemon must match to connect: the
daemon now passes each turn's tools to its runtime, and a 227 daemon would drop
them, so the server refuses it until it has updated itself.

Three pairings must never run:

- **Old Initiatives with the protocol 4 fork.** Old Initiatives answers with a
  protocol 3 `ack`, which protocol 4 rejects: every coordinator turn would fail.
  This is the "plugins before protocol 4" rule.
- **Coordinator turns while memory is half moved.** On the protocol 3 fork, a
  coordinator session built without the hook never asks, so an OptChat
  coordinator would run in its own session. A parent notice or Send now starts
  such a turn without passing any plugin's gate.
- **A turn on a machine whose daemon is still 227.** That daemon drops the
  turn's tools, so a turn that should ask or be refused runs in its session.
  The host protocol moved so that the new server refuses such a daemon until it
  has updated; step 5 checks that every machine came back at 228.

The plan below avoids all three by switching Initiatives and the fork in **one BB
restart**, with memory imported beforehand and coordinators held still from the
first step to the last check.

## 0. Before the day

- Both patches reviewed and applied: `t145v4-bb-plugins.patch` committed on
  bb-plugins `main` (not reloaded yet, see step 3), `t145v4-bb-fork.patch`
  committed on `erwin`.
- `scripts/fork/build` and `scripts/fork/check` pass on the new `erwin`. The
  daemon bundle changes (agent runtime, host daemon), so the deploy is a **full
  restart**: every provider bridge restarts and every Claude Code session is
  rebuilt on its next turn. The host protocol changes too, so every enrolled
  machine other than this one is refused once and updates itself (FORK.md,
  Compatibility); its threads wait until it reconnects.
- The build now live is kept for rollback, because `scripts/fork/build`
  overwrites `.fork-build/bb-app-0.45.0.tgz`: on 2026-10-09 it was saved as
  `~/.bb-backups/fork-artifacts/bb-app-desktop-v0.45.0-30-g8d6347c0e.tgz`
  (SHA-256 `15074e02569235c09a8c76e877f3ada6209513d075bbf1491da1d97919dcbad5`).
  Rolling back after the Macs have updated needs it on each Mac (Rollback).
- No `bb plugin dev` watcher runs for `initiatives` or `chat-memory`
  (`pgrep -af "bb plugin dev"`): a watcher would reload Initiatives the moment
  the checkout changes.

## 1. Know where each coordinator runs, then hold it still

List each Initiative's coordinator with its provider and machine, and every
enrolled machine:

```sh
bb initiative list --json | jq -r '.[] | select(.coordinatorThreadId) | .coordinatorThreadId' > /tmp/t145-coordinators
while read -r C; do
  bb thread show "$C" --json | jq -r '[.thread.id, .thread.providerId, .thread.status, .environment.hostId] | @tsv'
done < /tmp/t145-coordinators
bb machine list --json | jq -r '.[] | [.id, .name, .status, .lastRejectedProtocolVersion] | @tsv'
```

On 2026-10-09 this gave nine coordinators, all `claude-code` on `hetzner`
(`host_448xyz6tkm`, the machine BB runs on), and three connected machines:
`hetzner`, `Erwin's MacBook Pro` (`host_6wgh99dyzy`) and `Erwin's Brimstone
MacBook` (`host_f2eps48qhr`). The Macs then host no coordinator, so the deploy's
local restart covers every coordinator; the Macs still must reconnect at 228
(step 5) because a coordinator's workers or a later coordinator may run there.
Note any coordinator on another machine, or on another provider: step 5 checks
each.

What can start a coordinator turn, and how each is stopped:

| Source | Hold | Check |
| --- | --- | --- |
| New work from the Initiative (delegations, handovers) | Pause every Initiative from its dashboard | `bb initiative list` shows each one paused |
| Parent notices: a child (worker, reviewer, handover writer) finished, failed or needs input | Let every child finish, or stop it. A paused Initiative starts none | For each coordinator `C`: `bb thread list --parent-thread C --include-hidden --json` shows no `active`, `starting` or `pending` child, and none waiting on an interaction. `--include-hidden` is required: without it hidden children are left out, yet they still send parent notices |
| Queued or scheduled messages to a coordinator | Send or remove them | `bb thread queue list C` is empty for each coordinator |
| Automations that message a coordinator | Pause them | `bb automations list` |
| The user, Send now, retries | Do not message coordinators until step 6; let no failed coordinator turn wait for a retry | Every coordinator is `idle` (`bb thread show C --json`) |

Hold this until step 6. The checks take a minute; run all of them again,
hidden children included, right before step 4. A machine that is disconnected now cannot run anything, but it must be
connected again before step 6 (step 5).

## 2. Back up

```sh
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 ~/.bb/plugins/initiatives/data.db ".backup '$HOME/.bb-backups/plugin-deploys/t145-initiatives-$STAMP.db'"
sha256sum ~/.bb-backups/plugin-deploys/t145-initiatives-$STAMP.db
```

`scripts/fork/deploy` backs up BB's own databases when the schema or version
changes; check its output in step 4.

## 3. Install Chat memory and import the memory (old fork, old Initiatives)

Initiatives is still the old one, so it still holds the hook and owns memory.
Chat memory installs inert: no snapshot, so no import, so no scopes; without
scopes it selects no tools and its gate lets everything through.

```sh
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/chat-memory --yes
bb plugin list            # chat-memory loaded; initiatives still the old build (no reload since the commit)
bb chat-memory import-initiatives
```

`import-initiatives` opens `~/.bb/plugins/initiatives/data.db` read only,
copies it with `VACUUM INTO` (one read transaction), checks the copy
(`integrity_check`, memory tables), writes it as
`~/.bb/plugins/chat-memory/initiatives-snapshot.db` with a manifest (SHA-256,
size), then imports from the snapshot opened read only. It prints the counts,
for example `{"scopes":11,"members":13,"messages":6120,"nodes":12189,"trees":11}`
(the 2026-10-08 backup). Check:

- the counts match the source:
  `sqlite3 -readonly ~/.bb/plugins/chat-memory/initiatives-snapshot.db "SELECT COUNT(*) FROM memory_log"` and so on;
- `sha256sum ~/.bb/plugins/chat-memory/initiatives-snapshot.db` matches the
  manifest (`initiatives-snapshot.db.json`);
- each Initiative's mode carried over: `bb chat-memory status <coordinator>`
  shows the mode it had in the dashboard.

Until step 4 the old Initiatives still answers its coordinators' turns (there
are none), and Chat memory, which does not hold the hook yet, holds and then
refuses any OptChat message that reaches its gate.

## 4. Switch Initiatives and the fork in one restart

Run the step 1 checks again, then:

```sh
RESTART=$(date +%s%3N)    # ms; the check turns in step 5 must ask after it
cd ~/Code/bb && scripts/fork/deploy --full
```

The restart starts the protocol 4 fork and compiles both plugins from the
checkout: the new Initiatives (no hook) and Chat memory, which now takes the
hook at its first registration and already holds every Initiative's memory.
Initiatives registers its coordinators at its first sync. So the first turn any
coordinator runs after the restart asks with protocol 4, and there is no moment
when a coordinator has neither the old memory nor the new one.

## 5. Check the rebuilt runtimes before resuming

After the restart no Claude Code session exists yet: each is rebuilt (resumed)
on its thread's next turn, with the tools BB resolves for that turn. Check the
pieces, then one turn per coordinator.

1. **Builds.** `scripts/fork/status` shows the new build, with protocol 228,
   for server and daemon (daemon PID changed). `bb plugin list`: `initiatives`
   and `chat-memory` loaded, no errors.
2. **Every machine.** `bb machine list --json | jq -r '.[] | [.name, .status, .lastRejectedProtocolVersion] | @tsv'`
   shows every machine `connected`. The server accepts only its exact host
   protocol, so a connected daemon is a 228 one, whichever machine it is on;
   the local one's PID change alone says nothing about the Macs. A machine
   that shows 227 as its last rejected version and is not connected is still
   updating: wait, or `bb machine retry-update <id>`. If it stays
   disconnected, install the fork's `bb-app` on it by hand. Every coordinator's
   machine from step 1 must be connected before its check turn.
3. **Memory.** For each coordinator `C` (from `bb initiative list`):
   `bb chat-memory status C` shows the scope `initiatives:<id>`, the expected
   mode, `C` current, the log and tree counts from step 3 (or more), and
   `problems: []`. A problem saying the hook "is still held by another plugin"
   means the old Initiatives is still loaded; "older than protocol 4" means the
   old fork is still running: stop and roll back (below).
4. **One turn per coordinator.** Send each coordinator one short message
   ("Cutover check: reply OK."). Then, for every Claude Code coordinator, its
   status must show `askedProtocol: 4` and an `askedAt` after `$RESTART`:

   ```sh
   while read -r C; do
     bb chat-memory status "$C" --json |
       jq -r --arg c "$C" --argjson r "$RESTART" '.threads[] | select(.threadId == $c) |
         [.threadId, .providerId, .askedProtocol, (if (.askedAt // 0) > $r then "fresh" else "STALE" end)] | @tsv'
   done < /tmp/t145-coordinators
   ```

   Every `claude-code` row must read `4` and `fresh`. Do not resume until they
   all do: `problems: []` cannot show this, since a thread that has not asked
   since the restart has no evidence either way. A `STALE` row means its check
   turn did not ask: find out why before resuming (its machine, its tools, the
   journal below).
   - OptChat: the turn completes, which on protocol 4 means it ran in the
     fresh session Chat memory answered (a fresh session that cannot start
     fails the turn), and its reply knows the memory (ask it what the
     Initiative was last doing).
   - Regular and Hybrid: the session goes on.
   - A Codex coordinator in OptChat (there should be none): the message is
     refused at once with "OptChat runs on Claude Code only…", and a notice
     to it fails with "This turn was not started: its thread's memory runs in
     OptChat mode…". Switch its mode or replace it.
5. **No silent turns.** `journalctl --user -u bb-app --since "-15 min" | grep -i "turn context"`
   shows no failures for the check turns.

## 6. Resume

Only once every machine is connected and every Claude Code coordinator showed
`4` and `fresh` in step 5.

Unpause the Initiatives and automations. Workers' notices now reach
coordinators through the turn hook like any other turn.

## Rollback

- **Before step 4:** `bb plugin disable chat-memory` (its data stays). Nothing
  else changed: the old Initiatives never stopped owning memory.
- **After step 4:** `scripts/fork/rollback` (previous build, full restart) and,
  in the same quiet window, revert the bb-plugins commit and
  `bb plugin reload initiatives`, then disable Chat memory. The Initiatives
  database was never written by the import, so the old Initiatives resumes with
  its memory as it left it; its log catches up from BB's events. The step 2
  backup is the last resort.
- **Remote machines after rollback.** Once a Mac has updated itself to 228
  (step 5), a 227 server refuses it and its daemon refuses to downgrade:
  `bb machine retry-update`, forced or not, returns `skipped` ("Server
  protocol is older than this daemon; refusing to downgrade"). Each such
  Mac stays offline until the saved 227 package (step 0) is installed by hand
  into its machine-service prefix and that service is restarted, as in
  FORK.md "Roll back". This needs access to the Mac; with none, leave it
  offline (step 1: no coordinator runs there) and do it when someone can.
  Before resuming on a rollback, `bb machine list` must show every machine
  that hosts a coordinator or live work `connected`.
