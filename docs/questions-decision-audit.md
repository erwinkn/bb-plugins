# Questions plugin: decision audit

Date: 2026-09-07. Scope: the new Questions plugin and its collection entry.
The approved HTML demo is kept as a design reference.

This audit was written before committing, pushing, or installing. On 2026-09-07,
the user accepted proceeding with branch installation and the usual workflow,
while noting that they had not read every decision. The gate is cleared for
that workflow, not for merging or deleting plugin data.

## Choices to review

The list starts with the choices that have the most uncertainty. Each item
states the alternative and a case in which the chosen behavior causes a problem.

1. **Branch installation and the later return to main. Confidence: low.**
   Follow this repository's Git-branch test workflow, not a local-path install.
   BB 0.42.1 does not expose a verified way to change an installed Git source
   while preserving all plugin data. The alternative is to postpone installation
   until that core feature exists. Failure case: after a merge, removing and
   reinstalling Questions to switch to main could destroy saved answers. We
   must not use that fallback on this data-bearing plugin. The upstream gap is
   already recorded in the root README; the return-to-main step will need a
   safe supported method or a separate user decision.

2. **Live checks come after this gate. Confidence: medium.**
   Use backend tests, rendered-component tests, TypeScript, SDK checks, and
   a production-dependency build before the commit. Install from the resulting
   Git branch and then check desktop and mobile. The alternative is an isolated
   BB installation before review. Failure case: the real host's panel layout,
   mobile keyboard, RPC body limit, or attachment handling differs from the
   test host. The tests do not establish live desktop or mobile success.

3. **A failed delivery can remain uncertain. Confidence: medium.**
   Store a frozen submission before sending it. Reuse a submission ID when
   repeating the same RPC, but do not automatically resend messages. Offer an
   explicit retry of the frozen answers after a failure or unknown outcome.
   The alternative is automatic retry, which is simpler but can duplicate a
   message. Failure case: BB accepted a message but its reply was lost; an
   explicit retry can still send a duplicate. A marker in each message helps
   the user check. Exactly-once delivery requires an upstream request key.

4. **Queue answers when the agent is working. Confidence: medium.**
   Use `queue-if-active`, not interruption or steering. Mark the submitted
   snapshot after BB accepts or queues the message. The alternative is to
   interrupt the current turn. Failure case: a user cancels the queued message;
   the plugin still records acceptance, not proof that the agent read it.

5. **Server drafts plus browser pending-edit backups. Confidence: medium.**
   Store drafts in plugin SQLite and keep only not-yet-saved edits in versioned
   browser storage. The alternative is server-only storage or local-only drafts.
   Failure case: closing a page while disconnected and with browser storage
   unavailable can lose an unsaved edit. The UI reports unavailable backup
   storage. These are ordinary plaintext application stores, not secret stores.

6. **One backup per thread and question. Confidence: medium.**
   Use a shared browser key, rather than a separate recovery history per tab.
   Server version checks protect saved drafts, and open clients keep conflicting
   text for user resolution. Failure case: two disconnected tabs edit the same
   question and then both close; the last browser backup can replace the other
   tab's unsaved backup. There is no multi-tab revision history.

7. **Uploads belong to BB's project attachment store. Confidence: medium.**
   Use the SDK upload API, not a second plugin file store. Removing an attachment
   removes its answer association, not the underlying BB blob. The alternative
   is plugin-owned byte storage and its own delivery bridge. Failure case: an
   upload completes but the answer version changed, or a thread is deleted;
   a BB-owned attachment can remain without a Questions reference. The SDK
   exposes no verified deletion API for this cleanup.

8. **Notebook size is byte-bounded, not question-count-bounded. Confidence: medium.**
   Allow more than 200 questions, but limit each round's stored question JSON to
   256 KiB. The alternative is no size bound or a fixed question count.
   Failure case: a large generated questionnaire needs several rounds. The
   panel loads the thread state and renders the selected round without list
   virtualization; very large notebooks can become slow. Large-scale UI
   performance has not been measured in the live host.

9. **File and text limits. Confidence: medium.**
   Limit a file to 8 MiB, attachments to 10 per question, and image previews to
   400 KiB. Allow 20 choices and 20 references per question, 10 citations,
   20,000 answer characters, 4,000 characters per option detail, and an
   8,000-character summary. Question titles allow 500 characters, help 2,000,
   intro 4,000, groups 120, and choice labels 300. The alternative is larger or
   configurable limits. Failure case: a screenshot uploads but has no thumbnail,
   or a long answer must be shortened. The full 8 MiB upload still needs a live
   RPC check. Search returns at most 20 results and waits 150 ms after typing.

10. **Submission text is normalized. Confidence: medium.**
    Preserve draft text exactly. For submission and unchanged-answer comparison,
    trim outer whitespace and omit empty or unselected option details. The
    alternative is byte-exact submitted text and equality. Failure case: outer
    whitespace in a code example is meaningful, or the user expects a whitespace-
    only edit to count as a new answer. This normalization does not alter drafts.

11. **Conflicting edits require a choice. Confidence: medium.**
    Keep local text and offer Keep mine or Use saved when another client advanced
    the saved version. The alternative is last-writer-wins or automatic merging.
    Failure case: a user must resolve a conflict before submitting or uploading;
    there is no field-level merge. Saving before submission currently checks
    pending edits across the notebook, so an unrelated conflict can also block
    an inline submission until resolved.

12. **Draft saves retry; message sends do not. Confidence: medium.**
    Debounce saves by 450 ms and back off failed draft saves from 1 to 30 seconds.
    A submit waits for saves and fails if they did not finish. Flush permits up
    to five successful-save passes for edits made during saving. The alternative
    is explicit Save or unlimited waiting. Failure case: continued typing can
    require another submit, and a permanent save error keeps retrying while the
    panel is open. The notice keeps the local edit visible.

13. **Core panels and directives, not a pending tool interaction. Confidence: high.**
    The ask tool creates a durable round and returns immediately. It asks the
    agent to emit a directive, end its turn, and wait for the user's message.
    The alternative is a tool call held open for an hour. Failure case: an agent
    omits the directive or ignores the wait instruction. The header and panel
    launcher remain access paths, but this does not force provider compliance.
    There is no Questions answer timeout and no change to the built-in tool.

14. **Auto-open only on a new notebook round. Confidence: high.**
    Use the native panel action and an experimental thread-header action.
    A mounted header opens new notebook rounds once per session; reloads and
    inline rounds do not force it open. A notebook directive provides a reopen
    button. The alternative is opening on every state load. Failure case: a
    round created while no frontend is mounted needs manual opening. The
    session marker keeps the last 50 round IDs; it is not a permanent history.

15. **A shared editor with a restricted inline mode. Confidence: high.**
    Reuse the choice and text controls, but reject advanced fields in inline
    requests and hide option detail, references, confidence, and attachments
    there. Inline rounds are capped at five questions as requested. The
    alternative is separate editor implementations. Failure case: a future
    shared-editor change accidentally exposes an advanced control inline;
    component tests cover the current separation.

16. **Explicit capabilities and plain references. Confidence: high.**
    Attachments, references, and confidence default to off. Workspace search
    uses the thread's current environment and host. Custom paths and HTTP(S)
    URLs can be included as text references; paths are not mention pills and
    do not automatically send file contents. The alternative is automatic file
    reading or host-dependent mention encoding. Failure case: the agent needs
    file contents and must read the referenced file separately.

17. **Thread-scoped SQLite, generated IDs, and explicit corruption errors. Confidence: high.**
    Use the BB database and migrations, full UUID-based IDs, and version checks.
    Agent tools derive the thread from their context. The alternative is a
    JSON blob or caller-selected tool thread. Failure case: corrupted stored
    records stop loading rather than silently dropping an answer. No automatic
    data repair is implemented. Thread deletion removes plugin rows; archive
    retains them. There is no separate notebook-delete or export UI yet.

18. **Immutable submissions and restricted retries. Confidence: high.**
    Deduplicate submitted question IDs, skip unchanged answers, reject stale
    versions, and block overlapping sends. A retry sends the old snapshot, not
    later draft edits; a newer overlapping attempt makes the older retry
    unavailable. The alternative is resending the current draft. Failure case:
    after correcting an answer, the user must submit that correction normally,
    not use Retry on the older submission.

19. **Complete submitted data through a paginated read tool. Confidence: high.**
    Return full answer records, with an `after` cursor near 512 KiB instead of
    truncating text. An oversized first record remains intact. Return only
    unsent-change indicators, never draft content, through this agent-facing
    command. The alternative is full unbounded output or summaries. Failure
    case: an agent ignores the continuation cursor and misses later answers.
    The UI retains recent submissions plus older unresolved relevant attempts.

20. **CLI file input reads from the invoking machine. Confidence: high.**
    Use the SDK file API and the invoking thread's host and working directory,
    even if the target thread differs. Outside a thread, require an explicit
    host and absolute path. The alternative is reading the server filesystem.
    Failure case: a user meant a file on the target thread's machine and must
    specify that host. CLI `state` was removed to avoid exposing unsent drafts.

21. **Native SDK components and tests. Confidence: high.**
    Use BB theme tokens, vendored scaffold controls, the native Markdown
    renderer, and a separate client draft store subscribed through React.
    The alternative is embedding the HTML demo or a larger state library.
    Failure case: an SDK host behavior changes, especially the experimental
    header slot. The build and tests target SDK 0.4.47 and BB 0.42.1. The SDK
    import scan allows declared public packages and local aliases; a false
    positive in a test title was renamed, not bypassed with a private import.

22. **Keep this change in the plugin repository. Confidence: high.**
    Do not modify the external `/grill` skill or enable the currently disabled
    built-in question plugin. Do not publish to the marketplace or file upstream
    issues without a separate request. Record core limitations in README.
    The alternative is editing other projects as part of installation. Failure
    case: an existing skill continues choosing its old question tool until it
    is explicitly updated or instructed to use Questions.

## Verification

- 48 automated tests passed: 15 backend, 17 draft-store, 16 rendered UI tests.
- TypeScript passed, including tests.
- `bb plugin types --check` matched host SDK 0.4.47.
- A separate copy built with production dependencies only.
- The real installed plugin has not been tested on desktop or mobile.
- No commit, push, PR, installation, or merge has occurred in this step.

## Verdict and next step

I stand behind the implementation as a candidate for live testing, but not an
unqualified production-ready verdict. The exceptions are live host verification
and the unresolved safe return from a branch installation to main. There are
no implementation commits yet to endorse individually.

Review these choices before the commit. After triage, the requested workflow is:
commit, push, open a draft PR, install Questions from that branch, and verify
desktop and mobile behavior. Leave the merge decision to the user.
