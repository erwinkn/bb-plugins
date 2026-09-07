Agents often need more than one answer before they can continue: which
option, why, with which file, and how sure you are. Questions gives them a
place to ask and gives you a place to answer at your own pace.

## What you get

- A **Questions** side panel bound to the thread, with one tab per round and a
  global Summary tab. Questions are numbered across the thread, with no count
  cap and a 256 KiB size limit per round.
- Single or multiple choice with optional detail per option, an **Other**
  option for a typed answer, and, only where the agent asks for them, file or image
  attachments, workspace file references, and a confidence row.
- Paste images into answer text areas when attachments are enabled. Selected
  workspace files stay visible inside the search control.
- Follow-up rounds can quote your earlier submitted answers in place.
- One **Submit answered (N)** button sends every new or changed answer across
  all rounds as a normal message to the agent. Unanswered questions stay open.
- A lighter inline mode for up to five quick questions inside the thread.

## How it works

Questions, drafts, and submitted answers live in the plugin's own database on
the BB server, scoped to the thread. Drafts are saved as you type with version
checks that detect edits from another window. Saved drafts survive closing
the panel, reloading, or restarting BB. Pending edits also have a browser
backup when storage is available. Panel and inline views in the same browser
share pending edits. Edits never change what was already submitted.

Every submission is frozen before it is sent and carries its own id. If the
server cannot confirm delivery, the panel says so and offers an explicit
retry when no newer attempt covers those answers. It never retries a message
on its own. If only part of an uncertain submission was superseded, its warning
stays visible and directs you to check the thread and submit remaining drafts.

## For agents

`questions_ask` creates a round and returns a directive line to place in the
reply; the agent then ends its turn. Answers arrive as user messages, and
`questions_read` lists every submitted answer with full details.
`questions_summary` keeps the Summary tab current. The `bb questions` command
offers the same operations from a terminal.
