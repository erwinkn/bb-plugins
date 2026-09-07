# Questions interaction update

Approved by the user on 2026-09-07. Implemented by the parent agent.
No Opus worker was used. Proceed with commit and branch installation.

## Decisions

1. **Paste images only where attachments are enabled.** The handler accepts
   images pasted into answer and option-detail text areas. Inline questions
   still have no attachments. Alternative: permit images on every question.
   Confidence: medium. Pasting into a question without attachment permission
   will not upload an image. Existing upload limits and ownership checks apply.
   Text-only clipboard content follows normal browser behavior. Mixed text and
   image content keeps normal text paste and uploads the image separately.

2. **Use Other as a selectable answer.** Single-choice Other replaces the
   predefined choice; multiple-choice Other can coexist with selected options.
   An optional `other` draft field preserves an empty open editor across reloads.
   Alternative: keep selection state only in the component or use a synthetic
   option ID. Confidence: high. An empty Other draft is saved but cannot be sent
   as an answer until it has content. Deselecting Other clears only its text,
   not previously attached files. Earlier nonempty free-text answers remain visible.

3. **Keep draft metadata out of answer comparison.** Submission normalization
   ignores the Other editor flag; text and selected options carry the answer.
   Draft comparisons now parse fields into schema order before comparing them,
   without trimming text. Alternative: compare raw property insertion order.
   Confidence: high. A flag-only change does not create a new submitted answer;
   a genuine text change still does. Tests cover reordered Other properties.

4. **Search files only in the picker.** Remove local URL and arbitrary-path
   suggestions. Keep existing reference types readable and removable so saved
   links are not lost. Alternative: retain link entry behind another control.
   Confidence: high. New links cannot be selected in this UI; a user can still
   write a link as answer text. Blank searches do not reach the file-search API.

5. **Put selected badges above the input inside its border.** The results list
   follows the whole control. Cap width at 28rem and use full available width
   below that. Alternative: badges below results or inline beside typed text.
   Confidence: medium. Many files create a taller control, but all selected
   files remain visible while results are open.

6. **Remove sections from both the UI and current question schema.** Existing
   stored section labels are ignored rather than rewriting historical round
   JSON. Alternative: migrate every saved question blob. Confidence: high.
   Old callers that still send the field have it ignored; agents no longer see
   it in the tool schema. Question order and IDs stay unchanged.

7. **Use a 16px medium-weight intro and a static top-right attachment icon.**
   The icon has the same background as the text area and a matching soft shadow
   that covers nearby text. Alternative: reserve padding or add a toolbar row.
   Confidence: medium. The covered corner is intentionally not readable until
   the text moves away; this needs a live visual check in both themes. No new
   animation was added to typing or selection.

8. **Show accurate save state, not only two success-path labels.** Normal states
   are Saving draft and Draft saved. Save failure and conflict have short labels
   too. Alternative: always show Draft saved when no request is active.
   Confidence: high. Debounced edits count as saving, not saved. Offline backup
   capability is no longer repeated in the footer; failure notices remain.

## Validation and remaining work

All 63 tests, typecheck, build, and diff whitespace checks pass. Added tests
cover Other selection and clearing, empty Other persistence, image-paste upload
and capability gating, badge order, blank search, save status, and draft property
order. The installed UI and physical clipboard have not been checked for this
change. Live desktop and mobile-width checks remain after approval and install.
The two earlier Bugbot findings are not addressed by this interaction update.

Verdict: I stand behind the implementation and the disclosed limits. Visual
approval of the attachment fade remains pending; I do not claim live verification.
