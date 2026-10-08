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
3. W190 **reports with `initiative_report {outcome:"done"|"blocked"|"failed",
   summary, report}`** (D417): `summary` stands on its own (outcome, PR URL and
   head, merge order, what is needed; its first 300 characters are the dashboard
   line), `report` is the full text. The plugin records it and sends the
   coordinator one message, e.g. "W190 reported (done) on A301: Search covers
   archives", followed by the report when it is at most 1200 characters. A longer
   one (W215) arrives as its summary (up to 1000 characters), the PR links its
   body names that the summary doesn't (up to 3) and the `initiative_read` call
   for the full report; a blocked one leads with the question.
   Blocked needs the question, which also waits in the Inbox. A worker that never
   calls the tool has the final message of the first normally completed turn
   after its brief arrived recorded as its report (a resumed turn counts; for an
   adopted thread, after the adoption), for the dashboard only: it is not sent.
4. A reviewer: `initiative_spawn {role:"review", reviews:"W190", ...}`. Its brief
   embeds W190's latest report, it reads W190's checkout, and it reports findings
   the same way. No revision strings.
5. Fixes go to a fresh worker (W259): `initiative_spawn {handoffs:["W190",
   "<the review's A#>"], ...}` embeds the implementation report and the review
   findings. Only a tiny related fix goes back to W190 while its cache is warm:
   `initiative_message {to:"W190", text,
   work:true}` (or `tasks:[...]`). A message without them is just a message.
   Reviewers are never reused: the coordinator retires the reviewer once it has
   read its report (unless it needs to ask it a clarifying question first), and
   each review round gets a fresh one, `initiative_spawn {role:"review",
   reviews:"W190", handoffs:["<the previous review's A#>"]}`, naming the latest
   worker on the change. Work for a reviewer is refused.
6. Done: the coordinator closes T40 (`initiative_task {action:"close", task:"T40",
   outcome:"done"}`) and retires W190. Nothing is accepted or
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
  tools. Its prompt is a dated snapshot packet (at most 60k characters, W188):
  - the old coordinator's conversation counted in messages, not events: its
    latest 40 messages plus inputs back to the user's tenth-latest message, each
    with time and sender. Long replies keep their start and end; the replies to
    the user's last five messages keep up to 8,000 characters each. A user
    message older than that window carries the final answer it got;
  - the commands the old coordinator ran that changed things outside the
    Initiative (automations, merges, pushes, publishes), newest 20, labelled
    "ran, exit 0, not verified" or with their failure: evidence, not proof (a pipe
    can hide a failure). Commands that set a secret are never listed;
  - each live worker's native status, current work, latest report (wherever it
    falls) and its own latest messages (paged past tool calls); native threads
    under the coordinator without a W#; the destination checkout the replacement
    will actually use (a reuse override, else the default source checkout), next
    to the outgoing one (branch, ahead/behind, working tree);
  - open tasks, with the coordinator's latest word on each when newer than the
    task note; what waits on the user (agent decisions are optional Inbox checks);
    updates only when newer than the conversation;
  - the current status of every D#/K# and closed T# the packet mentions.
  A read that fails says "unavailable", never empty. Credentials are redacted from
  every input before the packet is budgeted (`lib/redact.ts`), by specific shapes
  only: known key prefixes (`sk-`, `ghp_`, `xox…`, `AKIA…`, JWTs), `Bearer …`,
  secret-named URL parameters, `KEY=value` and JSON `"key": "value"` with a
  secret-like key name, and whole lines setting a secret (`bb secret`,
  `gh secret set`, …), and a quoted token named in prose a few words after a
  credential word ("the console token `Y969NG9…`": 16+ characters mixing upper
  case, lower case and digits, at most two separators). A secret-named key whose
  value is on the next line, and a secret command's heredoc, are covered too.
  Ids, hashes, paths, file references (`lib/secret.ts:123`) and names like
  `DOPPLER_TOKEN` stay readable.

  **Redaction is best effort.** Known residuals: a mixed-case hex string or a
  Windows path assigned to a secret-named key is redacted although harmless;
  `X=$X` loses its `$X`; and anything no pattern recognizes goes through, such as
  a bare secret in prose with no credential word near it. The packet goes to the
  writer thread and the fallback to the new coordinator; both can already read
  the Initiative's threads it comes from. The decision log is
  not included (D402). Its final message becomes the new coordinator's first message,
  dated by the capture, and is kept nowhere else; the writer thread is archived.
  If Luna is unavailable, fails or takes more than 10 minutes, a plain listing of
  a smaller packet is used, so a replacement never blocks. Old checkpoints stay
  in the database and are never injected.
- **Fresh handovers**: each draft records when it was captured and a fingerprint
  with one value per packet source: the incumbent and its status, latest user
  input, latest activity and checkout; each live worker's status, latest event
  and pull request; the threads under the coordinator; the destination checkout;
  the latest ledger change. A failed read is "absent" (404) or "unavailable",
  never a timestamp. Only "absent" is a stable answer: when the coordinator's
  input can't be read, the replacement holds (as a queued request) and retries. Drafts older
  than 30 minutes by capture are written again. Otherwise:
  - a preview (written before the replacement could run) is used only if the
    whole fingerprint still matches;
  - a replacement draft (written once it could) only needs the incumbent and its
    conversation unchanged: workers and the ledger keep moving while Luna writes,
    and rewriting for them would never converge on a busy Initiative;
  - a draft written again for a replacement is final: only new input from the
    user sends it back, so worker notices waking the coordinator cannot hold the
    replacement off for ever.

  One check, shared by the direct and the queued path, runs right before the
  start is recorded: first the whole fingerprint, then the last awaited reads
  (is the incumbent quiet, has the user written since the capture), then the
  request and cancel gates synchronously; the start is recorded with no await
  after it. A replacement queued behind a busy coordinator is therefore written
  from its final state. By design, a worker blocker or a coordinator conclusion
  that arrives while Luna writes may be missing: the first message tells the new
  coordinator to read the overview first, since things may have moved since the
  capture time. The dashboard shows the preview in an editable box: the box
  follows the latest draft until the user edits it; only an edit is sent, as the
  user's own text.
- **Restart**: `bb initiative recreate-coordinators (--all | <id>...) [--dry-run]
  [--wait=<seconds>]` writes a fresh handover for each open Initiative (at most
  three writers at a time) and starts a fresh coordinator with it; a busy
  coordinator is replaced when its turn ends, so the coordinator running the
  command is replaced last. `--dry-run` prints the handovers without starting
  anything; a real run reuses them only under the fresh-handover rule above.
  Workers keep their threads and move to the new coordinator.
- **Older sessions** keep working: `initiative_delegate`, the full structured
  `initiative_report`, `initiative_progress` (now a no-op) and the old
  `initiative_task`/`initiative_manage`/`initiative_worker` actions still run.
  Removed actions (task-accept, review-accept, assignment-reject,
  assignment-scope-release, task-checkpoint, decision-cleanup, fork) answer with
  what replaces them.
- **Existing data** stays readable and nothing is dropped: old structured reports,
  accepted/rejected assignments, D# history and checkpoints render as before.
  Tasks left "awaiting acceptance" show as reported and open until closed. The
  only additions are the `handover_drafts` (with its fingerprint, capture time
  and purpose) and `plugin_flags` tables and an optional `finalMessage` in the
  report JSON.

Coordinator tools: `initiative_read`, `initiative_spawn`, `initiative_message`,
`initiative_task`, `initiative_worker`, `initiative_decision`, `initiative_update`,
`initiative_manage`. Workers get `initiative_read`, `initiative_report`,
`initiative_message` and `initiative_decision`. User-owned threads get
`initiative_read` and `initiative_update`; unmanaged threads get
`initiative_create`. Every tool publishes one flat object schema (Claude's bridge
blanks union roots) and validates it on the server. The published schema keeps its
length bounds, so agents see the limits the server enforces, and leaves out
`$schema` and zod's implicit integer maximum, which only cost tokens (T143). Claude Code loads `initiative_zoom`, `initiative_read`,
`initiative_message`, `initiative_spawn` and `initiative_batch` upfront
(`alwaysLoad`, a fork Plugin SDK field an older BB ignores); the others stay behind
ToolSearch. The CLI is `bb initiative`;
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
then named glyphs for PRs/Context/Log/Usage, then a scrolling strip. Keyboard
navigation uses arrow/Home/End.
Usage reuses the real bounded observations described below; no prototype fixture
or mock action is imported. The external prototype and feedback data are separate.

### Merge queue (PRs tab)

The dashboard remembers its open tab per Initiative. On the Initiatives page
the tab is part of the route (`/plugins/initiatives/initiatives/<id>/prs`,
replaced in place as tabs change, so back still leaves the dashboard); a
thread's side panel has no route, so both remember the last tab in
localStorage and reopen it when the dashboard mounts again, e.g. after a
browser tab took the panel. The PRs tab's list or graph view, grouping and
filters are remembered the same way.

The PRs tab lists the open pull requests authored by the `gh` account (`gh api
user`, resolved once) in the GitHub repositories of the Initiative's member BB
projects. A project's repository comes from the `gitRemoteUrl` BB records for
it (its `origin`); projects without a GitHub remote are named in the footer.
For bb-plugins that is `erwinkn/bb-plugins` and, through bb-fork,
`erwinkn/bb`.

Each row shows the title, `repo #number` (the owner is dropped for the user's
own repositories), `head → base`, when it was opened and last updated, the
checks rollup with counts, the review decision (omitted when the base branch
requires none), mergeability, and the W# whose thread pushed it. That last one
costs nothing: BB worktree branches end in `-thr_<id>`, matched against the
workers' recorded threads.

Rows also show the diff size (`+908 −386`, then files and commits) and the
reviewers, each colored by their latest review (approved, changes requested,
commented) or amber while a review is requested; three show, the rest
count as `+N` with all of them on hover. The graph's nodes carry a compact
`+1.2k −386`, and its hover card the full size, last update and reviewers.

Rows are grouped by workflow stage, oldest first within a stage: **Ready for
you** (`ready-for-erwin`), **In review**, **Ready for review**, **Being worked
on** (`working`) and **Experiments**. The coordinator records a PR's stage with
`initiative_pr` (below). Without one, the stage is guessed from GitHub: a draft
is being worked on; approved, with green or no checks and mergeable, is ready
for you; anything else is ready for review. A guessed stage carries a faint
italic "guessed" tag; a recorded one carries no tag and shows the
coordinator's note under the row, with when it was set on hover. The row's
glyph color still shows GitHub health (green ready, amber waiting on checks,
review or mergeability, red failing checks, conflicts or changes requested,
grey draft), and its tooltip says why.

**Categories, stacks and the graph (D437).** The coordinator may give each PR a
free-form category ("Security", "CI"). Once any PR has one, the list groups by
category, then stage (a switch flips it to stage, then category), with
uncategorized PRs last; without categories it stays the plain stage list. A
PR whose base branch is another open PR's head branch in the same repository
is *stacked* on it (`lib/pr-map.ts`); stacks are trees, and a row shows its
place as "2 of 4 · on #2172" (level, the stack's height, the PR beneath). A PR
is **available** to review when it is ready for you and so is every PR beneath
it, so an all-ready stack can be reviewed bottom-up in one sitting; a ready PR
on an unready base says "waits on #N" instead. A base branch that is no open
PR's head (the default branch, a merged PR's leftover branch, someone else's
PR) counts as the bottom. **Next up** lists the available PRs, oldest stack
first and each stack bottom-up. Filters: one category, any set of stages, and
"Review now" (available only); stage chips count within the picked category.

**Graph** draws one lane per category: each stack as a small tree (straight up
a chain, an indented elbow where it branches; base below head), the unstacked
PRs after it in a grid. Nodes are colored by stage (green ready for you, blue
in review, amber ready for review, hollow grey being worked on, hollow violet
experiment); available ones are tinted and ringed. A piece of a stack whose
lower PR is in another category or filtered out says "on #N". Hovering or
focusing a node shows the title, stage, availability, stack position, worker,
GitHub health and the coordinator's note; a click opens the PR like a row.

A click opens the PR through `useBbNavigate().openUrl`: a tab of BB's built-in
browser on desktop while "open links in the app browser" is on (BB's default),
the external browser otherwise, and a new tab if the host declines. The row is
a real anchor, so modifier clicks, middle clicks and copying the link work as
usual.

The server keeps one cache per repository, shared by every Initiative and
client (`lib/merge-queue-server.ts`). Nothing waits on GitHub (D441): the
`mergeQueue` RPC and `initiative_read {view:"prs"}` answer from the cache at
once and start a fetch behind the answer when a repository's last attempt is
two minutes old, or on Refresh (at most once per 10 s). The repository shows
`fetching` meanwhile, and the end of each fetch is announced on the
`merge-queue-changed` realtime channel, so the dashboard reads again at once.
Until the first fetch lands the tab shows skeleton rows. Each fetch is one
asynchronous `gh pr list --repo R --author LOGIN --state open --json …`,
capped at 200 PRs, and beside it the details query for sizes and reviewers
(additions, deletions, changed files, commit count, latest reviews, requested
reviewers): `gh api graphql`, one call per page of 50 and never more than the
list's 200 PRs (about 3 s a page). They can't share one query: GitHub answers
502 when `gh pr list` asks for additions beside the checks rollup at 100 PRs a
page. Every `gh` call has a 20 s timeout, the details pages 20 s in all (each
page gets only the time left), and a repository has at most one fetch in flight: it is released only when both the list and the details have
settled. A failed details query never fails the list: it keeps the last sizes,
hides reviewer states (they may have changed) and says so above the list. No
token is stored. A failed fetch keeps the last good list with "Couldn't
refresh" and the error; a repository that never loaded shows the error with
Retry.

## Backend and tools

**PR records.** `initiative_pr {prs:[{url, stage?, note?, category?, waitingOn?,
changes?, decision?, worker?, assignment?, notes?, answered?}], rename?:[{from, to}]}`
(the coordinator; workers add notes only) keeps one record per PR, several PRs per call, in one
transaction: `stage` is `working`, `ready-for-review`, `in-review`,
`ready-for-erwin`, `experiment`, or `clear`. A URL may carry any suffix
(`/files`, `?diff=split`) or be `owner/repo#12`; it is stored canonical and
lower case, one record per PR per Initiative (table `pr_records`). One invalid
entry rejects the whole call. A record on a PR that closes or merges simply
stops showing, since the queue lists open PRs only; its row stays.

Only the fields an entry gives change, and `null` clears one. A stage replaces
its note (at most 200 characters) and records when it was set; `clear` removes
the stage, so the queue guesses it from GitHub again, and keeps the rest.
Where a PR stands (D438): `waitingOn` (one line, "W188: move the lock to
resume"), pending `changes` requested (one line each, replaced whole), the last
`decision` (`{text, link?}`, the link a URL, a BB thread id or a ref like
D437), and the `worker` and `assignment` on it. An assignment names its
worker unless the entry names one; unknown W# or A# refs are rejected. A
record with nothing left in it is deleted. `discussion_thread_id` is the hook
for D439's "Discuss" threads; nothing writes it yet.

A category is 1 to 40 characters; "Uncategorized" is reserved for the PRs
without one. One that differs from an existing category
only in case takes the existing spelling. `rename` moves every PR of a
category (any case) to another, merging into it when it exists; an unknown
source rejects the call. The result lists every category with its PR count so
the coordinator reuses them, and echoes the other fields it changed by name.

Without a recorded worker, a PR's worker is the latest assignment that names
it, in its brief (the PR it was given) or its report (the PR it opened or
reviewed), so a reviewer shows as "W190 · A385 (review)". Without either, it is the worker whose BB worktree branch
opened it. The scan runs only when an assignment changes (`AssignedPrs`).

**PR notes (D442).** Each PR also has an append-only log of notes (table
`pr_notes`): `{n, at, author, kind: note|question|comment, text, link,
answered}`. `notes:[{kind?, text, link?}]` appends (up to 1000 characters
each; the link defaults to the caller's thread) and the result gives each new
note's number; `answered:[{n, text?}]` closes a question, once. The author is
the caller: `coordinator`, the worker's W#, or `user` from a terminal. A
worker may add notes, and only notes, to the PRs its assignments name, the
coordinator put on it, or its branch opened. When a worker reports, its
summary is appended as a note to each PR the report names (else those its
brief named), linked to the assignment. The queue carries each PR's note
count, last three notes and open questions; the `prNotes` RPC reads a PR's
whole log.

The list shows where a PR stands in one line under its row ("waiting on
W188: move the lock to resume · coordinator asks: Redis TTL? · decided: keep
5m thread"), the decision's link opening its URL or BB thread, and the
latest note below it with a toggle that opens the PR's whole notes log (the
place for D439's "Discuss" action). The graph marks open questions with "?"
and lists every part, and the last notes, in its hover card.

`initiative_read {view:"prs"}` gives the coordinator the queue in a few lines:
Next up with titles, PR numbers by category and stage with stack positions,
each stack as `#1 → #2 → (#3 | #4)`, and `state`: each PR's worker, waiting
on, open questions (`n3 coordinator: …`), note count and latest note, changes
and decision. It reads the same cache as the dashboard, and says when a first
fetch is still running.
`bb initiative pr '<json>' [initiative-id]` is the CLI
form: from the coordinator thread, or from a terminal with the Initiative id.

**Batches.** `initiative_batch {actions:[{tool, ...args}]}` (coordinator only,
1 to 20 actions) runs `spawn`, `message`, `task`, `worker`, `decision`,
`update`, `pr` or `read` actions in order. Each action goes through the same
"parse, then handle" function as its standalone tool, so its schema, errors and
rules are the tool's own; a parse failure is that action's error. A failing
action never stops the rest. The result is `{succeeded, failed,
results:[...]}`, and the dashboard hears one change for the whole batch. A write
action's receipt sits flat in its entry (`{tool:"task", ok:true, ref:"T4",
state:"done"}`), a read keeps `{tool:"read", ok:true, result}`, and a failure is
`{tool, ok:false, error}`. The whole response stays within one read's 64 KiB: past it, an
action still runs but its entry is `{tool, ok, omitted:true, reason}`, with a
`note` to read those results separately. `manage` (pause,
handover, archive) stays a call of its own.

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

Profiles are stored under their original JSON keys but named by role in
Settings: `coordinator` (coordinator), `implementation` (worker),
`experiment` (experimenter), `straightforward` (fast worker), `investigation`
(analyst), `reviewOfClaude` and `reviewOfGpt` (the reviewer for work done by that
model family, so a different family reviews by default). A coordinator picks a
role on spawn with `kind`: `worker` (default, `implementation`: implement a known
change), `experimenter` (`experiment`: prototypes and spikes that answer open
questions by running code; reports options, doesn't ship), `fast`
(`straightforward`: small, well-specified changes) or `analyst`
(`investigation`: reads threads, logs and docs and reports; read and report only,
anything that builds or runs is an experimenter). `investigator` is still
accepted as a deprecated alias for `analyst`, and a worker stored with it shows
as analyst. Swapping a model is a settings change only. The kind is
recorded on the worker and shown beside its W# in the dashboard. An explicit
`profile` on spawn wins over `kind`; a user-chosen task profile still wins over
the coordinator's; a work message keeps the worker's native model; a review
follows the reviewed worker's model family. Per-Initiative `policy.profiles`
override the same keys. Settings never rewrite stored Initiative policies.

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
`permissionMode` is an explicit parameter on spawn; pass `full` when instructed. A new
Initiative's coordinator starts in `full`, never the project default: under `auto`,
Claude Code's classifier blocked benign coordinator actions (T143). Replacement
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
spawn) with **final-reports-only** parent notices (`parentNotices:"explicit"`,
our BB fork, D417): their turn ends never wake the coordinator. A filed report
reaches it as one ordinary BB message from the worker's thread; BB's queue
delivers it, and a failed send is reported back to the worker. Every 3 minutes
the sweep looks for workers that stopped without reporting: a worker with open
or reported work whose thread is idle or failed, with nothing queued or running
in the background (unknown background counts skip it), and no message to the
coordinator since its latest input. The coordinator gets one message per worker
input, "W12 stopped (idle) without reporting since its last input. Its last
message: …", recorded as a `stuck:<initiative>:<worker>:<input seq>` flag. On a
server without the fork the field is dropped or refused; the plugin logs it once
and the worker gets ordinary turn notices, so BB may also wake the coordinator
at its turn ends. Coordinators and threads the user opens keep ordinary notices.
The durable report record never depends on the send. With
turn notices, BB notifies the parent at every turn end (our fork: once the child
settles), so a watcher that ends turns per log line wakes it per line. Since T136 a turn end
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
is mechanically clipped. Selective details use `fields` (which implies
`detailed:true`), e.g. `report` for assignments, or for a W# its latest report in
full. Refs mix kinds (T143), so each record gets the requested fields it has, a
record with none of them is its summary, and `fieldsNotApplied` names the rest
per kind, e.g. `{workers:["body"],decisions:["report"]}`. A selection that applies
to no kind read, such as `{refs:["T1"],fields:["report"]}`, is refused with each
kind's valid fields and a call that works. View `reports` lists reports newest first with a 600-character excerpt of
each final message; view `context` returns the shared vision, objectives and
ideas. A W# read includes its latest report. Explicit `threads` and `usage` views
are independently paginated. A freshly spawned coordinator whose start is not
confirmed yet reads `{identity:"pending"}` with what to do, not "does not belong".

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

### Large cold workers (T142)

More work from the coordinator for an existing worker is refused when the worker
is idle, its prompt cache has expired and its context is larger than the
`coldResumeTokens` setting (default 150,000; 0 turns the check off). That covers
`initiative_message` with `work:true` or `tasks` (also inside `initiative_batch`
and `bb initiative message`), `bb initiative command` delegate/continue and the
legacy `initiative_delegate`. No agent can override it (W259 removed the
`resumeCold` field; it is now rejected as unknown). The user's own sends from
the dashboard are never refused. Resuming would rewrite the whole context into
the cache; a fresh worker with the old one's report embedded is usually far
cheaper:

> W188's cache is cold (last request 23 min ago) and its context is ~480k
> tokens: resuming costs ~600k tokens of cache rewrite. Spawn a fresh worker
> with handoffs:["W188"] (its report is embedded). Agents cannot override this;
> only the user can resume W188 from the dashboard.

A reviewer's refusal suggests a fresh reviewer with `reviews` (the reviewed
worker) and `handoffs` (its findings). The rewrite is priced at 1.25× the
context for a 5-minute entry and 2× for a 1-hour one. Cache state comes from the
Account Pooler (`threads.cacheState`): the prefix, the TTL and any warming lease.
When the Pooler is absent, fails, takes over 2 s (logged once) or has no record
of the thread, the work goes ahead (D426: missing evidence never blocks). So does
a BB thread-status lookup that fails or takes over 2 s, which is aborted and
logged once (D427: the guard never stalls on BB). BB's context record only corrects the size: a snapshot newer than the Pooler's last
request gives the current size (smaller after a compaction), and a compaction
with no snapshot since leaves it unknown, so the work goes ahead. Unknown cache
state is not proof of a cold cache, so the guard only refuses on positive
evidence. A worker that is running, or starts running while the Pooler answers,
always passes; the guard never interrupts or restarts work.

### Lean coordinator context (W215)

A coordinator re-reads its whole context on every request. Equisafe's grew from
25k to 554k tokens in 14 hours, about half of it tool results and report
messages. Three things keep it small:

- **Receipts.** `initiative_spawn`, `message`, `task`, `worker`, `pr`,
  `update` and `decision` answer with a short receipt, never the brief, report
  or text the coordinator just wrote: a task, worker or update is `{ref, state}`,
  a stopped assignment adds its worker and any unsettled `opState`, a spawn keeps
  its W#, thread, profile, note and warnings, a plain message is `{to,
  delivery}`, a PR is `{url, stage}`, a decision `{ref, madeBy, status,
  review}`. `initiative_read` with refs has the full records. Writers sharing a
  checkout get one warning naming them all. The CLI's `bb initiative command`
  still prints full records.
- **Report summaries.** A long report reaches the coordinator as its summary
  (see the example at the top); the full report stays stored and readable.
- **Lean listings.** `initiative_read {view:"tasks"}` and the overview list a
  task as one line (ref, status, title, priority, progress, dependencies, the
  accepted assignment); refs add its summary.

Replaying the Equisafe coordinator's transcript through this formatting cut its
Initiative tool results from 455 KB to 193 KB and its report messages from
339 KB to 32 KB.

**Compaction.** When a coordinator's turn ends with its context larger than its
limit, the
plugin compacts it in place with BB's `threads.compact` (Claude Code's
`/compact`, Codex's thread compaction): the same thread, no handover. It runs
after the coordinator's idle event, without holding up the idle handler, and
stops when the plugin shuts down; BB refuses unless the thread is idle or
errored, so a turn is never cut. The size is BB's latest context-window
snapshot, read fresh from the thread's events rather than from usage sampling,
which can lag behind a long turn; when that read fails, nothing is attempted.
One snapshot triggers at most one attempt; a compaction or clear after it
leaves the size unknown until the next turn; a thread is not compacted twice
within 30 minutes; a paused or archived Initiative, or one with a pending
handover, is left alone. A coordinator replacement or start in flight, or a
handover being written, skips it; a replacement or handover writer that begins
while a compaction call is in flight waits for that call. Each attempt, and any refusal, is in the activity log.
The limit is the Initiative's own (`{"action":"memory","compactTokens":200000}`),
else the setting for its memory mode: `coordinatorCompactTokens` (default
300,000) for regular, `hybridCompactTokens` (default 150,000) for hybrid. 0
turns it off.

## Memory (D431, D447)

Each Initiative has one memory setting, for its coordinator and, once they
exist, its discussion threads (D446). Every mode keeps the same log and builds
the same summary tree of everything the coordinators ever said and saw, so a
switch is instant; it applies from each thread's next turn.

- **regular** (default): one long chat, compacted past 300k tokens.
- **hybrid**: compacts sooner, at 150k; what a compaction drops stays one zoom
  away in the tree.
- **optchat**: each turn is a fresh Claude session over the summary view, as in
  Victor Taelin's [OptChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449),
  in the same BB thread (see [OptChat turns](#optchat-turns-d431-phase-2)). An
  optchat session is never compacted; a coordinator that runs as hybrid
  compacts at hybrid's limit.

Switch it from the coordinator thread's header (the "Memory · Hybrid" pill opens
a popover), the dashboard header under the coordinator, or Context → Memory:
each is a three-way segmented control with a line per mode.
Only the dashboard changes it (D452): `bb initiative command`, the agent tools
and the generic `command` RPC refuse `mode` and `compactTokens` from every caller
(an agent thread, a user terminal, a client), including `compactTokens: null`,
and `{"action":"memory"}` only reads the current setting. The dashboard writes
through a dedicated `setMemory` RPC that no guidance, skill or CLI help names.
Known limit: BB gives plugin RPCs no caller identity, so a local caller who
knows that method can still reach it; real enforcement needs BB to tell RPC
handlers whether the UI or a CLI/agent called (an upstream candidate in the
repository README). A switch never waits behind another write: it only
saves the setting.

What depends on the mode is read at each turn, never fixed in a session: the
compaction limit (read when the coordinator goes idle) and whether a turn runs
in a fresh session (OptChat turns, below). The coordinator's memory tools and guidance are the same in
every mode, because BB fixes a session's tools and instructions when the
session is built. A coordinator from before this (D447) may lack them: outside
regular mode the switch says so until the coordinator is replaced (W244).

**The log** is append-only, It is append-only,
one row per message, across every coordinator thread of the Initiative
(replacements, handovers, compactions), read from BB's own thread events
(`client/turn/requested`, `item/completed`, `turn/completed`, and Claude Code's compaction
summary), the same for Claude Code and Codex coordinators. Kinds: `user`,
`coord` (replies), `tool` (calls), `echo` (results, head and tail within 30,000
characters), `work` (`[W12] …` from a worker, `[bb] …` from BB, including
`[bb] (stopped) …` after a stopped turn, so later views know its reply was cut
off), `note` (handovers and compaction summaries). Thoughts are never logged. It is read
when a coordinator's turn ends, every second while it works, and by the
sweep, which starts the three least recently read Initiatives not read for 5
minutes, so every live Initiative, paused ones too, gets its first log and tree. Threads are read oldest first, and a later one only once every
earlier one is read through, so the log stays in order across slices and
failed reads. Each read first takes the thread's newest event as its boundary,
so an event that lands mid-read waits for the next read instead of being
skipped; a former coordinator's status is read before its events, so it is
marked complete only after a read that began once it was quiet. Newer
coordinators wait for that read, but no longer than 10 minutes after the
replacement: then they are logged, the former's last messages follow when they
land, and the activity log notes it. An Initiative's first log reaches back from the current
coordinator through earlier ones until one that began from a handover or a new
Initiative, whose first message is a note; a failed read saves nothing, and
the next pass looks again.

**The tree** follows the gist exactly, as W216 replayed it: message i becomes
a line of at most 512 bytes (`id+n|text`), adjacent lines merge in pairs into
512-byte lines; text that fits is kept with no call. The chat view (what an
optchat turn sees) is a 128→64 KB sawtooth merged by due = (T+1)/2^l − i;
the memory view, the context of every summarizer call, is the chat view merged
further on a 32→16 KB sawtooth. Both views are saved, never rebuilt. GPT-6 Luna
(`memoryEffort`, xhigh by default) writes the lines with the gist's prompt and
512-dash ruler; a line over 512 bytes gets "Too long …| ← LIMIT" in the same
conversation, up to 5 tries, keeping the shortest. Up to `memoryConcurrency`
(8) calls run at once across every Initiative, let in round-robin by Initiative,
so one large backlog never holds every call while another Initiative waits
(W244); ready nodes wait in a queue; a call waits while another
writes the same cached prefix. A node that fails 3 times is cut to fit (shown as
"cut after failures"), so one bad message never blocks the tree. A 429 pauses
every new call with a growing backoff (or Retry-After); an unavailable route
pauses for 10 minutes. It runs in every mode (D447; the bb-plugins Initiative's
2 MB log cost about $2.40 to summarize whole), detached from the idle handler, and stops on
shutdown or at once when the Initiative is archived (its calls abort and its summary
waiters give up); what is built stays, and a stopped
run writes nothing more. Its progress reaches the dashboards at most every 30
seconds per Initiative (they also poll every 15), so a busy coordinator never
floods every open client with re-reads. Only the nodes in use are held in memory
(a 2 MB cache over the database); a builder's first run finds its ready nodes
from which nodes exist, in slices, and the dashboard reads running counts.

**Luna** is called through the Account Pooler's isolated plugin route
(`/advisor/v1/responses`, the Pooler's plugin token), on the pool's Codex
accounts: no credential of its own. Every call of one Initiative sends one
`session_id`, the key Codex caches a prefix by. It needs the Pooler's codex
advisor route on (`bb pool-local advisor set codex on`) and a Pooler that passes
`session_id` through; until then the dashboard shows "Summarizer unavailable".

**The coordinator** gets, in every mode, `initiative_zoom {id,n}` (the two
lines line id+n was made from; n 1 is the message whole; each line starts with
the time of its first message, `2026-10-08 17:49Z 64+16|…`), and one line of guidance: after a compaction, read `initiative_read
{view:"memory"}` (the 16–32 KB memory view) and zoom before acting. `bb initiative read memory`
and `bb initiative zoom <id> <n>` serve the same from a
shell. The dashboard shows the mode, log size, tree progress, view sizes and the
summarizer's cost at list price.

### OptChat turns (D431 phase 2)

A memory mode switch takes effect at the coordinator's next turn, in both
directions, in the same BB thread: Erwin keeps talking to the coordinator as
before, and its transcript shows every turn.

It needs a fork patch to BB's Claude Code provider (`~/Code/bb`, branch `erwin`,
"Claude Code: per-turn context from a hidden tool"). Before each new turn (not a
message steered into a running one) of a thread that has the hidden tool
`claude_code_turn_context`, the provider calls it with `{protocol: 3, input,
requestId, sessionId, reports}`: the turn's text, its BB request, the Claude
session the thread runs in, and what became of its earlier calls (below). The
plugin gives that tool to Claude Code coordinators only, in every mode, and it
is never shown to the model. An answer `{session:"fresh", sessionId,
systemPrompt, input}` runs the turn in a new Claude session with that id: BB's
system prompt plus `systemPrompt`, with `input` as its first message; `{}`, an
error, or no answer within 20 seconds lets the thread's session go on (the
provider forgets the request, so a late answer is ignored). The new session has
the thread's tools, from its own MCP server instance (one instance serves one
connection, and the new session starts while the old one is still connected),
settings and permissions, and BB records it as the thread's provider session,
so the Account Pooler links, counts and warms it like any other. The provider
switches only once the new session's CLI has initialized (30 seconds at most);
if it fails to start, the thread's session goes on with the turn's own text. A
message steered into the turn while the provider prepares it is held, then
follows the turn's input into the session the turn runs in, or fails with it;
an interrupt cancels the preparation. If the thread's session stops on its own
meanwhile, the provider restarts it and the turn and its held messages run
there, in order.

An optchat turn's prompt, in order:

1. Claude Code's and BB's system prompt (the coordinator's instructions), then
   the OptChat prompt (`TURN_PROMPT`: how the view works, answer only the new
   message, zoom before relying on any detail of the past), then the view's
   older lines in `<chat>`. These lines are frozen per thread: the next turn
   keeps them while the view only grows at its end, so the whole system prompt
   is read from the prompt cache turn after turn. They are frozen again when a
   merge batch rewrites them or the lines after them pass 32 KB.
2. The first message: the view's newest lines in a second `<chat>`, then
   `Now: 2026-10-08 14:32 UTC.`, then `New message:` and the turn's text. The
   view stops before the turn's own message (W216's failure mode 1).

Turns never wait for the summarizer (W216's failure mode 3). A message without
its line yet is shown whole up to 2 KB (512 bytes for tool calls and output),
else as its head and tail around " … ", newest first within 48 KB; older ones
are placeholders that `initiative_zoom {id, n:1}` opens. Before building the
view, the plugin reads the coordinator's newest events (up to 5 seconds), and
the view stops at the turn's own request (`requestId`), not at a later queued
one. A merged line that crosses that point opens into the lines it was made
from, so the turn's message is never in its own memory. If the log has not read
the thread through that request (a failed or slow read), the turn runs as
hybrid rather than over a stale or empty view.

**Leaving optchat.** The first turn after a switch to hybrid or regular starts
one more fresh session, this time a regular one: its first message hands over
the whole view, with the same guide, then the turn. Later turns go on in that
session, compacted as usual. The handover never waits for the summarizer: a
backlog of messages with no line shows as one placeholder line per run.

**What runs where.** Only the provider knows whether it ran an answer, so it
says so: each call carries `reports`, oldest first, one `{requestId,
offeredSessionId, outcome, sessionId}` per earlier call not yet acknowledged,
`outcome` being `fresh` (the offered session ran the turn), `resident` (no
fresh answer, or none in time: the turn ran in the thread's session) or
`failed` (the offered session failed to start: the turn ran in the thread's
session). A turn that never ran (interrupted) reports nothing. An answer
acknowledges the reports it took in with `ack: <the newest one's requestId>`;
the provider keeps every other report and sends it again with its next call
(16 at most). So a call the plugin could not check (its request unreadable,
unknown, or older than the last) loses nothing: it gets `{}`, and its reports
come again. The provider also keeps a thread's unacknowledged reports, and its
fresh session's system prompt, across an ordinary Stop: resuming that Claude
session gets them back (for the last 64 sessions it stopped, until it
restarts). Answering commits nothing; the plugin acts on the reports only:

- `fresh`, for the session it offered for that very request: an optchat one is
  flagged (`optchat:<thread>:<session>`) and no longer compacts; a handover's
  regular session is the thread's, and the handover is done (logged then).
- `resident` or `failed`: the session named ran a regular turn. An optchat one
  gets `:hybrid` and compacts at hybrid's limit, and is still handed over when
  the coordinator leaves optchat. An answer the provider did not run counts as a
  fallback, and is simply given again next turn.

A report sent again (its acknowledgement lost with a late answer) matches no
offer any more, so it changes nothing twice. For example: optchat, the
coordinator in its optchat session S. A turn's fresh answer T times out, so the
turn runs in S. The next call reports `{outcome: "resident", sessionId: S}`: S
compacts from then on, and the fallback is counted. Switched to regular, the
exit turn's request read fails: that call gets `{}`, runs in S, and the next
call reports both S's last optchat turn and the exit turn, so it is handed
over then. A handover whose session fails to start reports `failed`, so S is
still optchat and the next turn is handed over again.

Every call is checked before anything changes: it must parse (`protocol: 3`),
and its request must be on the thread (looked up page by page, however many
steers followed it) and no older than the last call taken; otherwise it gets
`{}`. Its reports must agree with it (each on another request, a fresh one in
the session offered, the newest in the session it runs in now); otherwise they
are acknowledged and change nothing. So a model that sees the tool (a provider
without the patch) and sends only `input` changes nothing. The checks do not
authenticate the caller, though: a model that knew the private fields and a
real request ID of its thread could still report a session of its own
invention and clear the real one's optchat flag. Hence the deploy order, the
fork first: the patched provider hides the tool.

**Fail safe.** When the view cannot be built (the log, tree or turn's request unreadable, the
log behind the turn, or more than 16 recent messages with no line, as after
switching an Initiative whose tree was never built), the turn runs as hybrid:
the thread's current session goes on. It is counted in the memory status (`optchat.fallbacks`, `lastFallback`) and in the
activity log, at most once per 10 minutes. A provider without the patch, a
Codex coordinator, or a coordinator whose session was built before the tool
existed, runs as hybrid until it is replaced.

**Limits.** Rewinding or forking a coordinator thread to a turn before its
latest optchat session is not supported. The status's optchat counts reset
when the plugin restarts, and so does what it knows of each thread's session
until its next turn (meanwhile an optchat session compacts at hybrid's limit),
and of its last offer (so a report of it then changes no session). A provider
that restarts loses its unacknowledged reports; the plugin then keeps what it
knew, and a fresh session it never heard of compacts as usual.
The provider cannot cancel the plugin's handler, only stop waiting for it; the
handler bounds itself (5 seconds of catch-up).

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
  `membership: null`. `membership.review` is the review still pending or running
  of the thread's latest report, as filed now (`ref`, the reviewer's `worker`,
  `phase`, `since` in ms), else null: a review of an earlier filing of the same
  assignment's report does not count. The Account Pooler keeps the thread's prompt cache
  warm while it is set, for the fix round the review may bring (D440).
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

The nine coordinator handovers of Oct 7 are replay fixtures
(`tests/fixtures/handover/*.json.gz`, credential-redacted, checked by a test):
`tests/w188-handover-replay.test.ts` rebuilds each packet from them and asserts
the facts the real handovers missed. Every recovery call an error suggests is
parsed through the real tool schemas (`tests/w188-contracts.test.ts`).

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
cannot freeze a view until reload. A first miss keeps the last data, shows nothing
and reads again at once; the error shows from the second miss in a row. A tab that
becomes visible again or a network that returns reads at once (W196). Each client
reports at most one timeout a minute through `reportReadTimeout`, logged as one warn
line with the elapsed time, whether the tab was or had been hidden, `navigator.onLine`
and the time since the tab was last visible (`bb plugin logs initiatives` or `sidebar`).
Dashboard writes never fail silently either (W239): a button or switch says "Still
saving: the connection is slow" after 5 s, and a write with no answer after 30 s
fails as unconfirmed ("may still be saved"), which also releases the
dashboard reads the write was holding. The write itself is not cancelled; the next
read shows whether it landed. The remote app reaches bb through the bb connect relay,
which can lose a request without answering. Sending the same write again is safe
(W244, W248). A command that adds something (Add task, New Initiative, a message, an
answer) carries an idempotency key; a command that sets a value (memory mode, pause,
closing a task) carries none, since setting the same value again changes nothing and a
later different choice simply wins. The page keeps a key from the first send until an
answer settles it: a timeout, a dropped connection or a server error all keep it, so
sending the same content again reuses it; only the server's own answer (saved, refused
with nothing saved, or "unclear, check first") releases it. Keys live in localStorage,
so a page reload keeps them. The server records each key's receipt in the plugin
database with its Initiative, command and request fingerprint, runs each key once,
answers a repeat from the receipt, refuses a key reused for a different request, and
keeps receipts 8 days, across plugin reloads. The page uses a key for 7 days; after
that, sending the same again asks the user to check whether it was saved instead of
silently running it a second time.

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
