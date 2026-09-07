# Questions live checks

Date: 2026-09-07. BB 0.42.1, SDK 0.4.47.

Initial installed commit: `fd7d669e8fb45bcc9f70bcc7b20d16ebf44b2aab`.
Source: Git branch `bb/investigate-ask-question-timeout-thr_v4j7n8virz`,
subdirectory `plugins/questions`, plugin ID `questions`.
PR: https://github.com/erwinkn/bb-plugins/pull/18

## Confirmed in BB

These checks used a separate browser session and test thread
`thr_v9bwyhdngj`, not the user's answers.

- The plugin reports running with a compatible frontend bundle.
- A six-question notebook round opens in the native Questions panel.
- Single choice, multiple choice, confidence, and text save to the server.
- A draft remains after hiding and reopening the panel.
- The agent-facing read command reports pending changes without draft text.
- Image upload saves real bytes and renders a loaded image preview.
- Workspace search returns files from the test thread's environment. Selecting
  two results creates two references without a separate Add action.
- Submit answered sends five answers and leaves the sixth unanswered. The
  received message contains the image, both reference paths, and a submission ID.
- The receiving agent acknowledged the test answers.
- A later round quotes the earlier submitted choice. The expanded citation
  shows the question and answer separately.
- At 390 by 844 and 320 by 740, the page and question width match the viewport.
  There is no horizontal overflow. This is browser viewport testing, not a
  physical phone or mobile keyboard test.
- The inline directive renders a basic form. Its submit sends only that round,
  with the unanswered notebook questions left open.
- The summary command updates the summary. Reload retains submitted answers.
- No browser JavaScript errors or Questions plugin logs appeared in these checks.

## Correction found by the live check

Opening a notebook round with `params.roundId`, then using the header without
params, created two host tabs. BB keys plugin tabs by action and params.
The correction keeps host-tab params identical on every open and sends the
requested round through a separate in-memory selection channel. This restores
the intended single persistent panel without removing old answers or drafts.
Regression tests cover the host-tab identity and round selection timing.
The PR records the corrected installed commit and the repeat live check.

The independent review also found upload/save contention and identical-draft
conflicts across views. Saves now pause for the uploading answer while typing
and backups continue. Identical drafts no longer show a conflict. The corrected
build passes 53 tests, TypeScript, and the normal build.

## Review and limits

The initial build passed 48 tests, TypeScript, SDK compatibility, and both
normal and production-dependency-only builds. The PR records final counts.
Socket checks passed on the initial commit. Macroscope skipped its check;
Devin reported that full review was skipped because no credits remained.
These skipped reviews are not code-review approval.

Full-size 8 MiB upload, physical mobile input, and long-running multi-device
network failures remain untested in the live host. Automated tests cover
version conflicts, transport failures, and restart recovery. The data-preserving
Git-source switch limitation remains recorded in the decision audit.
