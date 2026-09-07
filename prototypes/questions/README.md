# Questions: Notebook side panel

This HTML demo explores only the Notebook side panel with linked previous
answers. Nothing is installed, uploaded, or sent to an agent.

## Side panel

Questions are grouped under topic headings. Each round has one tab, with
one global Summary page. There is one `Submit answered (N)` button, which
submits new or changed answers across all rounds. Unanswered questions stay
open. No review screen or branching engine is present.

There are no question-kind labels, response-type hints, or “I don't know”
controls. Choice questions offer a quiet `Type an answer` text control
without a hover background. Clicking it opens a text field. Selected choices
can still have additional detail.

The agent requests optional controls separately: attachments on Q14,
repository references on Q10, and confidence on Q3. Other questions show
none of these controls.

Draft status and an icon to clear the answer share the question title row.
Their space is reserved, so answering adds no status line or layout shift.
Status details appear in the icon tooltip.

Linked citations expand the earlier question and submitted answer in place.
Expansion replaces the compact citation. The expanded header shows its
source once, with the jump icon immediately after the source label and the
collapse icon at the far right.
The question appears above a separate, labeled answer surface. Submission
time is in the source tooltip; demo labels are confined to the demo notice.

Confidence has a separate row below text entry. Q10 uses a searchable
multi-select reference picker: click results or use arrow keys and Enter
to toggle selection. Selected files appear as removable badges below the
input. Results show a file icon, regular-weight filename, and lighter full
path. There is no Add button; custom paths or URLs can also be selected.
The list uses sample paths, not a live BB file search.
Typing updates only the result list, preserving the input and cursor.
Mouse movement and arrow keys share one active result. The attachment
icon sits inside the lower-left corner of the text field. Text padding
keeps the answer clear of the icon. Type an answer aligns with the radio
controls.
Question numbers sit beside titles on desktop and mobile. The controls below
align with the question number at the left edge, without a hanging indent.
On mobile, compact references
put the source label on its own row, with the quoted answer below and
wrapping as needed. Type an answer uses the same 1 px row gap as options.
Browser checks passed at 390 px and 320 px without horizontal overflow.
Unsent edits do not change a citation; submitting an edit updates it.
The demo has two fixed rounds and 14 sample questions, with five submitted
sample answers in Round 1. It opens on Round 2. This sample size is not a
side-panel question limit.

## Separate in-thread design

The in-thread tool remains basic: at most five questions per round, shown
one after another, with single or multiple choice and an option to type text.
The agent can ask additional rounds. This flow is not shown or implemented
by this side-panel demo; it must not reuse the full panel interface.

## Appearance and storage

Colors and controls follow BB theme tokens, with dark and light previews.
The HTML approximates BB components and uses no Plugin SDK. Body text is
13 px with a 16 px root.

Drafts survive switching rounds and closing/reopening the panel. Browser
storage is used where available, otherwise memory. Reloading BB's sandboxed
inline preview clears drafts. The footer states which storage mode applies.
This revision uses `bb-questions-prototype-v3`; earlier demo drafts remain
under their old keys and are not imported or removed.

Images smaller than 400 KB have local previews; other attachments retain
metadata only. File references simulate opening an editor. Summary prose
and agent messages are fixed demo content; answer lists reflect local state.

## Validation

Browser checks confirmed zero vertical shift when typing a draft, controls
in the title row, replacement of compact references on expansion, one source
label, and a working jump to the source round. The 390 px view had no
horizontal overflow or browser errors. Durable storage and agent delivery
remain plugin work.
