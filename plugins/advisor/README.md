# BB Advisor (prototype)

The Advisor watches threads you select, keeps immutable evidence of what their
agents do, and, only when you turn it on, asks a tools-less reviewer for
findings whose citations are checked mechanically. It implements stages S1–S3
of the reviewed design (T74: A140, amended by A144, A152, A160 and the A170
acceptance amendment; transport T76: A154, A161, A168).

```
watched thread ─events─► OBSERVER ─cards─► STORE (sqlite) ─► PANEL · CLI
 (any provider)    (reads only)      │ packet          ▲ validated findings
                                     ▼                 │
                        REVIEWER (one request) ─► VALIDATOR ─► issues, occurrences
                                     │
           fake · sonnet:pool · sonnet:anthropic-api · luna:pool · luna:openai-api · jev:typesafe
```

## What it never does

- Send to, steer, stop or change a watched thread, its files, tasks,
  assignments or decisions. The model gets no tools.
- Retry a review, fall back to another model, route or account, or alias a
  model id. A response naming another model is a `cut`, not a success.
- Convert subscription quota to USD, or refund unknown usage.
- Close an issue because tests pass. "Mark seen" is not sign-off.
- Call anything a user instruction: a request without a sender thread is
  `UNATTRIBUTED: user or plugin`.

## Layout

| Path | What |
|---|---|
| `src/rules/` | The accepted reference rules, ported: diff and hunk-local scope grammar (`scope.ts`), citation validation (`validate.ts`), the request table and authority (`requests.ts`), completion freshness (`snapshot.ts`), the packet builder (`packet.ts`), event paging (`events.ts`), issue identity (`findings.ts`), retained citations (`retain.ts`), pause reasons, checkpoints, scheduler, Jev window. Pure functions and small classes. |
| `src/config/` | Settings descriptors and the shared validator (`settings.ts`), the route table (`routes.ts`), versioned prices and reservations (`prices.ts`). |
| `src/transport/` | Bounded HTTP (`http.ts`), wire builders and parsers (`wires.ts`), outcome classification (`transports.ts`), the strict output schema (`output.ts`), the fake reviewer (`fake.ts`). |
| `src/store/` | SQLite schema (append-only migrations) and the durable store. |
| `src/runtime/` | Observation (`observer.ts`, `drain.ts`, `checkpoints.ts`), review (`reviewer.ts`), context reads (`context.ts`, `projects.ts`), the orchestrator (`advisor.ts`), ledger helpers. |
| `src/review/` | Charter, intent-word filter, model-finding acceptance. |
| `src/rpc.ts`, `src/views.ts`, `src/cli.ts`, `server.ts` | RPC contract, read models, `bb advisor`, the factory. |
| `app.tsx`, `app/` | Advisor page, thread side panel, Settings section, notification listener. |
| `tests/` | See below. |

## Settings and defaults

| Setting | Default | Notes |
|---|---|---|
| Observe watched threads | on | No thread is watched until you pick one. |
| Watch scope / project | selected | `selected-and-project` also watches every non-archived thread of one project. Initiative watches are separate: see below. |
| Poll interval | 15 s | Event notices also wake it. |
| Turn-end test checkpoints / paths | on / 20 | Native limit 50 paths. |
| Test globs | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test_*.py`, `**/*_test.go`, `tests/**` | |
| Pending-instruction horizon | 30 min | |
| Run reviews | **off** | |
| Allow model provider requests | **off** | Real routes dispatch nothing while off. |
| Route | `fake` | |
| Sonnet effort / thinking | low / adaptive | `between_tools` only at effort high or below (error otherwise). |
| Luna effort | low | |
| Max output tokens | 2,000 | |
| Jev threshold | 0.7 | Unmeasured. |
| Custom instructions | empty | ≤ 4 KiB encoded; added as user policy, the charter wins. |
| Categories | all three on | Jev judges test integrity only; the rest is recorded as not judged. |
| Triggers | test change, failed command, claim, turn end | |
| Cadence | 2 tokens, refill 10 min, gap 2 min | At most `2 + T/10` reviews in T minutes per watch. |
| Body cap | 64 KiB | Jev is capped at 60 KiB. |
| Concurrency | 2 | One per watch. |
| Completion read pages | 8 | Pages of 100 request, receipt, stop and turn-end rows read when a review completes; more leaves the result held. |
| Held review expiry / rechecks per pass | 60 min / 4 | A held result is rechecked from what was paid for, never re-sent; when it expires its cards become a `held-expired` not-judged gap. |
| Pooled Luna stream cap | 4,096 KiB | Text deltas are read and dropped; only the final events (at most 256 KiB) are kept. |
| Daily caps (USD, API requests, subscription requests, subscription tokens) | **unset** | A route whose caps are unset refuses to start. |
| Budget day time zone | server zone | Calendar days, not rolling 24 h. A change during a day carries that day's charges until the new zone's next day begins (see Limitations). |
| Retention | evidence 14 d / 200 MB, findings 90 d / 5,000 | Ledger and settings log never pruned. |
| Display threshold / notifications | concern / badge | |
| API keys | unset | Secret settings, server side only. |

## Invalid stored settings

The host's Settings form and `bb plugin config` validate every value before
saving it. A stored value can still be invalid: one saved before a range
changed, or a hand-edited settings file. What reaches the Advisor depends on
BB, not on the plugin:

- **Wrong type or unknown option.** BB (0.43.1, `coerceStoredPluginSettingValue`)
  replaces it with the descriptor default before the plugin reads settings, and
  says nothing. The Advisor cannot detect this. For example, a stored
  `sonnetEffort: "ultra"` arrives as `low`. This is recorded as an upstream
  candidate in the repository README.
- **Out-of-range number.** It arrives unchanged. The Advisor substitutes the
  documented default, so polling, checkpoints, retention and every other bound
  run on the default. It shows a review error naming the key and keeps reviews
  off. Pruning waits while any retention value is invalid, and a held review
  never expires while `heldExpiryMinutes` is invalid. Deleting evidence or a
  paid result on a value the user did not choose is never the fallback.

## Integrations

- **Account Pooler** (`account-pool-local`, contract v1 in T94/A220):
  `POST …/http/advisor/v1/{messages|responses}` with the Pooler's plugin
  token fetched per review. Classification branches on
  `x-account-pool-dispatch` first: `none` (any status, including 499 and 503)
  is pre-upstream; `sent` + 499 is cut; `sent` + 5xx/529/502 is ambiguous;
  unstamped BB 500 is ambiguous; exact BB pre-handler 401/404/503 messages are
  pre-upstream.
- **Initiatives** (contract v1.1 in T96/A222): `GET …/http/context/v1/thread` and
  `…/record` of the `initiatives` plugin. Only BB's own 404 (the route is not
  installed) or no Initiatives plugin means "unavailable": threads are then
  reviewed as standalone, and threads the plugin created (origin `initiatives`,
  or `projects` from before its rename) get partial requirement coverage.
  Anything else is an unknown read, never "standalone", including BB's 503
  while the plugin is not running. The last delivered assignment stays the thread's brief in every
  phase (reported and accepted are progress; cancelled, rejected and failed are
  history); a queued `next` assignment is shown as a note, never a requirement.
- **Initiative watches** (T103) list `…/context/v1/initiatives` and
  `…/context/v1/members?initiativeId=&after=&limit=200` (paged by thread id).
  Members are listed at most every 10 s per watched Initiative, and at the
  next pass after BB's `thread.created`; a pass reads at most 5 pages and a
  longer walk continues at the next pass. Only a walk that reached the last
  page stops Initiative-owned watches of threads it no longer lists (moved to
  another Initiative or removed); a failed page stops nothing.
  Each member is an ordinary watch with origin `initiative`, so caps, route,
  triggers and reviews are unchanged and a thread watched both ways is one
  watch (yours stays yours; watching a member explicitly makes its watch
  yours, so Initiative off, removal or retirement no longer touch it). A member that joins after the watch was turned
  on is read from its first event. A member that turns `retired` or `former`,
  whose thread is archived or deleted (BB answers 404; any other read failure
  ends nothing), or whose Initiative is archived, is disabled with the reason
  kept; history stays and a user re-enable is not undone. Initiatives
  does not know native archive state, so the Advisor learns it cheaply: a
  member with an enabled watch from that watch's own thread read, any other
  member from one thread read before it would be (re)started, at most 20 reads
  per Initiative per pass (the rest wait a pass). Such a member is shown
  `archived` or `deleted`, read again every 5 minutes or on an unarchive event, and watched
  again once it is live. A missing listing route is
  "unavailable" for the listing only: thread context keeps working, existing
  member watches go on, and the Initiative watch shows the error.

## Feed, badge and Discuss (T105)

- **Entry (T106):** the Sidebar plugin draws the one Advisor row above the
  Initiatives header (and atop the Threads view). It reads the count once from
  this plugin's `unseen` RPC; afterwards this plugin pushes every change of the
  count to the Sidebar's `advisorChanged` RPC (coalesced 250 ms, sent only when
  the number changed, best effort when the Sidebar is absent), because an app
  only hears its own plugin's realtime. The count is unseen real findings (not
  previews) at or above the display threshold, summed over every watch. The
  `navPanel` registration stays because it is what serves the page's URL; hide
  its host row with BB's "Hide from sidebar" (a per-user preference).
- **Feed:** the page's default route. Newest first across all watches, with a
  `(createdAt, id)` cursor, filters by Initiative (watches whose thread an
  Initiative watch lists) or by thread. Preview findings stay labelled and are
  never counted. Mark all seen applies to the current filter.
- **Discuss:** route `discuss/<occurrenceId>` renders BB's
  `experimental_NewThreadComposer` seeded (`initialPrompt`, draft key
  `advisor:discuss:<id>`) with the finding, its citations and the watched
  thread's id, defaulting to the watched thread's project. Only the composer's
  submit calls `discussCreate`, which spawns a separate top-level thread titled
  `Advisor · <summary>` and remembers it; while that thread exists and is not
  archived, Discuss reopens it instead. The watched thread is never messaged.

## Review lifecycle

- **Dispatch gate.** Each observation pass and each dispatch reads the thread
  and its Initiative context. A failed or incomplete read (thread, membership,
  assignment or task brief), a former member (a replaced coordinator or a
  superseded generation) or a user Stop recorded by Initiatives sends nothing;
  the reason is shown on the watch and observation continues.
- **Cancellation.** A review canceled before its request (pause, disable,
  unwatch, a settings change, unload) reserves nothing and never calls fetch.
- **Held results.** A result whose currentness is unknown at completion is
  held: later passes recheck it from the stored result, with no new request,
  and the watch sends nothing else until it is current, stale or expired.
  A result that arrived just before a reload is held the same way.
- **Preview.** "Preview (fake)" findings are stored with their own ids and
  shown with a preview badge. They never set issue state, notify, reconfirm a
  real finding or move the frontier.
- **Restore, then repeat.** A later edit, or a vanished checkpoint hunk, that
  removes an open issue's cited lines is recorded on the issue (observed, not a
  fixed verdict); the next occurrence then notifies. A model "resolved" note
  counts only with such a newer edit in the packet: passing commands, claims
  and the citing card itself never resolve anything.
- **Later stages:** `recordsGet` is the read-only RPC a future Initiatives intake
  (S5) or decision capture (T80) can pull. Intake, coordinator wakes and
  decision recording do not exist and are shown as unavailable.

## Tests

```
npm run typecheck
npm test            # vitest: reference port, runtime, transports, budgets, store, UI
npm run build       # bb plugin build
npm run mutate      # single-rule reversions (A160 reference plus A228/A230 fixes); each must turn a test red
```

- `tests/a160-part-{a,b,c,d}.test.ts`: the 173 accepted reference cases with
  their raw inputs; `tests/coverage.test.ts` checks every case name is ported
  and that the package imports only the public SDK.
- `tests/fixtures/a160/`: the reference inputs copied verbatim, including the
  Python difflib patches the reference model produced, keyed by input hash.
- `tests/fork.test.ts`: the A170 fork fixture and the initial-parent anchor.
- `tests/a228.test.ts`, `tests/a230.test.ts`: regressions for the two review
  rounds; `tests/helpers/luna-stream.ts` builds a realistic offline Responses
  stream (modeled on the documented event shapes, not captured live).
- Runtime tests use the SDK's fake plugin host with a fake BB world
  (`tests/helpers/world.ts`) and fake fetch. Nothing reaches a network.
- `ADVISOR_DUMP_QUERIES=<file> npx vitest run` appends every event query the
  tests issue, one JSON line each, for re-checking against an installed BB
  query schema offline.

## Limitations

- Judgment quality, false-positive rates and real cost per review are
  unmeasured. Fake-reviewer results prove the pipeline, not the judgment.
- Live acceptance of pooled requests (U1/U2), TypeSafe access (U3) and the
  real `ownership_change` row shape are unverified.
- Fork inheritance uses `sourceThreadId`, the fork's `createdAt` and each
  copied row's `createdAt`; equal timestamps or missing metadata are treated
  as unknown origin (context only, partial coverage).
- Actions in the panel are not authenticated: BB has no caller identity for
  plugin RPC, so every action is logged with caller "unverified".
- Shell edits are seen only for test paths, at turn end, and only as
  uncommitted HEAD-relative patches; committed content is a named gap. Until
  the environment's root path is read, checkpoint cards call the writer
  attribution unknown (the read is retried every pass).
- Time-zone carry (D361): a change keeps the day's charges until the new
  zone's next midnight. Deliberate repeated changes can therefore start each new
  budget period early: hopping one zone west every hour gave four requests in
  about three hours on a one-per-day cap. Only an explicit Settings change can
  do this; the overview shows the active carry.
- An invalid stored type or option is invisible to the plugin (see
  "Invalid stored settings").
- The pooled Luna stream size per output token is modeled (about 250 bytes
  of framing per visible token, without the live `obfuscation` padding), not
  measured on a live Codex stream.
