# Questions Cursor review audit

PR #18. Changes reviewed after `f84c76d`. User approved this audit on
2026-09-07. The branch was then rebased onto updated `origin/main`.

## Triage

All six Cursor findings are valid and have local fixes.

| Comment | Finding | Fix |
| --- | --- | --- |
| 3950321541 | Invalid retry for a partly superseded submission | Server computes `canRetry` from all attempts. Keep the warning but remove the invalid retry action. |
| 3950321548 | Panel and inline views have separate drafts | Share one thread session, draft store, send lock, request id, and upload queue. |
| 3950616133 | Choice answers cannot add an attachment without selecting Other | Show the paperclip on the Other row when no text area is open. Upload does not change the choice. |
| 3950616150 | Other misreads older choice-plus-text answers | Show older notes separately. Selecting Other preserves their text and clears the choice. |
| 3950616161 | Draft comparison throws on oversized local input | Compare content with sorted object keys, without schema validation. Keep server validation unchanged. |
| 3950616172 | Initial loading is called saving | Add a loading state and leave the footer save indicator blank during initial load. |

## Decisions for approval

1. **Medium confidence. Attachment placement.** Use the right of the Other row
   only when no answer text area is open. Otherwise keep the approved top-right
   text-area position and fade. Alternative: always show an attachment-only
   text area. Risk: the fallback icon can appear to belong to Other, although
   it is a separate button and does not select Other. Desktop and mobile live
   checks must confirm the placement.

2. **Medium confidence. Session lifetime.** Share sessions by thread id within
   one plugin browser runtime, not by RPC object identity. Release saved,
   idle sessions after the last view closes and saves settle. Keep unsaved
   sessions and unconfirmed request ids until resolved or the runtime ends.
   Alternative: delete immediately and restore browser backups. Risk: many
   unresolved threads can retain memory. This avoids losing an in-flight save
   or request id on close. Other browser windows still use server version
   checks. Live verification must confirm both host views use the same bundle.

3. **High confidence. Retry authority.** Add a computed `canRetry` field to
   submission RPC data, using the same database check as retry validation.
   No database migration is needed. Alternative: compare timestamps in the
   client. Risk: frontend and backend must be updated together. The server
   value covers equal timestamps and attempts outside the recent list.

4. **High confidence. Partial supersession.** Keep the existing uncertain
   delivery warning, but direct the user to check the thread and submit
   remaining drafts when retry is no longer allowed. Alternative: resend a
   subset of the old snapshot. Risk: the user must decide what remains to
   send. The plugin does not choose which old answers should be sent again.

5. **High confidence. Older notes.** Do not rewrite saved answers. Render
   single-choice answers that have both a choice and typed notes with an
   Additional notes editor and only one checked radio. Changing the choice
   keeps those notes. Selecting Other keeps the text and clears the choice.
   Alternative: migrate notes to the selected option's detail field. Risk:
   older answers retain a form that new answers do not create. Once Other is
   explicitly selected, deselecting it clears its text as requested.

6. **High confidence. Comparison and limits.** Sort object keys recursively
   for comparison without parsing local input. Keep whitespace and array
   order unchanged. Alternative: cap or truncate text in the editor. Risk:
   oversized drafts still fail server validation. This fix prevents a crash;
   it does not raise limits or promise that invalid drafts survive reload.

7. **High confidence. Shared operations.** Use a synchronous shared send lock,
   one upload queue, and one pending flush promise. A new close-and-reopen test
   exposed a concurrent-flush race; the store now joins those calls. Repeated
   retry requests also reuse their id after a transport failure. Alternative:
   coordinate only draft text. Risk: one view's upload or submit can block
   another view briefly. That is necessary to preserve the saved versions.

8. **High confidence. Loading status.** Leave the footer indicator blank until
   initial loading finishes, while the existing loading message stays visible
   in the body. Alternative: add another loading label in the footer. Risk:
   the footer is briefly empty. Save failures and conflicts retain their labels.

9. **High confidence. Tests and release scope.** Add regression tests for all
   six findings, shared send locks, request-id reuse, separate threads,
   multiple owners, StrictMode lifecycle, and close/reopen during a save.
   Give independent test servers distinct thread ids. The prior load-error
   test mounted two independent servers under one thread id; it now uses a
   separate thread for the failed load, without removing its assertions.
   Alternative: clear the shared registry between mounts, which would hide
   the production behavior. Risk: host layout and native browser integration
   remain unverified for this patch.

## Verification

- 76 tests pass across four files.
- Typecheck and `bb plugin build` pass.
- `git diff --check` passes.
- Fetched origin and rebased onto its updated main branch without conflicts.
- No live installation changed. Desktop and mobile verification comes after
  approval, commit, push, and update of the existing branch installation.
- Cursor threads remain unresolved until the fixes are pushed and verified.

## Verdict

I stand behind these local fixes and their tests. I do not yet claim the
updated plugin is ready for release. The two medium-confidence UI and runtime
choices need approval and live verification. I am not giving a new blanket
verdict on older commits outside this patch.
