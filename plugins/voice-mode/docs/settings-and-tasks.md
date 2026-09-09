# Settings and Tasks handoff

The Workers editor reads named profiles through `getWorkerSettings(null)` and saves
`setWorkerSettings({settings, hostId})`. Save validates the complete named-profile
schema and the selected machine's provider catalog. It never replaces an unavailable
model. The machine selector previews and validates availability; it does not assign
a task's destination.

Startup converts `voice.worker-profiles.v1` to `voice.worker-profiles.v2` only when
v2 is absent. It retains v1. With neither key, the reader returns defaults without
writing either key. The old four roles become four named profiles, the default is
`implement`, and the cap carries over.

Named profiles accept `permissionMode` values `accept-edits`, `auto`, and `full`.
Migrated profiles use `accept-edits`. Existing v2 values without the field read as
`accept-edits` without a storage rewrite. The profile editor saves the choice,
and the shared spawn path passes it to BB. Tests cover all three launch values,
missing-field defaults, invalid saves, and independent profile edits.

The editable prompt roles are `aide` and `worker`, labelled Live prompt and Worker
prompt. `aide` reads the approved default without inserting a row. A saved `aide`
row takes precedence. The `live` and `coordinator` roles are read-only under Previous
prompts. Startup never imports or writes `live` rows, and `createCall` reads `aide`.
This keeps the fourteen-tool prompt out of the old build's `live` lookup on rollback.
No SQL migration statement changed.

`getVoiceSession` now includes `work: {tasks, subscriptions, asOf}` from the stored
conversation rows. This read-only snapshot serves ended sessions without claiming
a call. Live Tasks views still use `listLiveTasks` and `listLiveSubscriptions` with
the current nonce and conversation ID. Their authority checks are unchanged.
The view refreshes on session log events and every ten seconds while the page is
visible. Call presence refreshes session metadata when a call ends. Opening a row
uses `nativeUi.execute` as a direct user action. Pending launches have no open action.

## Verification

Tests cover one-time settings conversion, unchanged old settings and prompt rows,
model and machine validation, profile add/rename/default/delete behavior, failed
saves, prompt history, read-only previous roles, the prompt sent by `createCall`,
Tasks rendering and navigation, visibility-gated polling, and call-end transitions.

The jsdom tests render the settings and session components in 390 px and 1200 px
containers and check the width constraints and wrapping rules. An isolated Chromium
preview also measured Workers, Prompts, and Tasks at both widths in light and dark
themes. It used rendered component markup, synthetic RPC data, Tailwind CSS, and the
installed BB theme tokens. All twelve checks reported page width equal to viewport
width, with no element crossing the viewport. Fixtures included long profile/model
names, long task titles, and unbroken output text. Browser previews checked layout;
jsdom tests checked interactions. This did not test an installed plugin or live call.

## Decision audit

| Choice | Alternative | Confidence | Possible failure |
| --- | --- | --- | --- |
| Save the full profile draft explicitly. | Save every control change immediately. | High | Closing settings before Save discards local edits. Concurrent saves use the latest complete value. |
| Preserve unavailable choices as disabled options. | Replace them with a model that is available. | High | Save stays blocked until every profile validates on the selected machine. |
| Add stored work to the existing session-history read. | Loosen live RPC nonce checks or require a new call to view tasks. | High | Ended sessions show stored evidence, which can lag a muted worker. |
| Keep prompt version selection separate from the editable draft. | Make selection immediately activate the version. | High | Restoring a version takes an explicit Use this version and Save. |
| Refresh only while Tasks is mounted and the document is visible. | Poll all sessions continuously. | High | A hidden page waits until it is visible before fetching fresh rows. |
| Use the new `aide` role and leave `live` unchanged. | Insert the new default under `live`. | High | Old clients that explicitly try to edit `live` receive a read-only error until updated. This follows the revised rollback requirement. |
| Default omitted permission modes to `accept-edits` and pass saved modes to spawn. | Require existing v2 profiles to be rewritten. | High | A profile set to `auto` or `full` grants that BB permission mode to future launches. This follows the explicit profile setting. |
| Use synthetic UI previews without installing the plugin. | Reload BB for a live UI check. | High | Installed host integration and physical audio remain untested, as required by this task. |

I stand behind these changes and their tests. No live call, installation, or reload
was used for verification.
