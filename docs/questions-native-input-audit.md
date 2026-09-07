# Questions native input decision audit

Local changes after `ab7eb4e`. Not committed or installed. User review is
required before the branch update and live installation check.

## Decisions

1. **Medium confidence. Images are read on demand.** Native tool results
   carry attachment paths. A new `questions_image` tool returns one submitted
   image, up to the existing 8 MiB file limit. It rejects draft-only images
   and cross-question or cross-thread paths. Alternative: put every image
   into the initial tool result. Risk: agents must make another call to see
   an image. Native results no longer include the automatic image input that
   a user message carried. Non-image files remain path references in native
   results. Provider access to those files still needs a live check.

2. **Medium confidence. Renew only on hourly expiry.** Use BB's maximum
   `timeoutMs`, 3,600,000, then request a new native interaction for the same
   round. Drafts remain. Cancellation, stopping the thread, reload, restart,
   or a failed renewal ends the wait; later submissions use messages.
   Alternative: let the wait end after one hour. Risk: renewal creates a new
   interaction ID, so the attention indicator can briefly clear and the inline
   control can remount. This uses the public API, not a longer host timeout.

3. **High confidence. CLI asks always wait.** The CLI uses the same native
   interaction as the agent tool. There is no `--no-wait` or immediate-return
   creation path. Alternative: keep a separate asynchronous CLI mode.
   Risk: scripts that expect an immediate return must change; a disconnected
   CLI cancels its wait.

4. **High confidence. Remove partial submissions and frozen retries.** Every
   new attempt submits the complete round using current drafts. The retry API,
   retry controls, and retry-chain checks are removed. Existing history and
   the unused nullable `retry_of` database column remain. Alternative: migrate
   or delete that history. Risk: old clients that send `retryOf` must reload;
   old failed snapshots can no longer be retried as separate partial attempts.

5. **High confidence. Submit applies to the selected round.** The panel and
   inline control use one Submit button. Summary has no active submission.
   Alternative: require every open round to be complete. Risk: edits in other
   rounds remain unsent until the user submits those rounds separately.
   Submitting an older round does not resolve a wait for a newer round.

6. **High confidence. Required is the default, including old questions.**
   `optional: true` allows a blank answer. A choice, nonblank text, attachment,
   or file reference counts as an answer, following the existing content rule.
   Confidence alone and an empty Other field do not count. Alternative:
   question-specific validators or grandfathering old questions as optional.
   Risk: a file alone satisfies a required question; old incomplete rounds
   now require all remaining answers before another normal submission.

7. **High confidence. Skips are explicit empty submitted answers.** Optional
   questions show a small Optional label. A blank one is saved as an empty
   submitted snapshot and reported as skipped. Even an all-optional round
   requires a Submit click to close it. Alternative: keep blanks open or add
   a separate round-completion table. Risk: counts include skipped questions
   as completed, although they contain no answer. No schema migration is needed.

8. **High confidence. Validate on the server and freeze before delivery.**
   The server requires exactly one complete round, checks every draft version,
   and stores the snapshot before resolving the native interaction. The tool
   accepts only a submission prepared by the validated RPC path. Confirmed
   answers are committed before the agent resumes. Alternative: trust the
   frontend's disabled button and submit raw form values. Risk: a version
   conflict on an unchanged question requires another submission attempt.

9. **High confidence. Native success does not also send a message.** A local
   coordinator matches the pending BB interaction to the round, resolves it,
   and returns frozen answers as the tool result. Concurrent asks in this
   plugin are rejected before creating extra rounds. Other BB interactions
   are checked before asking. Alternative: retain message delivery alongside
   a background attention marker. Risk: the agent stays in its tool call for
   the wait, as with the native question tool. A different plugin can still
   race the check; BB rejects the collision and the saved round remains.

10. **High confidence. Keep uncertain delivery visible.** A failed native
    response never triggers an automatic fallback message in the same attempt.
    Keep the delivery record and reuse its ID after a transport error. A new
    submission uses the current complete round, not a frozen retry chain.
    Alternative: send a message immediately after any native error. Risk:
    uncertain delivery requires the user to check before submitting again.
    Exactly-once delivery across server or transport failure is not promised.

11. **High confidence. Bound the tool result.** Return up to 512 KiB of answer
    text, matching the existing read-page target. Larger results direct the
    agent to `questions_read` and its cursors. Alternative: return an unbounded
    snapshot. Risk: large rounds require extra reads. No answer is clipped.

12. **High confidence. Reuse the controls in BB's pending-interaction slot.**
    Panel rounds show the compact Open card; inline rounds show their editor.
    Both include cancellation. Existing message directives still reopen saved
    rounds. Alternative: build a second form implementation. Risk: placement
    and provider behavior still require live desktop and mobile checks.

## Verification scope

All 91 tests pass. Typecheck, plugin build, and whitespace checks pass.

The tests cover whole-round validation, required and optional answers,
native interaction resolution without a second message, repeated hourly renewal,
cancellation and abort without renewal, failed renewal and late message delivery,
concurrent asks, uncertain native
response, CLI waiting, image ownership, and the native inline renderer.
The retired retry API is rejected. Submission fixtures use complete rounds.

Live attention indicators, provider tool-result delivery, non-image file
access, desktop layout, and mobile layout remain to be checked after approval
and an in-place branch update. No installation or user data was changed.

## Verdict

I stand behind the local implementation and its tests. I do not yet claim
native provider parity or live readiness. Items 1 and 2 are the main behavior
tradeoffs to review before commit and installation.
