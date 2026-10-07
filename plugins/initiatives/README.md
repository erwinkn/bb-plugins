# Initiatives

Plugin ID `initiatives` (package `bb-plugin-initiatives`). Until its one-time
move it was installed as `projects`; see "One-time move from the projects ID".

One coordinator across one or more BB repositories and ordinary worker threads:
threads, labels and messages, with optional tasks, reports, decisions and updates.
Native tools remain available.
The Control Room dashboard sits beside coordinator chat. Its compact coordinator
strip opens state/home details, replacement and the Initiative menu. Inbox,
Decisions, Threads, Tasks, Context, Log and Usage keep everyday controls in this
panel.

## How it works

An example, in the bb-plugins Initiative:

1. The coordinator creates T40 "Archived records in search" (optional).
2. It spawns W190 "Search index" (purpose "search ranking"): `initiative_spawn
   {label, purpose, text, tasks:["T40"]}`. The brief is the label, the task, the
   coordinator's text and one report line; standing rules live in the worker
   instructions, given once per session.
3. W190's **final message is its report**: the final message of the first
   normally completed turn after its brief arrived (a resumed turn counts; for an
   adopted thread, after the adoption). It may also call `initiative_report
   {outcome:"done"|"blocked"|"failed", summary}` for a one-line dashboard summary;
   blocked needs the question, which then waits in the Inbox.
4. A reviewer: `initiative_spawn {role:"review", reviews:"W190", ...}`. Its brief
   embeds W190's latest report, it reads W190's checkout, and it reports findings
   as its final message. No revision strings.
5. Fixes go back to the same worker: `initiative_message {to:"W190", text,
   work:true}` (or `tasks:[...]`). A message without them is just a message. The
   same reviewer then re-checks them: `work:true` to a reviewer is a read-only
   re-review of its own batch, with W190's latest report; a reviewer never
   implements.
6. Done: the coordinator closes T40 (`initiative_task {action:"close", task:"T40",
   outcome:"done"}`) and retires W190 and the reviewer. Nothing is accepted or
   rejected.

Details:

- **Workers** are a thread, a W#, a role (work or review) and a purpose. Each spawn
  or work message creates an A# that links a report to the work that asked for it.
- **Prior reports**: `handoffs:["W171"]` (latest report) or `["A280"]`, up to three,
  with no rules about which tasks they cover. Long ones are clipped at 1,500
  characters with a pointer to the full report.
- **Overlap** is a warning, never a refusal: a spawn or work message returns
  `warnings` when another worker is writing in the same checkout or has the same
  task. Give one of them a worktree (`environment:{type:"worktree"}`) or sequence
  them.
- **Decisions** are for the user (D402): `user-choice` records the user's explicit
  choice from chat, `veto-request` records a choice of the agent's that the user may
  want to veto (the agent proceeds; Not okay sends the user's message back).
  Agents never read the log back. Questions and answers are unchanged.
- **Instructions**: the coordinator and worker defaults in `lib/guidance.ts` are
  about 1,300 and 1,050 characters. Saved instructions were replaced by these
  defaults once at upgrade (D406); later edits are the user's.
- **Coordinator handover**: Replace coordinator (dashboard), `initiative_manage
  {action:"handover"}` or the restart command below start a short-lived thread on
  Codex / `gpt-6-luna` / high, titled "Handover · <Initiative>", with no Initiative
  tools. Its prompt is a bounded packet (about 60k characters) built from the
  plugin's records and the old coordinator's last 30 messages: objective, open
  tasks, live workers, the last 10 reports, what waits on the user, the last 5
  updates. The decision log is not included. Its final message becomes the new
  coordinator's first message and is kept nowhere else; the writer thread is
  archived. If Luna is unavailable, fails or takes more than 10 minutes, a plain
  listing of the same packet is used, so a replacement never blocks. The dashboard
  shows the handover in an editable box before **Start replacement**. Old
  checkpoints stay in the database and are never injected.
- **Restart**: `bb initiative recreate-coordinators (--all | <id>...) [--dry-run]
  [--wait=<seconds>]` writes a fresh handover for each open Initiative (at most
  three writers at a time) and starts a fresh coordinator with it; a busy
  coordinator is replaced when its turn ends, so the coordinator running the
  command is replaced last. `--dry-run` prints the handovers without starting
  anything; a real run within the hour reuses them. Workers keep their threads
  and move to the new coordinator.
- **Older sessions** keep working: `initiative_delegate`, the full structured
  `initiative_report`, `initiative_progress` (now a no-op) and the old
  `initiative_task`/`initiative_manage`/`initiative_worker` actions still run.
  Removed actions (task-accept, review-accept, assignment-reject,
  assignment-scope-release, task-checkpoint, decision-cleanup, fork) answer with
  what replaces them.
- **Existing data** stays readable and nothing is dropped: old structured reports,
  accepted/rejected assignments, D# history and checkpoints render as before.
  Tasks left "awaiting acceptance" show as reported and open until closed. The
  only additions are the `handover_drafts` and `plugin_flags` tables and an
  optional `finalMessage` in the report JSON.

Coordinator tools: `initiative_read`, `initiative_spawn`, `initiative_message`,
`initiative_task`, `initiative_worker`, `initiative_decision`, `initiative_update`,
`initiative_manage`. Workers get `initiative_read`, `initiative_report`,
`initiative_message` and `initiative_decision`. User-owned threads get
`initiative_read` and `initiative_update`; unmanaged threads get
`initiative_create`. Every tool publishes one flat object schema (Claude's bridge
blanks union roots) and validates it on the server. The CLI is `bb initiative`;
`bb initiative describe` lists valid examples.

## Install and use

Requires BB 0.43.1 / Plugin SDK 0.4.87. Install from the local checkout:

```sh
bb plugin install path:~/Code/bb-plugins/plugins/initiatives
bb plugin build ~/Code/bb-plugins/plugins/initiatives
bb plugin reload initiatives
```

Open Initiatives in the navigation, or Initiative from a thread's panel menu. Start a
new coordinator in a selected checkout, or adopt the current thread. Adoption
preserves its runtime; tools activate at the next natural session construction.
The CLI works immediately. Replace coordinator opens a live model picker and
the handover GPT-6 Luna High writes from recent activity, then starts a fresh
thread with it as the first message. The old thread stays in history, and
unfinished worker reports reach the replacement. Let the current coordinator
finish its turn or stop it before switching — or ask the coordinator to hand
over: it records a durable request with coordinator-handover — optionally naming
a target environment — finishes its own turn, and the replacement starts at
the natural idle boundary. The queued request survives restarts, waits through
a pause, holds while the predecessor is busy, interrupted, unhealthy or cannot
be positively confirmed, and is visible — with its hold reason — and
withdrawable from the dashboard until the replacement spawn is in flight. The
final quiescence check is not atomic: turn history and thread status are
separate native reads, so the drain orders them (history before status) and
revalidates every gate afterward, but journaling and reconciliation cannot
quiesce the native thread — a message that starts a turn between the last read
and the replacement spawn is a race the plugin cannot close. The replacement
still commits, and no later drain re-checks the predecessor, so a turn starting
in that gap runs to its own end rather than holding anything; the predecessor's
work is preserved, not rolled back.
Edit in Context sets the purpose, vision, current objectives and ideas. Edits are recorded in Initiative activity and read by the coordinator on
its next turn — there is no separate notification channel.
The Threads plugin also offers an Initiatives view switch: one colored row per Initiative
opens its coordinator, with attention, working and draft status aggregated across
its threads.

The coordinator plans, delegates and decides through Initiative tools; it does
not run the verification itself. Testing, browser checks and diff review are
worker work, and each report names the checks that ran. Workers publish
progress and structured reports. Idle is not completion: results require a
report and coordinator acceptance. Retirement is always explicit — after a
result lands and the thread confirms idle, the coordinator (or you, from the
dashboard) retires the worker; nothing infers archive permission from old
assignments or idle threads. Retirement checks the full native descendant
tree plus queued work and background agents, and preserves reports, handoffs
and role history. Native Stop, message queueing and turn lifecycle belong to
BB; a cancelled or stopped assignment stays settled in the ledger and is never
restarted on its own.

Pause is explicit: only the dashboard/CLI Pause-Resume action changes it, and
it gates what the plugin starts (new delegations and the handover drain).
Running work, native threads and user messages are unaffected — pausing an
Initiative never stops or queues native conversations.

New thread in Threads immediately opens BB's native New thread composer on the
Initiative page. Opening it creates no thread and starts no agent turn. The user
selects native execution controls and writes their message there; only Submit
creates a user-owned child of the current coordinator and navigates to its chat.
The native structured message, attachments, environment, model, effort, tier,
permissions and schedule are forwarded unchanged. Membership, parent and
operation-receipt guards apply. A lost create response stays visibly uncertain
and reconciles by metadata; the composer never retries it blindly.

BB 0.43.1 / SDK 0.4.87 cannot create an ordinary blank thread, and `toCompose`
has no parent or plugin-association fields. The host composer is the supported
path until BB provides parent-aware draft creation/navigation. The root README
records that upstream candidate; no issue was filed.

| Work                                      | Default model          |
| ----------------------------------------- | ---------------------- |
| Coordination, implementation, experiments | Opus 5.5 High          |
| Investigation                             | GPT-6.1 Sol High       |
| Straightforward implementation            | GPT-6.1 Sol High       |
| Review of Claude work                     | GPT-6 Astra Extra High |
| Review of GPT work                        | Fable 5.1 Extra High   |

Review substantial milestones. A reviewer remains a reviewer across messages and
adoption. Each review starts as a fresh, read-only thread with the reviewed
worker's latest report embedded, never a continuation of an implementer's
context. A reviewer from a different model family is the default
recommendation, not a requirement: the "Review of Claude/GPT work" profiles are
used as configured, even when they share the implementer's family, and an
explicit reviewer profile wins. Without a chosen profile, mixed Claude/GPT
authorship gets one default reviewer per implementing family, or a single one
when both families' profiles are identical; with one, a single reviewer covers
the whole requested scope. Reviewers are archived explicitly
after their result lands — never reused, never auto-archived. Explicit
Initiative/task model overrides remain available.

## Control Room dashboard

Inbox is what needs the user: open questions first, rendered as Markdown, then
agent decisions not yet checked, each with Okay (private) and Not okay (a
message to the coordinator). Clearing it means being up to date. Its count turns
amber only while a question waits. Decisions holds the full record, newest
first, filterable to agents' or the user's own. Worker reports are coordinator
bookkeeping and wait under Tasks with their accept/reject actions. Report
acceptance/rejection and question answers call the existing guarded ledger
commands; failed actions keep their errors and drafts. Threads opens each native
thread from its primary row, with a separate detail caret. Current native parents
preserve nested members and user ownership. Unknown parents stay explicit in
expanded details. Retired workers and prior generations remain under a fold.
The optional Threads integration keeps its tree v1 contract; each Initiative
now also carries an optional `appearance` (`{icon, color}`, null for the
default look) that the user sets from the sidebar row menu through the
user-only `appearance` command (an icon from `PROJECT_ICONS`, a color from
`PROJECT_COLORS` in `lib/tree-schema.ts`; null resets). Agents' tools and
agent CLI calls are refused, and the change never reorders the list.

The coordinator menu includes Pause/Resume, Context editing, repositories,
refresh and confirmed stop/archive actions. Replace inherits incumbent model,
reasoning, approval mode and service tier unless a model override is selected.
Queued/paused/failed starts and withdrawal use real backend state. When BB
returns the new coordinator before reporting its checkout, the start stays
pending with its receipt and the existing sweep confirms it with the same exact
home proof; a wrong checkout is never confirmed. Unarchived
predecessors remain visible for inspection while the existing reconciliation
retries transfers. The endpoint has no per-member transfer-receipt projection or
manual transfer retry action, so the UI does not invent a moved-count pipeline.
Native Stop stays in the native thread.

Context uses auto-growing fields with the existing conflict-safe save baseline.
Its compact age is the Initiative's last update time, not a separately recorded
context-edit timestamp. Repository checkout paths come from native inventory;
missing homes stay unavailable. Files open through Editor's supported picker.
Log displays explicit updates, recorded activity, coordinator generations and
completed tasks. It does not infer coordinator turn progress.
Opened tabs keep drafts mounted when another tab or replacement is inspected.
Tabs show labels only. Their density follows measured width: tighter spacing,
then named glyphs for Context/Log/Usage, then a scrolling strip. Keyboard
navigation uses arrow/Home/End.
Usage reuses the real bounded observations described below; no prototype fixture
or mock action is imported. The external prototype and feedback data are separate.

## Backend and tools

SQLite in BB's plugin storage owns Initiatives, tasks, workers, generations,
assignments, decisions, updates, operation receipts and usage. Legacy inbox,
batch, message and lease tables remain for history — they are readable through
the inbox collection view and never replayed or written by current code.
Records have per-Initiative refs such as T12, W3, A7, D4 and U2. Strict schemas
validate stored JSON and fail visibly on corruption.

## Editable plugin Settings

BB Settings exposes the coordinator and worker instructions plus a JSON map of
default execution profiles. Instruction edits allow at most 3,584 characters,
reserving 512 of BB's 4,096-character limit for the identity line. Empty,
overlong or invalid edits are rejected before saving. BB applies instructions
when it constructs a session; saving never restarts or wakes an agent, and
briefs never repeat them.

Profiles: `coordinator`, `implementation` (the default work profile),
`reviewOfClaude` and `reviewOfGpt` (the default reviewer for work done by that
model family, so a different family reviews by default). Other stored keys are
kept but unused. An explicit `profile` on spawn wins; a user-chosen task profile
still wins over the coordinator's; a work message keeps the worker's native
model. Settings never rewrite stored Initiative policies.

## Execution choices and native details

Read recorded Initiative policy and explicit user/task choices before selecting
settings. The current bb-plugins policy remains GPT workers. Good means a
deliberate choice of `claude-code / claude-opus-5-5 / high / default`.
Fast means `codex / gpt-6.1-sol / high / fast`. These are documented choices
through editable profiles; they do not create presets or change other
Initiatives. Existing profiles without `serviceTier` still decode.

`profile.serviceTier` optionally accepts `default` or `fast` on policy, task,
spawn and coordinator commands. Spawns and work messages forward it through
native execution fields. Omission uses native defaults on new threads and
preserves the worker's current native settings on a work message. An explicit
user task tier wins; an unavailable Fast tier is rejected without fallback.
`permissionMode` is an explicit parameter on spawn; pass `full` when instructed. Replacement
coordinators inherit effective tier and permissions unless the profile explicitly
changes the tier, preserving the existing replacement controls.

The decision log is the user's steering record, not an input for agents (D402).
Past decisions in an agent's context make it overfit to what was already done,
many entries were approved quickly or later superseded, and a permanent
Initiative would grow the log without bound. So agents write decisions and never
read them back: briefs, continuations, forks and standard handoffs carry no
decision list, guidance tells agents not to consult the log, and the coordinator
writes any user instruction a task needs into that task's brief. The compact
overview still counts open questions and unchecked agent decisions (with refs,
no bodies) so the coordinator can relay them; `initiative_read` view
`decisions` stays available for the dashboard and explicit lookups.

Decisions have automatic D numbers and one or two sentences. `user-choice` and
`veto-request` carry their owner (user or agent); the older `decision` +
`madeBy` form still works. The originating thread/assignment is recorded
separately as provenance. Current coordinators and workers can
record explicit user choices from their own chat as `madeBy: user`; the recorder
does not become the choice's owner. Never infer a user choice or include defaults
added by an agent in that user's choice. Record agent choices only
when the user may want to veto them; routine steps are not decisions. An agent choice cannot supersede
an explicit user choice, and workers revise only choices recorded in their own thread. Quotes, citations, titles and
rationale are optional implementation detail, not input requirements. Agent
choices can be marked Okay or Not okay. Okay is private bookkeeping and sends
nothing. Not okay requires a message and sends it to the current coordinator
using BB's native steer-if-active delivery for this actionable correction. The saved review includes a native
sent/queued receipt or a visible failed/uncertain state. An uncertain send is
never retried automatically.

initiative_decision takes one flat object, so Claude's bridge (which blanks
union roots) still shows every field. Canonical payloads:

```json
{"action":"user-choice","description":"Erwin chose Base UI.","supersedes":"D7"}
{"action":"veto-request","description":"I'm keeping the old index for one release."}
{"action":"question","question":"Where is the Monolith repo?","context":"Not under ~/Code.","options":["Point me to it",{"label":"Skip","consequences":"Monolith waits."}]}
{"action":"answer","ref":"D12","choice":"Skip","note":"Erwin said so here."}
{"action":"withdraw","ref":"D12","reason":"Settled by D15: Erwin chose Base UI in chat."}
```

A question is always an open user choice: no `humanAttention`, and its title
defaults to the question. The tool and `bb initiative command` share one parser;
older nested `decision:{…}`/`question:{…}` payloads and `decision:"D#"` targets
keep working. A question shaped like a taken decision
(`outcome`/`rationale`) is refused unless it is a legacy payload with
`humanAttention: "needs-opinion"`. Conflicting duplicates, unknown fields and a
missing `madeBy` are refused with a valid example. Superseding an open question explains that
only the user's explicit answer closes it. Open questions display their question
rather than a proposed outcome.

```sh
bb initiative command '{"action":"veto-request","description":"Reuse the existing index."}' INITIATIVE_ID
bb initiative read decisions INITIATIVE_ID '{"refs":["D12"],"detailed":true}'
```

The current `thread-create` command takes `request`, the structured result from
BB's native composer. It is user-only and deliberately absent from agent
management tools. The tree/membership RPCs identify these members as `adhoc`.

Existing sessions keep their constructed native allowlists. Hidden `project_*`
aliases for create/read/manage/task/delegate/worker/update/report/progress retain
the same authority checks. The retained read alias maps its obsolete collection
name to decisions and exposes no informational rows; newly configured agents are advertised only the
initiative names. The removed publisher alias fails with guidance to use the
new decision API. A retained worker can use `bb initiative command` to record
an explicit user choice or a significant independent agent choice until its next
natural session construction. Do not restart
or wake agents to refresh tool names. Remove tool aliases only after all
constructed old allowlists have ended naturally and their callers use the new
names; the obsolete publisher refusal remains until the same condition holds. Old report proposal payloads are accepted
only by the retained report alias, stored in an inactive compatibility archive,
and excluded from active reports; they create no rows or choices.

A temporary RPC-only adapter accepts the old Sidebar/constructed-panel
`thread-create` payload. Its caller still owns its existing form; the Initiative
UI and CLI offer only the native composer request. T50 tracks Sidebar migration. Root must migrate Sidebar to
`initiatives/<initiative-id>/compose` and close existing old panel callers before
removing this adapter. No other plugin
was changed here.

SQLite table names stay unchanged. Legacy data remains byte-for-byte
in place. Genuine previous choices migrate as user or agent from their recorded
answer/author; report proposals and old informational rows stay inactive.
Stored legacy reports keep their raw bytes through assignment bookkeeping; a
report replacement first archives the old text. Unanswered questions stay
unowned and answerable even when they carry a tentative outcome.
Previously answered questions remain user decisions. Old K references retrieve
the corresponding active D number. No agent implementation choice is relabeled
as a user choice, and absent evidence does not manufacture a choice.

Ordinary native children of the coordinator — threads it spawns itself,
outside delegation — associate automatically: the plugin records the same
lightweight `adhoc` row (no task, assignment, worker or message) so they
appear in the Initiative's Sidebar section. An explicit coordinator, worker or
reviewer membership always wins and is never replaced; a same-Initiative `adhoc`
claim can still be promoted to an explicit worker or coordinator later, while
a claim by another Initiative blocks adoption outright. Children of an
associated child get a nested lightweight claim of their own — no thread row,
just enough membership for Sidebar selection and read tools to resolve the
right durable Initiative when several Initiatives share one BB repository.
Association survives coordinator replacement (former generations' children
still count) and archived or deleted threads drop out of current navigation
while their rows stay in history; a vanished native thread never reads as
working — liveness is native evidence, not the durable row.

Association is discovery-based, not creation-time: the plugin learns about an
ordinary native child when that thread goes idle or fails, or on the periodic
sweep (~30s). A newborn child's _first_ turn therefore runs before
association — it has only its default native tools, not the Initiative read or
update tools a member thread gets. Tool reconfiguration follows the
association; this differs from user-owned Initiative threads, whose explicit
creation path confirms membership before the first message.

When BB stops the sweep service (reload, disable), the sweep stops starting
new work: it checks its abort signal before each new unit of work and right
after each pure read. Only the association scan read (`threads.list`) carries
the signal, so a hung scan ends with it; every other read finishes its one
call. No spawn, reparent, archive or Stop starts from a read that returned
after abort, and that includes the next worker of a former-coordinator
transfer. This promises no new work, not no writes: a mutation already issued
still finishes with its confirmation read and journals its receipt, and some
receipt and bookkeeping paths still write the ledger after abort (for
example a queue-delete or spawn receipt, a cancelled settlement, a
held-handover note or a "stays live" log line). Unconfirmed operations,
pending handovers and unfinished transfers stay for the next sweep. An idle
event delivered after the stop still records native facts but starts no
handover or former-coordinator convergence. A coordinator switch whose spawn
already went out still confirms that spawn and records the new coordinator,
but moves no children: the former coordinator stays live with its workers,
and the next sweep moves them and archives it. A slow
single read or an issued mutation can still outlast BB's 5 s stop timeout,
which is not configurable; BB then marks the plugin degraded until it stops.

The idle-event guard reads the service's own signal, so it also follows BB's
crash handling. An uncaught exception in the sweep aborts it, and idle events
start no handover until BB restarts the service after its backoff (1 s,
doubling up to 60 s); the restarted sweep picks the work up. A sweep that
ends by throwing is not aborted, so idle events keep draining handovers during
that backoff, and a reload during it leaves the stop window unguarded.

Ordinary workers are native children of the coordinator (`parentThreadId` on
spawn), so BB delivers their completion notices directly. Genuine forks keep
native parenting but use explicit report fallback, as do adopted parentless or
reparented workers. The durable report record never depends on that send. BB
sends an ordinary native child's parent a completion notice each time a turn
ends, not only the last one: a worker whose watcher reports each matching test
or log line can wake the coordinator per matching line. Since T136 a turn end
with open work also records its final message as the report, so the default
worker instructions ask workers to end their turn only when the work is done and
to wait for their own checks inside the turn. There is
no plugin inbox, batching or wake layer; routine progress is ledger state the
coordinator reads when it next acts. Reported work stays in flight while its
native thread is active, then shows as reported until the coordinator closes its
task or retires the worker. A blocked report waits in the Inbox until the
coordinator sends the worker more work, closes the task, or the user answers or
dismisses it. Stop does not apply to reported work. A
rejected assignment is closed: a late report from its worker is refused without
a write, so the rejected report, its task and any successor stay as they are.
The refusal names the worker's current assignment, or says its next brief is not
confirmed delivered yet, and offers initiative_message only when the worker may
still use it. Otherwise it asks the worker to stop any listed jobs and name them
in its final reply, which reaches a native parent only if the thread is an ordinary
native child (an adopted external fork carries no ledger fork marker); a fork is
told that its final reply stays in its thread and is not delivered by ordinary
native completion. task-reopen alone does not release a reported
assignment. A report that still lists background work is not final: it cannot be
accepted, and it can be rejected only after the worker reports again, or once BB
positively confirms that the worker's context has ended (the worker retired with
its thread no longer running, or its thread archived, deleted or missing). Then
the report stays as filed and the rejection records its listed work as
unverified: those jobs may still be running, so they keep the assignment's write
scope until an explicit `assignment-scope-release`. BB showing the thread ended
never means a detached job finished. A reported review is accepted with
review-accept or rejected and replaced by a fresh independent reviewer, never
continued. Decisions needing an opinion can block named tasks; agent choices
awaiting user review continue to permit work. An answer picks one listed option
with optional detail, or Other with a written answer; the choice and note are
stored on the decision. When the user answers an open question directly in a
chat, the current coordinator or a current worker records it with
`initiative_decision` action `answer` (or the same `bb initiative command`): it
closes that question as the user's choice, keeps the recording agent as
provenance and never infers one. Dashboard answers notify the current
coordinator by default with the D reference, choice and note, using native
steer-if-active delivery for the blocker-resolving answer. BB can still return a
queued receipt for an interaction, provisioning, offline host or native hold.
Uncheck Notify coordinator to save quietly. Close quietly resolves a question
without inventing an answer; the question and closure note remain in Closed
questions and detailed reads. Only tasks waiting on that question are released;
other questions and unrelated blockers remain. Coordinator chat answers stay
quiet because that coordinator already received them. Worker chat answers notify
by default; `notify: false` records an explicitly quiet answer. A saved answer
retains failed or uncertain delivery state. Only a definite failure offers an
explicit same-answer retry; pending, sent, queued and uncertain receipts never
authorize a duplicate send.

```sh
bb initiative list
bb initiative overview PROJECT_ID
bb initiative read assignments PROJECT_ID '{"refs":["A7"],"detailed":true}'
bb initiative command '{"action":"pause","paused":true}' PROJECT_ID
bb initiative reconcile
bb initiative recreate-coordinators --all --dry-run
```

Agent `initiative_read` with no selectors returns a compact overview: counts,
live workers with their current work and latest report, open tasks and what
waits on the user (open questions, and unchecked agent decisions by ref only). It does not fetch/duplicate
per-thread inventories or usage. The dashboard retains the full `overview` RPC.
Refs-only calls infer T/W/A/D/U collections (K remains a legacy D alias), including
mixed refs; an explicitly incompatible view fails with a corrective error.
Native IDs and numeric inbox/activity IDs require an explicit view. Hidden
`project_read` compatibility normalizes the old schema's injected `overview` and
no-op defaults before processing refs; meaningful conflicts still fail. Newly
configured agents see only `initiative_*`. Remove the aliases after constructed
sessions and callers using their old names/allowlists have ended or migrated.

Collection reads return whole JSON records with `items,total,missingRefs,offset,
limit,nextOffset,truncated,byteLimited`. Summaries omit full briefs/reports,
telemetry and payloads, and label shortened text/ref lists with `truncatedFields`.
Use `fields:["payload"]` for inbox/activity, `fields:["body"]` for updates. Defaults
are 20 rows, maximum 30; pagination stops between complete records at a 64 KiB budget.
A single oversized detailed record fails with field-selection guidance. No JSON
is mechanically clipped. Selective details use `detailed:true` and `fields`, e.g.
`report` for assignments. View `reports` lists reports newest first with a
600-character excerpt of each final message; view `context` returns the shared
vision, objectives and ideas. A W# read includes its latest report. Explicit
`threads` and `usage` views are independently paginated.

Use action `question` for an unresolved human choice: question/context, options
with consequences, recommendation and affected `blocksTaskIds`. Ask intentionally;
never infer user questions/answers from transcripts. Explicit chat answers resolve
that D ref via `answer`; notification/quiet/close behavior above stays available.
After the last blocking question resolves, the task returns to in progress
(blocked if its latest report was), or planned if no work is recorded. Quiet
close records no answer and never completes the task.

The current coordinator may withdraw an open question it recorded itself once
the user no longer needs to answer it (D340), with a required reason of up to
2000 characters: `{"action":"withdraw","ref":"D12","reason":"…"}`, or
`question-withdraw` with `decision:"D12"` through `bb initiative command`.
Withdrawal is its own status, `withdrawn`: it keeps the question, context,
options, recorder and any receipt, stores the reason, time and coordinator in
`resolution` (`withdrawnBy`), logs one activity line and sends nothing. It
records no answer and chooses no option. It leaves the Inbox, and Decisions
history shows it as "Withdrawn by the coordinator". Only this question's blocks
are released, as with a quiet close; tasks still waiting on another open
question stay blocked. An identical repeat returns the saved withdrawal
unchanged. Workers, former coordinators, a replacement coordinator for its
predecessor's question, and the user's panel cannot withdraw; the user keeps
Close quietly. Answered, closed and decision records are refused. A later
answer to a withdrawn question is refused and never reopens it: the panel (or a
threadless terminal) says the coordinator withdrew it, gives the reason, says
the answer was not saved and asks the user to tell the coordinator in chat;
agent recorders get the reason and the `madeBy: "user"` decision path.
`bb initiative describe withdraw` shows a valid example.

Rollback limit: a build without withdrawal (A225 or older) does not know the
`withdrawn` status, so it hides withdrawn questions from Inbox, Decisions
history and reads, and treats their D# as unknown, until the upgrade returns.
The rows stay in the database unchanged, and D# numbers are never reused
(numbering takes the highest stored number). Known follow-up: a half-typed
panel answer is discarded when the question disappears after an external
withdrawal, answer or close; the form lifecycle is unchanged here.

A work message uses `mode:"queue"` (default) for future work and `mode:"steer"`
for an urgent correction or blocker. Actionable human answers and
Not okay reviews steer-if-active; worker chat sends carry the recording thread as
native sender. Fresh briefs carry the coordinator sender and native parent;
replacement seeds carry the predecessor when there is one. Unparented report
fallbacks preserve the worker sender, steer blockers, queue routine completion,
and retain honest sent/queued/failed/uncertain receipts. Native BB owns queues and
holds; this adds no automatic retry, drain, bus, keepalive or recovery scheduler.
An explicit repeat of the same canonical report may retry a definite failed
fallback notification. Pending/sent/queued/uncertain receipts never authorize
another send; concurrent identical calls see pending before native inspection.

Native operations are journaled before sending. A lost response remains uncertain
and keeps its task/workspace reserved: new work on them is warned about, and the
worker cannot be messaged or retired until it settles. Reconciliation requires positive metadata,
history or queue receipts — absence from a bounded listing proves nothing.
Cancelling an assignment keeps its queue receipt and task reservation until the
native row is positively gone: a failed delete retries on the next reconcile,
and a cancelled send found queued is deleted rather than confirmed. A receipt
proves delivery, never execution — a cancelled brief that provably dispatched
(a dispatch event, a 404 on delete, or its marker in prompt history) keeps the
task and workspace reserved while that turn can still run, releasing only on
positive native quiescence: the thread is positively gone (a 404, archive or
delete event), or quiet with no busy foreground turn, no runnable queued
messages and no native background agents. Foreground idle alone is not
quiescence, a failed thread lookup is unknown rather than missing, and absence
of the brief's marker inside a bounded history or queue page never proves the
send's outcome — recorded delivery and report evidence never regress.
A late report on
a cancelled assignment stores evidence without reopening the state, and it
never discards a failed queue delete: the receipt and reservation stay until
the runnable native row is positively settled. Reconciliation re-reads
assignment state after every native await, so a newer dispatch, running or
reported state always wins over a stale queue or history snapshot. After
inspection, assignment-settle or coordinator-settle can explicitly
resolve an uncertain operation. A refused retirement or work message names each
blocking A#, its op id and state, and whether only native quiet confirmation is
pending (the sweep releases that by itself). An assignment-settle result leads with what it
confirmed: for a cancelled continuation, delivery only, not quiet or release. Never repeat a send based only on absence of a
receipt, and never remove foreign queued messages: only a positively
identified stale notice can be deleted.

## Handoffs, retirement and fresh workers

A worker's report is its handoff. The standard handoff is rendered on demand from
the stored report (outcome, final message or structured fields, files, checks,
open questions, uncommitted files, pending commands). It leaves out decisions,
which are the user's record. Read it with
`initiative_read {refs:["A7"],detailed:true,fields:["standardHandoff"]}`; the
dashboard's thread details offer **Copy handoff**, next to **Retire worker**.

The coordinator retires a worker once its batch is finished and its thread is
quiet; later related work starts a fresh worker with `handoffs:["W7"]`.
Retirement keeps its guards (idle thread, no queued work, background agents or
live descendants, no running or unconfirmed work). A spawn records which reports
it embedded (`handoffSources`: A#, W#, generation, tasks, state, report version
and revision); a report re-filed while the spawn checks BB refuses that spawn
instead of embedding a stale filing.

## The former projects ID

This plugin was installed as `projects` until the rename. A one-time import
copied the ledger byte for byte, the settings, every thread's metadata and the
Initiative tabs; the import, rollback and migration gate have since been
removed. Two traces remain:

- BB cannot re-stamp `originPluginId`, so threads created before the move keep
  `projects`. Origin checks accept both IDs; everything else, metadata and op
  markers included, uses `initiatives` only.
- The import's bookkeeping tables (`_initiatives_migration`,
  `_initiatives_migration_threads`) stay in the ledger, unused. Nothing drops
  them.

## Read-only context for other plugins

Token-auth GET routes give local plugins (Account Pooler warming, Advisor)
Initiative context from this plugin's own records, with no native call, write, wake
or model call:

- `/api/v1/plugins/initiatives/http/context/v1/thread?threadId=…` returns the
  thread's membership (Initiative, coordinator thread and generation, role,
  W#, this thread's and the current generation, former/retired/stopped, fork
  parent) and its latest delivered assignment plus any undelivered next one.
  Phases (`pending`, `active`, `reported`, `accepted`, `rejected`,
  `cancelled`, `failed`) come from canonical assignment records, so reported
  work stays visible after it leaves the active-work list. An unknown thread is
  `membership: null`.
- `/api/v1/plugins/initiatives/http/context/v1/record?initiativeId=…&ref=T#|A#&part=brief|handoff`
  pages a live task brief, an assignment's exact delivered brief, or its
  standard handoff, at most 16,000 characters per page with `nextOffset`.
  Every page carries `textVersion`, a hash of the full rendered text. A handoff
  also renders decisions, task status and the worker label, which `updatedAt`
  and `reportVersion` do not cover, so a reader compares `textVersion` across
  pages and restarts from offset 0 on a mismatch instead of stitching pages.
- `/api/v1/plugins/initiatives/http/context/v1/initiatives` lists open
  Initiatives (id, name, paused, coordinator), and
  `/api/v1/plugins/initiatives/http/context/v1/members?initiativeId=…` lists
  every thread the thread route places in that Initiative, current and former
  (kind, role, W#, generation, state), in pages ordered by thread id
  (`limit` up to 500, default 200; pass `next` back as `after` until it is
  null). The
  Advisor's Initiative watch reads these; watch an Initiative from the Advisor
  page or with `bb advisor watch --initiative <id|name>`.

Send `x-bb-plugin-token` from `bb.sdk.plugins.token({pluginId:"initiatives"})`.
Every Initiatives response has `version: 1`; errors are `bad-request`,
`not-found`, `no-report` or `store-unreadable`; any other response (BB's own
401, 404 or 500) means the context is unknown.

## Cache, telemetry and recovery

A work message reuses a worker's context. A coordinator handover is written fresh
from recent activity, never from a stored checkpoint. Usage-limit recovery should
resume affected unfinished work; a 429 alone justifies nothing.

The dedicated Usage page shows **Observed usage** from bounded idle samples.
It counts each recorded generation/member thread once, including retained
worker/coordinator generations and user-owned conversations. Thread, model and
role views fold details without dropping usage. Coverage, last observation,
active-thread staleness and detected resets appear in details. There is no
historical scan when opening the page.

Provider totals stay authoritative. Input, cached input, output and reasoning
are shown as reported per thread; components are not combined across providers
or added to reconstruct total. Claude input excludes cached input; its cached
input combines cache reads and writes. Codex cached input is contained in input
and reasoning in output. Missing counters and context values remain unavailable.
Latest context used/window/estimated is a point gauge.

Profile groups identify threads with a source-observed effective provider/model,
with historical allocation explicitly unknown. Changed observed profiles remain
mixed. Legacy model labels never prove token attribution. First/last observation
provenance is retained; old first-observation times stay unknown.

A separate bounded turn cursor persists native start/completion events keyed by
thread and scope.turnId. Completion statuses and paired coverage remain visible;
a missing identity/start leaves elapsed unknown. Paired elapsed is BB wall time
between start/completion timestamps, including all work inside that boundary.
No inference time, cost, quota, hit rate or cache read/write split is estimated.
The real page has no dependency on the external prototype's sample fixtures.

Claude prompt caching is a native provider concern: `promptCacheTtl: "1h"` can
be set in `~/.claude/settings.json` or a checkout's `.claude/settings.local.json`
(user/project/local sources are loaded). BB has no per-thread TTL knob and the
plugin does not patch or wrap providers.

## Known limitations

If BB or the plugin exits partway through starting a coordinator, that start stays pending
and Withdraw stays refused for it until someone inspects the threads and settles it.

## Verify

```sh
npm ci --include=dev
npm run typecheck
npm test
bb plugin build .
```

Tests cover storage corruption, policy, receipt races, queued-brief settle and
archive ordering, guarded retirement, handover drains, role lineage, review
family preference and mixed-authorship reviews, user-owned threads,
legacy-history preservation and dashboard flows.
cron-parser and hono support the SDK's testing harness. Generated bundles and
node_modules are ignored. Upstream capability requests are recorded in the root
README; none were filed.

### Dashboard reads and saved actions

The dashboard requests one compact overview on mount. Realm-local reads share an
in-flight request per Initiative/key, keep the last valid value on refresh
failure, and invalidate pre-save reads at the command boundary. A ledger signal
that lands while a read or save is in flight schedules one more read after it
instead of joining it, because that read may predate the change (T125: a
just-delegated worker stayed missing until the 15 s poll). The Sidebar's tree
refresh follows the same rule; there BB's own thread listing starts such a read,
since it shows the spawned thread before the ledger records it. The catalog owns
its list subscription only while visible. Threads, Usage and Log load detailed
member/usage data when first opened; repository controls load native inventory on
demand. Ledger signals carry Initiative identity when known, with global polling
and reconnect fallbacks. Every entry point that can write (dashboard command, agent
tool, CLI, sweep) runs in one announcing scope that compares the ledger's change
counter around its work: a write announces itself exactly once, also when the work
throws after saving, and a refused command or a read announces nothing (T129).
Dashboard and Sidebar tree reads give up after 30 s, so an RPC that never settles
cannot freeze a view until reload; the next signal or poll reads again.

The Inbox's Blocked workers card has two split buttons (T130). **Send to
coordinator** records the answer as the user's decision and sends it to the
coordinator, as before; its menu's **Send to W#** delivers it straight to the
thread that reported the blocker, which continues the same assignment and reports
again, and then queues the coordinator a short FYI (T132: the worker's receipt is
`answer.delivery`, the FYI is the decision's ordinary coordinator notice; each is
retried alone after a failure, never after an unconfirmed send, and an undelivered
one stays under the Inbox's **Not delivered** once the card is gone). The coordinator is the
default; the worker is the default only when there is no coordinator. **Dismiss**
sends nothing; its menu's **Dismiss and tell coordinator…** opens the note field.
The worker label (W#) in the card's header links the worker's thread. Native navigation, queues and authority guards remain BB's.

A command returns after its durable save and any required native receipt, without
awaiting optional dashboard or Sidebar refreshes. The UI displays that committed
result and receipt immediately; refresh failures leave it visible. Okay remains
private. **Accept all unchecked agent decisions** is one explicit human dashboard
command/transaction. It marks only active pending agent choices Okay, retaining
active records, original owner/recorder and history. Existing Okay/Not okay verdicts,
user choices, questions, inactive records and other Initiatives stay unchanged.
It sends no message and grants no agent bulk-review authority.

The existing global mutation queue remains. A native send can still hold unrelated
serialized commands behind it; these changes do not bypass its ownership guards
or force native queue recovery. Saved per-decision receipts attach only while their
operation still owns the row.

Upstream candidate, no issue filed: A105 observed a native W52 timeline build
reading/decoding 1,364 events and 2,214,024 bytes for 20 segments in 447 ms, with a
606.6 ms event-loop stall window. BB could investigate bounded event/group-context
query work before decoding and projection-relevant invalidation of its existing
sequence cache. This plugin change does not patch/profile BB or claim host CPU
pressure or native timeline costs have disappeared.


## Explicit worker communication

`initiative_message` sends one native message from a trusted current managed
caller, with the SDK's `senderThreadId`. Its input is
`{target:"W4"|"coordinator",text:"Interface fact",mode:"steer"|"queue"}`.
Use steer for an urgent correction/blocker, queue for a future interface fact.
Resolve peers through `initiative_read {view:"workers",limit:8,offset:0}`;
worker summaries include up to three current-generation assignment refs and five
task refs per assignment, with truncation flags. Reads/configuration do not wake
anyone or request global native inventory/usage. Newly constructed sessions get
current W#/generation/role/A#/task context from the ledger, so genuine forks do not
inherit their source's Initiative identity.

Retained sessions use `bb initiative message '<json>'` or the typed command
`bb initiative command '{"action":"message","target":"W4","text":"Interface fact","mode":"queue"}'`.
No `project_message` alias is needed for a tool that never existed; old tools keep
their existing compatibility path. Do not restart agents to update an allowlist.

Targets are current W# work peers or the current coordinator in the same
Initiative. Reviewers coordinate through the coordinator to preserve review
independence. Former/retired/ad-hoc/stopped/cancelled/finished/unconfirmed contexts
cannot use the wrapper. Native unavailable/error/stopping threads are refused. Confirmed pending recipients accept queue mode; steer is refused with their actual pending status.
The wrapper rechecks membership/assignment after native reads and refuses a changed
target instead of rerouting or retrying. The reply is
`{target,threadId,generation,receipt}`, preserving the actual native sent/queued
receipt. A send error names the issued target/generation and distinguishes definite
refusal from uncertainty. Native Stop/replacement can still race after issue;
inspect native receipts, never resend automatically. No separate inbox, scheduler,
transport, work grant, role change or resume path is added.

Direct work peers can exchange an actionable interface fact. Send dependency,
ownership or scope changes to the coordinator. For an unresolved human choice,
include question/context, options/consequences, recommendation and task refs so
it becomes a durable question. Routine phases use progress/commentary. True finish
uses one canonical report plus a short artifact pointer, without a duplicate tell.

Only a positively confirmed ordinary child of the current coordinator relies on
native completion. A genuine fork keeps its native parenting and uses the existing
canonical explicit report fallback, with concurrent dedupe and failed-only explicit
retry. Native routine turn notices cannot be suppressed through this wrapper.
Ordinary fresh worker, reviewer and coordinator starts omit `startedOnBehalfOf`.
SDK0.4.87 exposes the field, but BB0.43.1 rejects it without `originKind`; the only
non-null kind is `fork`. Native parenting, plugin metadata, execution settings and
permission inheritance remain intact. Human starts remain unmarked. Genuine forks
use the native fork API, with no fabricated actor, fork origin or second seed.
Native messages still carry the actual caller's supported `senderThreadId`.

Upstream candidate: support trusted agent actor attribution for ordinary fresh
starts without requiring fork provenance. The current SDK declaration does not
express this native cross-field restriction. This plugin omits the unsupported
field rather than claiming fresh-actor support. Root owns any upstream filing and
the separate notification-policy candidate.

Context manual Refresh reloads inventory once it has actually been loaded, without
forcing telemetry. Bulk acceptance is disabled at zero eligible choices using
backend eligibility. Only unchecked active agent choices qualify; existing verdicts,
questions and user choices stay protected. Generic saved status text is quiet; meaningful answer/close/bulk
and native notification/error receipts remain visible.

The shared **Accept all unchecked agent decisions** control appears beside
**Agent decisions to check** in Inbox and in Decisions. Both locations use backend
`acceptEligible` from the same predicate as the transaction, one shared in-flight
action and error state, and the `decision-accept-all` command. The committed result
updates rows to Okay immediately without removing them, before background refresh.
Inbox hides the section when no unchecked/eligible decisions remain. No eligible
records means no request. No confirmation, per-row RPC or coordinator message.

The former `decision-clear` handler now refuses with an actionable refresh/use
`decision-accept-all` error. A cached removal page cannot delete records through the
new backend or falsely project acceptance as removal. Existing single-decision
coordinator cleanup remains separately guarded and explicitly user-requested.
Root must reload matching frontend/backend and reopen the dashboard; constructed
agent sessions keep their existing tools/CLI compatibility without forced restart.

The Settings display name is **Initiatives**. Native contracts, CLI compatibility
and data stayed stable across the move from the `projects` ID.

### Failed provisioning and cancelled reservations

BB can accept thread creation and its initial prompt, then fail workspace
provisioning before any provider turn starts. The assignment's `briefDelivered`
flag records accepted delivery, not execution. Its historical `running` ledger
state means the worker owes a result; native status and reports supply actual
liveness/evidence. Fresh delegation returns this receipt distinction explicitly.
A native thread-failed event also does not, by itself, prove a turn started.

Stop retains cancelled business state and late reports. For a previously confirmed
brief, Stop checks native quiescence after recording cancellation. An explicit
same-task delegation can also recheck a known accepted cancelled reservation,
without creating a duplicate task, restarting the old worker or resending its
brief. Release requires the existing positive native end evidence: a confirmed
404/archive/delete, or valid quiet foreground, queue and full background activity
fields. Unknown reads, pending/active work, queued or failed native work, background
commands/workflows/agents, and unconfirmed creates/sends remain guarded. Stop
acknowledgment and absence from bounded turn history prove neither nonexecution
nor settlement. Quiet settlement text names its evidence without claiming the
brief ran; a worker report remains distinct positive work evidence.

A failed provisioning event is useful diagnostic evidence, but cannot bypass the
queue/activity guards. If native state remains unreadable or exposes failed queued
work, the reservation stays held until supported native evidence settles it. This
plugin adds no retry, forced queue drain, scheduler or BB recovery path.
