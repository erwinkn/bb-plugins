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
- One **Submit** button submits the selected round. Questions are required
  by default; the agent can mark questions optional so you can skip them.
- A lighter inline mode for up to five quick questions inside the thread.

## How it works

Questions, drafts, and submitted answers live in the plugin's own database on
the BB server, scoped to the thread. Drafts are saved as you type with version
checks that detect edits from another window. Saved drafts survive closing
the panel, reloading, or restarting BB. Pending edits also have a browser
backup when storage is available. Panel and inline views in the same browser
share pending edits. Edits never change what was already submitted.

Every submission is frozen before delivery and carries its own id. If the
server cannot confirm delivery, the panel asks you to check the result before
submitting the complete round again. It never retries a message on its own.

## For agents

`questions_ask` waits through BB's native input mechanism and renews hourly
timeouts, so the thread shows that it needs attention while waiting. It returns
submitted answers directly to the agent. Cancellation ends the wait but keeps
drafts. If no live interaction remains, later submissions use a user message.
`questions_read` lists submitted
answers, and `questions_image` opens one submitted image for the agent.
`questions_summary` keeps the Summary tab current. The `bb questions` command
offers the same operations from a terminal.
