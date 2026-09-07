# Questions

A BB plugin that lets an agent ask the user a round of structured questions
and collect the answers later. Questions live in a thread-bound
side panel (any number of questions, with optional attachments,
workspace references, confidence, and citations of earlier answers) or, for up
to five quick questions, inline in the thread. Drafts and submitted answers are
stored on the BB server. Saved data survives closing the panel, reloading the
app, and restarting BB. Pending edits also have a browser backup when storage
is available; unsaved edits are not guaranteed to survive a disconnected close.

The built-in question tool is untouched. This plugin adds a second,
durable path for rounds that need more than one quick answer.

## How a round works

1. The agent calls `questions_ask` with a list of questions. The call returns
   at once with the round id, the labels of the new questions (`Q1`, `Q2`, …
   numbered across the whole thread), and a directive line.
2. The agent puts the directive alone on its own line in its reply and ends
   its turn: `::questions{round="rnd_…"}`. A panel round renders as a
   compact card with an **Open** button; an inline round renders its
   questions right in the message. While the thread is open in BB, a new
   panel round also opens the panel once through the thread header control.
3. The user answers in any order. Every edit is saved to the server after a
   short pause. The title row of each question keeps a fixed-width slot for a
   status glyph (`•` draft, `✓` submitted) and a clear button, so answering
   never shifts the layout.
4. The panel's **Submit answered (N)** sends every new or changed answer across all rounds
   as one ordinary user message to the owning thread. Unanswered questions stay
   open. Inline submission sends only its own round. An answer can be edited
   and submitted again later.
5. The agent reads answers from that message or from `questions_read`, and can
   ask a follow-up round that cites earlier answers (`cites: ["Q3"]`). The
   citation quotes the submitted answer only; unsent edits never change it.

## Panel and inline mode

Choice questions include **Other**, which opens a text area. Deselecting it
clears that text. It replaces a single choice and can accompany multiple
choices. An empty Other selection is saved as a draft but is not a submitted
answer. Older single-choice answers with typed notes keep those notes in a
separate text area, without selecting Other. Selecting Other keeps the notes
and clears the choice. Sections are no longer offered;
old saved section labels are ignored.

For attachment-enabled panel questions, paste images into answer or option
detail text areas, or use the top-right paperclip. The background fade under
the paperclip covers text without adding a separate control row. When no text
area is open, the paperclip appears at the right of the Other row. It attaches
a file without changing the selected choice. File search
waits for a query, and selected badges stay inside the control above results.
The footer shows save status, including a failure or conflict when needed.
It does not show a save indicator during the initial load.

Text areas grow and shrink to fit their content, including restored drafts
and changes in panel width. Editable fields use 16 px text on narrow screens
and devices with a coarse pointer, and 13 px on larger fine-pointer screens.
The plugin does not restrict page zoom. File search sends a lowercase query
to BB's fuzzy matcher so mixed-case input can find uppercase filenames.

| | Panel | Inline (in the message) |
| --- | --- | --- |
| Questions per round | no count cap (256 KiB of question JSON per round) | 5 |
| Answer forms | single or multiple choice with optional detail per option, free text, attachments, workspace references, confidence | single or multiple choice, free text |
| Extras | `help`, `cites` | none (rejected) |
| Tabs | one per round plus a global Summary | none |

The Summary tab shows the agent-authored summary (set with
`questions_summary`, markdown, at most 8000 characters) followed by the
submitted and open questions of every round.

## Agent tools

- `questions_ask` `{ mode?, intro?, questions: [{ title, help?, options?, select?, cites?, attachments?, references?, confidence? }] }`.
  `mode` defaults to `"panel"`. `options` is a list of labels; `select` is
  `"single"` (default) or `"multiple"`. The thread is always the calling thread.
- `questions_read` `{ round?, after? }` returns every submitted answer as
  complete records (choices with details, text, references with paths or links,
  attachment names and paths, confidence, submission time). Pages target
  512 KiB, keeping an oversized first record intact; pass `after` with the last
  question id to continue. Drafts are
  reported only as pending, never with their content.
- `questions_summary` `{ summary }` sets the Summary tab text; `null` clears it.

## CLI

The CLI uses the same code paths as the tools, which makes it the fastest way
to seed a round for a live test. The thread defaults to the thread the command
runs in; pass `--thread <id>` to target another one.

```sh
bb questions ask --thread thr_123 "Where should drafts live?" --option "Browser" --option "Server"
bb questions ask --thread thr_123 --inline "Ship today?" --option Yes --option No
bb questions ask --thread thr_123 --file questions.json
bb questions read --thread thr_123
bb questions read --thread thr_123 --round rnd_123 --after q_123
bb questions rounds --thread thr_123 --json
bb questions summary --thread thr_123 set "Goal: …"
bb questions summary --thread thr_123 show
bb questions summary --thread thr_123 clear
```

`questions.json` holds the same object `questions_ask` accepts. `--file` is
read on the machine of the invoking thread through BB's file API, relative to
the invoking working directory. Outside a thread, pass `--host <id>` and an
absolute path. The CLI never prints draft content.

## Answers, drafts, and delivery

- **Drafts** are saved on the server with compare-and-swap versions. An edit
  remembers the version it started from; if another window saved a newer
  draft in between, the panel keeps the local text and asks which version to
  keep. Nothing is overwritten silently. Exact whitespace is preserved.
  Panel and inline views in the same browser runtime share one thread session,
  including pending edits, the submission lock, request ids, and upload queue.
  The last view to close flushes its edits. An immediate reopen joins that
  pending save. Sessions with unsaved edits or an unconfirmed request id stay
  in memory until resolved or until the browser runtime ends.
- **Browser backup**: unsaved edits are also mirrored in the browser's local
  storage per thread and question. Save failures back off (1 s to 30 s) and
  retry; the footer says when the browser cannot keep a copy. This backup has
  no revision history: two disconnected tabs editing the same question can
  replace each other's backup. Neither store is intended for secrets.
- **Submission** freezes the answers into an outbox row with a client-generated
  id *before* the message is sent. The message header names the submission id.
  A repeat attempt with the same id replays the stored outcome instead of
  sending twice. Answers become "submitted" only after the server confirmed
  delivery (`sent`, or `queued` when the agent is busy).
- **Uncertain delivery**: when the server does not confirm (timeout, 5xx,
  restart mid-send), the outbox row becomes `uncertain`, the drafts stay
  drafts, and the panel shows a warning with an explicit **Retry** button when
  the server permits that retry. The
  retry sends the same frozen answers and can duplicate the message, so the
  warning asks the user to check the thread for the submission id first. There
  are no automatic message retries. A retry is refused when a newer attempt already
  covers one of its questions. The server computes `canRetry` from all stored
  attempts, not just the recent list. A partly superseded warning stays
  visible without a Retry button. It asks the user to check the thread and
  submit any remaining drafts. Repeating an unconfirmed retry request in the
  same browser session uses the same request id.
- **Failed delivery** (the server refused the message) keeps the drafts and
  shows the reason.
- The plugin only ever sends to the owning thread; it never spawns threads.

## Attachments and references

- Attachments (only on questions asked with `attachments: true`) are uploaded
  to the project's prompt attachments through BB's SDK and sent as real
  `localImage` or `localFile` parts. Limits: 8 MB per file, 10 files per
  question. Images up to 400 KB get a thumbnail in the panel.
  Typing remains available during upload. That answer's saves pause until the
  upload finishes, then resume. Submit waits until the upload is complete.
- References (only with `references: true`) come from a live fuzzy search of
  the thread's workspace on its own host. A pasted `https://` link or a path
  containing `/` is also selectable. Workspace file badges open BB's preview;
  URL badges open the browser. Custom paths are text references, not verified
  file locations. References do not attach file contents.
- Confidence (only with `confidence: true`) is a separate low / medium / high
  row under the answer.

## Lifecycle and limits

- All data is scoped to the thread it was asked in. When a thread is deleted,
  its rounds, drafts, submissions, and summary are deleted with it. Uploaded
  attachment files stay in BB's project attachment store because BB has no
  delete API for them. Removing a file from an answer also keeps the uploaded
  blob in BB's store.
- Exactly-once delivery is not promised: BB's `threads.send` has no
  idempotency key, so an uncertain send can only be resolved by the user.
- Workspace references travel in the message as plain paths, not mention
  pills.
- Uploads travel base64-encoded over the plugin RPC (BB's local HTTP routes
  accept JSON only). The plugin caps each file at 8 MiB. A full-size upload has
  not yet been checked in the installed plugin.
- Realtime updates keep every open window current; without a live connection
  the panel reconciles on reconnect.

## Develop

### Naming update

The display modes are `panel` and `inline`. The panel action ID is `questions`.
Existing saved rounds migrate to `panel` on startup. Round IDs, answers, drafts,
submission snapshots, and browser draft backup keys stay unchanged.
The old display mode is no longer accepted by tools or the CLI. Agents with
cached tool definitions need a new session to receive the new schema.
Close and reopen an old Questions tab after updating. BB does not expose a
public API to rename a saved panel action ID; no legacy action is registered.
Do not roll back to the old build after this migration without restoring a
pre-update database backup, since the old build cannot read `panel` rounds.

### Local checks

```sh
npm install
npm run typecheck
npm test          # backend fake host, DraftStore, and frontend harness tests
npm run build     # bb plugin build → dist/
```

Source layout: `server.ts` wires RPC, tools, and CLI; `server/store.ts` is the
SQLite layer; `server/service.ts` holds validation and the outbox;
`lib/model.ts` is the shared schema; `lib/message.ts` renders the submission
message; `lib/draft-store.ts` is the client-side draft store; `hooks/` and
`components/questions/` are the React panel, directive, and header control.
