# Questions naming audit

Approved by the user on 2026-09-07. Proceed with commit and branch installation.

1. **Remove old API names without aliases.** Use `panel` and `inline` modes,
   and the `questions` panel action ID. Alternative: keep deprecated aliases.
   Confidence: medium. Cached agent tool schemas will reject calls using the
   old mode, and saved tabs using the old action ID must be closed and reopened.
   The public SDK has no saved action-ID migration API. The root README records
   that upstream gap. No private host state is changed.
2. **Migrate persisted modes once.** Append a SQL migration that changes only
   old round modes to `panel`. Alternative: translate old modes on every read.
   Confidence: high. Existing answers, drafts, IDs, timestamps, and submission
   snapshots stay unchanged. Rolling back to the old build requires a database
   backup because it cannot read the new mode. Reload preservation is tested.
3. **Rename implementation symbols and paths.** Use `useQuestions`,
   `QuestionsController`, `QuestionsPanel`, `RoundCard`, `QUESTIONS_ACTION_ID`,
   and `components/questions/`. Alternative: keep internal names or put these
   components directly under `components/`. Confidence: high. External imports
   of these private source paths would need updating; none are advertised.
4. **Keep existing question-related storage keys and RPC names.** These already
   use Questions terminology. Alternative: version all keys with this rename.
   Confidence: high. Keeping them preserves pending browser drafts. No schema
   change to draft contents requires a new key.
5. **Keep historical material unchanged.** Update the plugin and its current
   README, not the earlier HTML proposal or historical audit evidence.
   Alternative: rewrite all historical terminology. Confidence: high. Searches
   across the repository can still find the former design name. In the plugin,
   the old name remains only in the migration and its test fixtures.
6. **Test the migration and card wording locally before installation.** All 55
   tests, typecheck, and build pass. Tests cover the exact six-question label,
   singular wording, submitted rather than draft counts, the new panel action,
   old-mode rejection, and data preservation through reload. Alternative: install
   before triage and test live. Confidence: high for local behavior; this change
   has not been checked in the installed UI. Live checks remain after approval.

Verdict: I stand behind these changes with the compatibility costs above made
explicit. No runtime alias is kept, and no saved answer is discarded.
