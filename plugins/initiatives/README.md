# Initiatives

Plugin ID `initiatives` (package `bb-plugin-initiatives`). Until its one-time
move it was installed as `projects`; see "One-time move from the projects ID".

One coordinator across one or more BB repositories, ordinary worker threads,
and durable tasks, reports, decisions and updates. Native tools remain available.
The Control Room dashboard sits beside coordinator chat. Its compact coordinator
strip opens state/home details, replacement and the Initiative menu. Inbox,
Decisions, Threads, Tasks, Context, Log and Usage keep everyday controls in this
panel.

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
The CLI works immediately. Change coordinator opens a live model picker and
starts a fresh thread from the Initiative records and handoff checkpoint. The old
thread stays in history, and unfinished worker reports reach the replacement.
Let the current coordinator finish its turn or stop it before switching — or
ask the coordinator to hand over: it records a durable request and checkpoint
with coordinator-handover — optionally naming a target environment — finishes
its own turn, and the replacement starts at
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

Review substantial milestones. A reviewer remains a reviewer across continuation,
forks and adoption. Each review starts as a fresh, read-only thread bound to the
reported task, assignment and revision, never a continuation or fork of an
implementer's context. A reviewer from a different model family is the default
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

BB Settings exposes populated coordinator and worker instructions plus a
validated JSON map of default execution profiles. The native multiline fields
are the editors. A compact section shows effective global fallbacks and resets
each field to its populated default. The canonical guidance defaults are in
`lib/guidance.ts`; skills point to this configured guidance instead of keeping a
second behavioral copy. Instruction edits allow at most 3,584 characters,
reserving 512 of BB's 4,096-character dynamic instruction limit for immutable
role/start notices. Empty, overlong or invalid profile edits are rejected before
persisting, without losing valid settings. Profile save validation checks the
existing schema; target-machine model, reasoning and Fast availability are
checked on dispatch, where unavailable choices fail without fallback.

Settings saves update the configuration snapshot through the existing native
settings change notification. SDK 0.4.87's synchronous configure callback reads
that current snapshot and fails closed until its persisted initial load resolves.
BB applies dynamic instructions when it constructs a new or resumed provider
session; it does not hot-update an already-constructed session. A normal next
turn can retain that session, so saving alone does not guarantee new instructions
on that turn. Skills follow BB's safe runtime relaunch boundary. Dispatch awaits
a fresh settings read: continue/fork briefs carry current worker guidance into
retained contexts, while fresh workers receive it through session configuration.
No Settings save restarts, spawns or wakes agents. Root owns reload/live checks.

Profiles follow explicit user task choices, explicit delegation/task profiles,
recorded Initiative policy, then plugin Settings global fallbacks and existing
built-in defaults. A profile without a tier leaves native tier inheritance
available; an explicitly selected user tier wins. Continue/fork keep current
native worker execution and replacement keeps incumbent settings unless explicitly
overridden through supported fields. Settings never rewrite stored Initiative
policies, including bb-plugins' GPT preference. The existing replacement picker
uses the current global fallback only when no Initiative coordinator profile
exists. Worker details show the latest delivered assignment profile, including
native settings recorded by its report; unobserved tiers say "tier unspecified".

Coordinator defaults call for light context/status upkeep and closing superseded
tasks after meaningful batches. Knowledge removal and the dependent dashboard
contract redesign is described below.

## Scoped delegation and worker choices

Read recorded Initiative policy and explicit user/task choices before selecting
settings. The current bb-plugins policy remains GPT workers. Good means a
deliberate choice of `claude-code / claude-opus-5-5 / high / default`.
Fast means `codex / gpt-6.1-sol / high / fast`. These are documented choices
through editable profiles; they do not create presets or change other
Initiatives. Existing profiles without `serviceTier` still decode.

`profile.serviceTier` optionally accepts `default` or `fast` on policy, task,
delegation and coordinator commands. Fresh and continue forward it through
native execution fields. Omission uses native defaults on fresh threads and
preserves the worker's current native settings on continue/fork. An explicit
user task tier wins; an unavailable Fast tier is rejected without fallback.
Native fork in SDK 0.4.87 copies the source's last model, reasoning and tier and
has no override fields for them. Initiatives checks that inheritance and rejects
incompatible fork choices before creation. Use continue or fresh to select
different settings. `permissionMode` remains the existing explicit parameter
on fresh/fork and the continuation send; pass `full` when instructed. Replacement
coordinators inherit effective tier and permissions unless the profile explicitly
changes the tier, preserving the existing replacement controls.

Start a worker with its complete scoped task brief in one native spawn. There is
no Ready-only turn or raw-spawn/adopt/rebrief ritual: a raw native start can
bypass the worker identity, assignment and guidance that initiative_delegate
provides. Existing native children remain visible members; reuse or adopt
relevant context rather than recreating work to fit the ledger. For example,
after creating and briefing T12:

```sh
bb initiative command '{"action":"delegate","route":"fresh","tasks":["T12"],"label":"Search","area":"Archived search","profile":{"providerId":"codex","model":"gpt-6.1-sol","reasoningLevel":"high","serviceTier":"fast"},"permissionMode":"full"}' PROJECT_ID
```

Declare `access: "read-only"` on a delegation for an audit that must not write
source or install state. Access belongs to the assignment and is persisted before
dispatch, including queued and uncertain operations. Work defaults to `write`
when omitted on every route, including continue and fork; repeat the declaration
for each audit. Legacy work assignments remain potential writers. Reviewers
remain read-only under their existing role and independence rules.

Readers can share overlapping paths with readers or writers; overlapping writers
must wait or use separate checkouts. Task ownership, Pause and Stop reservations
still apply.

A write assignment's paths are recorded when it is dispatched or checkpointed;
later brief edits do not change them, and an assignment recorded before this
has no scope and is held as the whole project. After a writer reports (and also
once it is accepted, rejected, idle, stopped, cancelled or failed), its scope stays held while its
native thread is still running, cannot be proven quiet, or its report lists
background work. Every past write on the thread counts, not only the latest. A
delegation reads this once, before its final reservation check: one project
listing pass plus a GET only for threads it did not return. Listed background
work is unverified and holds even after BB shows the thread ended, the report is
rejected or the worker is retired. It is released by a refreshed final report
without it (a rejected assignment takes no later report), or by
`assignment-scope-release` with a reason once you have checked those jobs and BB
shows the thread ended (`bb initiative describe scope-release`). The release
echoes the `reportVersion` you read (shown by initiative_read and in the hold
message), so it applies only to that filing: any later report, even an identical
re-file after a relaunch, has a new version and needs a new check. When several
reports on one thread list work, the hold message shows the oldest one's own
jobs and version and names the others. BB's end evidence comes from the thread
itself (archived, deleted, missing, or quiet in its own project listing) and is
recorded with the release. A release keeps the report as filed and is not
evidence that the jobs finished. Retiring a worker requires its thread's own
list row to be quiet (no background commands, workflows, agents or queued work)
before anything is archived or stopped. Continuing the same worker is exempt: BB
queues the brief behind its foreground turn, but its background jobs are not
ordered behind it, and the same agent context owns them. A fork into the same
checkout is a new writer; the default fork runs in its own worktree. Access is a
coordination rule, not a filesystem sandbox: an audit with `permissionMode:
"full"` must still refrain from source/install writes. When reading paths under
live edits, report the actual revision/source state checked, including
dirty-file hashes or a captured snapshot where needed.

Retained sessions can use the existing CLI if their tool schema lacks `access`:

```sh
bb initiative command '{"action":"delegate","route":"fresh","tasks":["T13"],"label":"Audit","area":"Search audit","access":"read-only","permissionMode":"full"}' PROJECT_ID
```

Use that fallback without restarting or waking agents to refresh instructions.

Native messages carry decisions, blockers or new facts that change another
agent's next action. Routine phases belong in `initiative_progress` or human-facing
commentary. Submit one canonical `initiative_report`, then a short final pointer;
do not also tell the coordinator the same result before native completion.
Native completion and the existing fallback for workers without a native parent
stay intact. Genuine errors, Stop requests and permission boundaries still need
attention. Do not automatically wake agents just to publish progress.

Keep follow-up briefs to the remaining outcome, scope, necessary interfaces,
exact checked revision, remaining checks and evidence references. Reuse worker
context; use fresh bounded handoffs at real milestones when useful. Review
substantial milestones and focus correction checks on the changed behavior.
Productive design exploration and verification remain necessary; every repeated
test or design revision is not waste. Fast tier alone and combined usage
telemetry do not establish cache hit rates, subscription or monetary savings.

Coordinator tools: initiative_read, initiative_manage, initiative_task,
initiative_delegate, initiative_worker, initiative_decision and initiative_update.
Workers get initiative_read, initiative_progress, initiative_report and
initiative_decision. User-owned threads get initiative_read and initiative_update;
unmanaged threads get initiative_create. The CLI is `bb initiative`. Every tool
publishes an object-root schema, because Claude's bridge blanks a top-level union:
initiative_task, initiative_manage and initiative_worker (and their `project_*`
aliases) list each action with its required fields and every field's real nested
type, while the strict per-action command schema still validates each call.

Decisions have automatic D numbers and one or two sentences. The dedicated
initiative_decision API requires `madeBy` user or agent and records the originating
thread/assignment separately as provenance. Current coordinators and workers can
record explicit user choices from their own chat as `madeBy: user`; the recorder
does not become the choice's owner. Never infer a user choice or include defaults
added by an agent in that user's choice. Record agent choices
only for independently chosen, non-obvious significant design forks. Normal steps,
checks, restatements, mandated implementation, routine reporting, audit/review
setup and requested clean SHA/execution settings belong in progress or handoff
artifacts. An agent choice cannot supersede
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
{"action":"decision","madeBy":"user","description":"Erwin chose Base UI.","supersedes":"D7"}
{"action":"question","question":"Where is the Monolith repo?","context":"Not under ~/Code.","options":["Point me to it",{"label":"Skip","consequences":"Monolith waits."}]}
{"action":"answer","ref":"D12","choice":"Skip","note":"Erwin said so here."}
{"action":"cleanup","ref":"D13","operation":"accept","reason":"Erwin asked to accept agent choices."}
{"action":"withdraw","ref":"D12","reason":"Settled by D15: Erwin chose Base UI in chat."}
```

A question is always an open user choice: no `humanAttention`, and its title
defaults to the question. The tool and `bb initiative command` share one parser;
older nested `decision:{…}`/`question:{…}` payloads, `decision:"D#"` targets and
`decision-cleanup` keep working. A question shaped like a taken decision
(`outcome`/`rationale`) is refused unless it is a legacy payload with
`humanAttention: "needs-opinion"`. Conflicting duplicates, unknown fields and a
missing `madeBy` are refused with a valid example. Answering an agent choice
points to coordinator cleanup, and superseding an open question explains that
only the user's explicit answer closes it. Open questions display their question
rather than a proposed outcome.

```sh
bb initiative command '{"action":"decision","decision":{"description":"Reuse the existing index.","madeBy":"agent"}}' INITIATIVE_ID
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
or log line can wake the coordinator per matching line. Assignment briefs and
the default worker guidance therefore ask workers to wait for their own checks
within the turn where the tool allows, or on their tool's single completion
notification. Monitors for actionable events stay fine. Saved copies of the
previous defaults upgrade by exact clause; edited text is left alone. There is
no plugin inbox, batching or wake layer; routine progress is ledger state the
coordinator reads when it next acts. Reported work stays in flight while its
native thread is active, then waits in awaiting-acceptance until the coordinator
accepts or rejects it. A blocked or failed report cannot be accepted, and Stop
does not apply to reported work: to retry, `assignment-reject` it with a reason
(`bb initiative describe reject`). Its report, blocker and handoff stay in the
ledger, the task becomes plannable, and the coordinator delegates it again,
usually as a continuation to the same worker with the blocker's answer. A
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

On reload, recognized old decision-recording clauses in saved guidance are
upgraded in place. Custom text outside those clauses and execution profiles stay
unchanged. No agents are restarted or woken. Already-constructed sessions keep
their old instructions; corrected tool guards and `bb initiative command` remain
available, and the next session/continuation uses the updated guidance.

```sh
bb initiative list
bb initiative overview PROJECT_ID
bb initiative read assignments PROJECT_ID '{"refs":["A7"],"detailed":true}'
bb initiative command '{"action":"pause","paused":true}' PROJECT_ID
bb initiative report '{...structured report...}'
bb initiative reconcile
```

Agent `initiative_read` with no selectors returns a compact overview: counts,
current work, human attention and a short checkpoint. It does not fetch/duplicate
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
`report.handoff`/`report.evidence` for assignments. Explicit `threads` and `usage`
views are independently paginated. `bb initiative describe` provides valid short
JSON examples for reads, questions, checkpoints, reviews and urgent continuations.

Reviews bind to a successful final work report or coordinator-recorded checkpoint,
its actual task and checked revision. `reviewTargets:[{task,assignment,revision}]`
and `reviewOf` must agree; assigning an unrelated task to bypass a stale status
fails at the boundary. The generated brief and reviewer policy use the linked
assignment's actual recorded implementer profile. Native uncertain/queued/stopped
work cannot be used as settled review evidence. Task status alone is no proof.

`task-checkpoint` records explicitly described external/native work from the
actual managed worker on the actual task, with a complete report/handoff revision.
It sends no turn, invents no worker-authored report, and records the coordinator's
provenance. An optional source assignment must belong to exactly that worker,
generation and task and still be running/idle with no report; reported worker
evidence cannot be replaced. Omit assignment to append a separate milestone and preserve earlier work. A worker's own later report clears coordinator-checkpoint attribution,
even for an identical evidence body. Existing report details display a small
Coordinator checkpoint label with recorder/source provenance. It records reported
work; verified evidence, explicit acceptance and task
completion remain distinct. Stop/current-coordinator/role/ownership/receipt guards
still apply: an unresolved (pending/uncertain) operation or a live queued brief
blocks a checkpoint, also when it appears during the native read. A cancellation
whose operation is already settled is history and does not block a new,
separate checkpoint. Never infer a checkpoint from arbitrary transcript prose.

Only the current coordinator may use `decision-cleanup` (`accept`, `veto`,
`remove`) when the user explicitly requests a scoped cleanup. Pass the request's
reason; never approve/reject/remove decisions merely to silence Inbox. Accept/veto
uses existing Okay/Not okay semantics without a self-notification. Removal hides
an agent choice from active Inbox/Decisions, preserving owner, original recorder,
any existing native delivery receipt and an append-only cleanup history. Detailed
refs/history reads retain removed records. Review/acknowledge and supersession
refuse any non-active decision before saving or sending. User choices and questions are protected;
workers, former/foreign coordinators and ad-hoc agents have no cleanup authority.
`bb initiative describe decision-cleanup` shows a valid example. No transcript
classifier, approval token, automatic cleanup or native queue cancellation is added.

Use action `question` for an unresolved human choice: question/context, options
with consequences, recommendation and affected `blocksTaskIds`. Ask intentionally;
never infer user questions/answers from transcripts. Explicit chat answers resolve
that D ref via `answer`; notification/quiet/close behavior above stays available.
After the last blocking question resolves, the task returns to its recorded
running/reported stage (or planned if there is no such work). Quiet close records
no answer and never accepts or completes the task.

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

Continue dispatch uses `delivery:"queue"` (default) for future work and
`delivery:"steer"` for an urgent correction/blocker. Actionable human answers and
Not okay reviews steer-if-active; worker chat sends carry the recording thread as
native sender. Fresh briefs carry the coordinator sender and native parent;
replacement seeds carry the predecessor when there is one. Unparented report
fallbacks preserve the worker sender, steer blockers, queue routine completion,
and retain honest sent/queued/failed/uncertain receipts. Native BB owns queues and
holds; this adds no automatic retry, drain, bus, keepalive or recovery scheduler.
An explicit repeat of the same canonical report may retry a definite failed
fallback notification. Pending/sent/queued/uncertain receipts never authorize
another send; concurrent identical calls see pending before native inspection.

Upstream candidate (no issue filed): SDK 0.4.87's fork request has no senderThreadId,
although spawn/send do. A fork brief therefore keeps native source-thread lineage
and durable assignment provenance; it cannot accurately set the coordinator as
native sender without SDK support. Propose that optional field upstream rather
than adding a second bootstrap/send. Existing event filters and queued receipts
support inspection; a vanished queued row or lost send response still proves no
delivery outcome by itself. Do not infer dispatch from absence or force a resend.

Native operations are journaled before sending. A lost response remains uncertain
and reserves its task/workspace. Reconciliation requires positive metadata,
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
resolve an uncertain operation. A refused reuse names each blocking A#, its op
id and state, and whether only native quiet confirmation is pending (the sweep
releases that by itself). An assignment-settle result leads with what it
confirmed: for a cancelled continuation, delivery only, not quiet or release. Never repeat a send based only on absence of a
receipt, and never remove foreign queued messages: only a positively
identified stale notice can be deleted.

## Handoffs, retirement and fresh workers

A worker's canonical report is its handoff. Nothing is stored twice: the
standard handoff is rendered on demand from the assignment's report (outcome,
result, revisions, files, checks, artifacts, open questions or blocker, next
steps, uncommitted files, pending commands and listed background work with its
release state), plus the decisions that assignment recorded. Read it with
`initiative_read {refs:["A7"],detailed:true,fields:["standardHandoff"]}`; the
dashboard's thread details offer **Copy handoff** and **Copy delegate field**
for a worker's latest report, next to **Retire worker**.

Default guidance (Settings) follows the user's choice: once a worker finishes
its set of tasks, the coordinator retires it when it is settled and quiet,
unless ready same-scope work or direct review fixes remain. Later related work
starts a fresh worker with `initiative_delegate {..., handoffs:["A7"]}`. Reuse
through continue/fork stays available; the guidance is a default, not a refusal.
Reporting never stops, archives, retires or accepts anything, and retirement
keeps its existing guards (idle thread, no queued work, background agents or
live descendants, settled assignments).

`handoffs` takes up to three A# with a stored report. Each must cover the new
tasks, one of their `dependsOn`, or a T#/A# named in their briefs'
`contextRefs`; reviews refuse it (they bind `reviewTargets`). A refusal suggests
naming the source T# or A# in `contextRefs` or delegating the source task itself;
`dependsOn` is suggested only once the source task is done, because it also holds
dispatch until then. The fresh brief
embeds each handoff as reference only: it says it grants no authority,
acceptance, receipts, permissions or write scope, and asks the worker to verify
it against current source. Narrative fields and long lists are shortened with
an explicit note and a pointer to the full record; uncommitted files, pending
commands and listed background work are never shortened. The new assignment
records only provenance (`handoffSources`: source A#, W#, generation, tasks,
state, report version and revision); its own identity, tasks, write scope and
receipts are its own. Sources are re-read after the last native await, and a
re-filed or re-stated source refuses the dispatch instead of embedding a stale
filing.

Default coordinator guidance also follows the user's staffing choice (D365,
D366). Each related batch starts with one work worker, combining related tasks
and features instead of one worker per plugin or small task. A substantial batch
gets one fresh independent review, and small fixes are not re-reviewed
automatically. More work workers need an explicit user request, or a question
the user answered yes. Asking alone, silence, elapsed time, existing profiles, a
busy worker or a parallelizable plan are not approval. Raw spawns, spawns
started from a shell and work subagents count as workers; other shell commands
do not. Audits declare their access read-only on every route, even with full
permissions, because omitted work access writes. This is guidance,
not an engine limit: there is no approval protocol or worker cap, and explicit
user and Initiative profiles still win. Routine progress notices get no reply;
the coordinator acts on final results, blockers and user questions. Native
notices still arrive and cannot be muted. Worker guidance adds one matching
sentence: start no extra work workers or work subagents unless the brief says
so.

Saved guidance upgrades by exact clause. Each rewrite applies only while the
text still fits the 3,584-character bound, so a long custom text keeps the
longer retirement clause in its earlier wording while shorter rewrites still
apply. Passes repeat until nothing changes, so the saved text is already the
stable result and the next load rewrites nothing. Edited clauses and custom text stay untouched; nothing restarts.

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

Continue and fork reuse a worker's context. A coordinator handoff carries a
bounded checkpoint into the replacement's seed. Usage-limit recovery should
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
failure, and invalidate pre-save reads at the command boundary. The catalog owns
its list subscription only while visible. Threads, Usage and Log load detailed
member/usage data when first opened; repository controls load native inventory on
demand. Ledger signals carry Initiative identity when known, with global polling
and reconnect fallbacks. Native navigation, queues and authority guards remain BB's.

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
