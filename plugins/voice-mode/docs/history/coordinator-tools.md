# Coordinator role and tools

The coordinator is Aide's reasoning and coordination layer. The live model owns
conversation and audio. The coordinator returns structured results through the
bridge. The bridge currently asks the live model to read the `speech` field
verbatim; it is not a free-form instruction channel to another model.

For longer work, return one useful `progress` update early, continue a bounded
check or delegate promptly, then return `final` after required action receipts.
A final ends that request. It does not mean an internal worker has completed.
Worker reports arrive asynchronously. The initial acknowledgment belongs to the
live layer; a progress return must add information.

## Voice-specific tools selected for coordinators

| Tool | Purpose |
| --- | --- |
| `voice_reply` | Return text, details, references, and receipts for the live voice interface. `progress` keeps the request open; `final` ends it; `blocked` reports a blocker; `silent` produces no speech. `assigned` is an internal receipt. |
| `voice_ask` | Return a question with choices/free text and wait for its answer. The live interface presents it; the coordinator does not produce audio. |
| `voice_overview` | Read a bounded snapshot of active and recent regular work threads. Group child work under its parent. |
| `voice_actions` | Execute one recorded group of up to four resolved operations: `send_message`, `start_thread`, `stop_thread`, or native UI/draft actions. Internal workers are hidden children of the coordinator. Unknown effects are not retried. |
| `voice_ui` | Apply a native UI action on the device that owns the call and wait for the result: `open_thread` (including split), `open_project`, `prepare_draft`, `preview_file`, or `show_voice`. Drafts are not submitted. |
| `voice_sequence` | Return an ordered plan of native UI actions and narration. The runtime waits for each action receipt and actual playback before advancing. This is the request's final response. |

`voice_worker_report` belongs to recorded internal workers, not the coordinator.
It returns a worker outcome or blocker to the Voice result scheduler.

## Provider and BB capabilities

The six tools above are this plugin's selection. `bb.agents.configure` selects
this plugin's tools; it does not remove the provider's native tools or other
plugins' selected tools. The inspected coordinator uses Codex. Its event log
also records shell execution of `bb status`, thread reads/lists, provider-model
lookups, and thread spawning. This is direct evidence of the BB CLI execution
path, not a claim to have enumerated every tool loaded by that provider session.

Thus, "delegate sustained work promptly" is a role instruction, not a technical
ban on local execution. BB's normal permissions still apply. Tools and dynamic
instructions take effect when the provider session is constructed again; the
SDK does not hot-replace an already constructed session's instructions.

## Update decision and checks

The coordinator default and its saved Settings version were rewritten to state
this boundary. The user's live prompt and its saved version were verified
unchanged. The main coordinator prompt is 3,805 characters, below the SDK's
4,096-character limit. Tool descriptions now also explain that replies and
questions return through the live interface.

No speech runtime or reply schema was changed. Existing event tests cover one
progress update followed by a final, immediate result publication, hidden worker
delegation, exact prompt delivery, and saved-prompt independence. The remaining
limit is deliberate: changing to live-model paraphrasing would require a separate
runtime change and different playback/receipt checks.
