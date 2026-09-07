# Questions mobile input audit

Changes after `651db4f`. The user approved these decisions on 2026-09-07.

## Decisions

1. **Medium confidence. Mobile font size.** Use 16 px for text areas and file
   search on viewports below the existing Tailwind `sm` breakpoint, or when
   the primary pointer is coarse. Keep 13 px for larger fine-pointer screens.
   Alternative: change all input text to 16 px. Risk: a mobile browser that
   reports a fine pointer at desktop width can still use 13 px. This is the
   standard focus-zoom mitigation, but physical Safari behavior is not verified
   here. Pinch zoom and host viewport settings remain unchanged.

2. **Medium confidence. Case-insensitive query workaround.** Lowercase the
   query before BB's existing fuzzy search. Alternative: implement a separate
   matcher or leave the issue to BB. Risk: intentional case-sensitive searches
   are no longer possible in this picker. BB still controls candidates,
   ranking, and the existing 20-result limit. This fixes the reproduced case
   mismatch; it does not claim to improve all fuzzy-search ranking. The
   desired upstream option is recorded in the root README, without filing an
   external issue.

3. **High confidence. Automatic height.** Resize the shared text-area component
   from its scroll height, preserving its existing minimum height and rows.
   Remove the manual resize handle and use the panel for vertical scrolling,
   without an arbitrary maximum field height. Alternative: cap fields and
   keep an internal scrollbar. Risk: very long answers produce tall questions.

4. **High confidence. Resize lifecycle.** Measure after controlled value
   changes, on native input, on width changes, window resize, and after fonts
   load. Ignore height-only observer changes to prevent a feedback loop.
   Disconnect observers and listeners on unmount. Alternative: rely only on
   the newer CSS field-sizing property. Risk: JavaScript measurement adds
   layout work while typing. No height animation is added, following the
   design-engineering skill's guidance for frequent keyboard actions.

5. **High confidence. Verification scope.** Add tests for lowercase SDK input,
   loaded text, growing and shrinking content, panel-width changes, observer
   cleanup, and mobile text classes. Alternative: claim success from build
   alone. Risk: the simulated layout test cannot prove physical iOS focus
   behavior. Live browser and user-device checks are still needed after
   approval and installation.

## Checks

- 78 tests pass. Typecheck and plugin build pass.
- Live installed search reproduced `Agents` returning no hits and `agents`
  returning `AGENTS.md` first. The patched version is not installed yet.
- SDK declarations expose no case-sensitivity option for environment paths.
- No new dependencies, data migrations, or host viewport changes.

## Verdict

I stand behind the local changes and their scope. I do not yet claim the
mobile zoom issue is resolved on the user's device. The user approved commit
and installation after reviewing these choices.
