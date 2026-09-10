# BB product parity

This is the implementation inventory and delivery plan for BB MCP, audited
against BB 0.42.1 / Plugin SDK 0.4.47 on 2026-09-10. Remote clients can inspect
the summary through `bb_get_capabilities`. A planned row is not an available
tool. Full product parity is an ongoing target, not a claim about this release.

The audit covers every public SDK area, the core thread UI/CLI workflow, and
the installed collaboration, sharing, voice, automation, and provider plugins.
Arbitrary third-party plugins can add new product features; their APIs need
separate versioned adapters. This inventory does not imply that a shared MCP
token should automatically gain all owner or administration privileges.

## Shipped in 0.2.0

| Product feature | MCP surface | Contract and limits |
| --- | --- | --- |
| Project discovery | `bb_list_projects` | Explicit allowed projects; project creation/admin is below. |
| Hosts, providers, models and execution capabilities | `bb_list_runtimes` | Host permission ceiling; provider permissions, service tiers, capabilities and composer actions; model reasoning levels/default. Catalogs are host/environment-specific. |
| Find threads and inspect tree relationships | `bb_list_threads`, `bb_get_thread` | Project/title scan, parent/source filters, roots/children filter, archived and hidden filters. Responses include parent/source IDs and visibility. A source filter selects BB-native source relationships such as forks, not handoff mentions. |
| Create root or child thread | `bb_create_thread` | Explicit `parentThreadId` creates the BB tree edge. Environment reuse is independent. Parent and target project/host must all be allowed. BB still enforces its parent ceiling. |
| Workspace choice | Create/handoff `environmentId`, `hostId`, `baseBranch` | New tasks default to managed worktrees. Reuse checks project/host ownership. Personal/unmanaged workspace creation is planned below. |
| Handoff | `bb_handoff_thread` | Matches the UI: fresh conversation containing a structured source-thread mention, with source environment reuse by default. `reuseSourceEnvironment: false` selects a fresh worktree. Provider can differ. Source history is resolved by BB's normal mention mechanism; the provider session is not cloned and the source is not automatically stopped or archived. |
| Create-time execution settings | Create/handoff `providerId`, `model`, `reasoningLevel`, `permissionMode`, `serviceTier` | Explicit values are validated against catalogs and ceilings. Defaults inherit parent execution where available, then project defaults, then the provider. Explicit excessive/unsupported permissions fail rather than silently promising the requested mode. |
| Title and thread metadata | `bb_update_thread`, compatibility `bb_rename_thread` | Title, parent assignment/removal, visible/hidden state. BB owns cycle checks and tree invariants. |
| Change model/reasoning without dispatch | `bb_update_thread` | Sticky model/reasoning within the existing provider, applied to next/later turns. Does not send a dummy prompt or restart active work. |
| Change permissions/service tier with next instruction | `bb_send_message` | Per-dispatch `model`, `reasoningLevel`, `permissionMode`, `serviceTier`. BB owns persistence and active-turn delivery behavior. Standalone permission/tier updates are an upstream gap below. |
| Queue or steer | `bb_send_message` | Actual sent/queued result and wait reason; execution changes may require queueing. |
| Scheduled first/follow-up message | Create/handoff/send `sendAt` | Future Unix milliseconds. Replay the original request/key, including its timestamp, even after that time passes. |
| Stop runtime | `bb_stop_thread` | Stops/releases current runtime. Queue cancellation is a separate planned action. |
| Status, queue and attention | `bb_get_thread`, `bb_get_result` | Runtime state, queue summary and pending interaction IDs/kinds reconciled from BB. Does not equate idle with task success. |
| History and result | `bb_get_events`, `bb_get_result` | Bounded event pages, sequence cursors and turn provenance. Raw tool output/reasoning and full timeline expansion are not currently returned. |
| Changes and PR metadata | `bb_get_changes` | Paginated changed files; bounded requested patches; all/uncommitted targets; read-only PR metadata. |
| Request recovery | `bb_get_operation`; local `bb mcp reconcile` | Create, handoff and send share a durable ledger. Handoffs share the thread admission limit. Ambiguous dispatch remains `outcome_unknown`; never automatically re-dispatched. Related source/parent scopes are checked on receipt reads. Existing 0.1 receipts remain compatible. |
| Capability discovery | `bb_get_capabilities` | Explicit implemented/planned/upstream/product-only status. |

Handoff source contract:
[BB's UI helper](https://github.com/get-bb/bb/blob/main/packages/client-core/src/prompt/thread-handoff-request.ts)
and [its behavior tests](https://github.com/get-bb/bb/blob/main/packages/client-core/test/thread-handoff-request.test.ts).
The adapter uses public SDK prompt inputs; it does not import private BB packages.

## Remaining inventory and concrete delivery plan

P1 completes the thread lifecycle. P2 adds collaboration and workspace changes.
P3 adds plugin adapters and explicitly enabled administration. Each is a
separate reviewable increment after the shipped priority gaps, rather than
an unrestricted BB RPC or shell forwarding tool.

| Feature | Available BB surface / missing contract | Planned MCP delivery |
| --- | --- | --- |
| Native session fork, anchored fork, side chat | `threads.fork`; provider fork capability; agent-only seed | **P1:** `bb_fork_thread` with source sequence, same-machine environment validation and durable creation key. Keep side-chat UI navigation optional. |
| Failed-turn retry | `threads.retry` | **P1:** `bb_retry_thread`, bound to failed request ID and optional schedule, preserving native acceptance/attempt semantics. |
| Compact and clear context | `threads.compact`, `clearContext` | **P1:** explicit context actions; identify destructive context reset separately; ledger any dispatching action. |
| Plan mode, cancel plan, goals | Structured composer command input; `cancelPlan`, `clearGoal`; provider-specific goal extensions | **P1:** typed supported plan/goal actions. Full goal mutation/pause/resume needs provider contract discovery, not synthesized private events. |
| Queue contents, edit/cancel, send-now, reorder, groups | `threads.queuedMessages.*`, `threads.queue.list` | **P1:** `bb_list_queue`, `bb_update_queued_message`, `bb_delete_queued_message`, `bb_send_queued_message`, reorder/group tools. ID-bound updates and policy-safe execution options; native waits remain authoritative. |
| Archive/unarchive and environment bulk archive | `threads.archive`, `archiveAll`, `unarchive`; `environments.archiveThreads` | **P1:** verify every affected descendant/hidden fork is allowed before cascading. Return affected IDs/counts. |
| Full-text search, counts, prompt recall | `threads.search`, `count`, `promptHistory`; project history | **P1:** scoped search/count/history with accurate server-side filters; never return mixed-project search hits unchecked. |
| Sections, pinning, read/unread, ordering | `threadSections.*`; thread pin/read/order; project reorder | **P1:** typed organization tools, with shared-section scope semantics documented. Existing reparent/visibility controls are already shipped. |
| Timeline, turn details, child summary, long tool output | `timeline`, `conversationOutline`, `timelineTurnSummaryDetails`, `childSummary`, events | **P1:** paginated timeline/detail tools and explicit truncation. Complete output may require an upstream retrieval API where BB only retains a preview. |
| Message edit/rewind | `threads.editMessage`; provider rewind capability and experiment | **P2:** expected request-sequence guard, explicit history-replacement action and provider capability checks. Workspace edits are retained by BB. |
| Questions, Plans, plugin forms | `threads.interactions.get/respond/cancel`; versioned Questions/Plans RPCs | **P2:** inspect/answer exact pending interaction IDs with bounded schema/data and stale-state rejection. Treat a plan approval as an explicit action, never infer it from chat text. |
| Command/file/tool approvals and grants | `threads.interactions.resolve` | **P2:** separately enabled approval capability; bind to one interaction and permitted grant scope. Do not let the agent expand its own operator policy. |
| Attachments and images | `projects.attachments.upload/read/copy`, typed prompt input | **P2:** bounded byte transfer, MIME limits, project ownership, content hashes. List/delete attachments lack a native API. |
| Read/edit workspace and thread artifacts | `files.*`; `threads.storageFiles/storagePaths/storageLocation` | **P2:** workspace/thread-root confinement, pagination, UTF-8/base64 limits, compare-and-swap writes. Keep server credentials outside allowed roots. |
| More diff targets, branches and commits | Environment `diff*`, `paths`, `status`, `commit` | **P2:** branch/commit diff selectors and explicit commit action with an observed-state guard. |
| PR ready/draft/merge | Environment PR mutation methods | **P2:** separately enabled named actions and explicit repository/PR/head checks; no automatic ready/merge side effect of task completion. |
| Project lifecycle and source mapping | `projects.get/create/update/delete`, `sources.*`, paths/files/branches/commands | **P2:** project-management capability distinct from coding scope, bounded path/source validation and destructive confirmations. |
| Environment metadata and workspace creation modes | `environments.get/update/status`; spawn workspace union | **P2:** inspect/update environment and explicit personal/unmanaged workspace selection; do not silently move active threads. |
| Terminals and command execution | `terminals.*` | **P2:** explicit execution capability, thread/environment scope, terminal ownership and bounded output. This must not appear as a generic admin backdoor. |
| Public/authenticated thread sharing | Installed Share plugin's `share_status/list/create/update/revoke` RPCs | **P3:** versioned Share adapter with publication/expiry/audience/tool-output controls, source scope checks and explicit public-share intent. Separate public ingress paths remain necessary. |
| Voice sessions, model/voice choice, transcripts and worker controls | Installed Voice Mode plugin | **P3:** versioned voice adapter for session metadata/actions and settings; use existing BB tools for coding actions. Audio capture/playback and device permission remain interactive. |
| Notifications and task-completion callbacks | BB lifecycle/events; notification plugins; external callback contract | **P3:** durable outbox, destination allowlist, retry/dedup and subscriber ownership. MCP request completion alone does not wake an assistant. |
| Automations, schedules, workflows | Installed Automations/Workflows plugin contracts | **P3:** versioned scheduling adapter with scope, run history and preserved credentials; distinguish automation schedules from message `sendAt`. |
| Providers, models, CLI installation and health | `providers.*`; host provider CLI methods; provider plugins | **P3:** opt-in provider-administration tools. Discovery is already shipped. Harness migration requires handoff/fork capabilities rather than changing a running thread's provider ID. |
| Machine enrollment, rename/remove/update | `hosts.*` | **P3:** opt-in owner administration with enrollment credentials delivered through a secure operator flow. Machine permission ceiling is deliberately owner-UI-only below. |
| Skills and registries | `skills.*`, `skills.registry.*` | **P3:** scoped read/install/update/remove with provenance and write checks. |
| Plugins, catalogs, marketplaces and upgrades | `plugins.*` and subareas | **P3:** named administration actions with manifest/version validation and state-preserving source updates. No arbitrary `callRpc` tool or remote token-export tool. |
| Global settings, experiments, themes, keyboard preferences | `system.*`, `theme.*` | **P3:** opt-in non-secret settings adapter with an explicit field allowlist. Settings that require local UI interaction remain product-only. |
| Tabs, panes, opening files, browsing UI | `threads.tabs/open/paneAction`; client/browser plugin APIs | **P3:** optional UI-navigation tools with a chosen client/window. Device focus, gestures and local browser login are not headless execution features. |
| Usage, limits, runtime health and versions | `system.version/usageLimits/providerStates/executionOptions`, `status.get` | **P3:** bounded connection/operator health tools; avoid leaking other projects' activity. |
| Permanent deletion and data export | Thread/project/host/file delete methods; storage/plugin-specific export | **P3:** explicit destructive capability with observed target/scope and dependent-resource checks. Export is bounded and excludes credentials. |

Acceptance for each increment: modern and legacy MCP clients discover the same
schema; unauthorized direct IDs and transitive effects are denied; reads are
bounded; stale mutations fail clearly; every dispatching/create action retains
idempotency and an explicit unknown-outcome path; live BB and Executor behavior
are verified on the installed commit. Destructive, publication, approval, and
administration capabilities must be independently operator-configured rather
than automatically enabled for the existing service token.

## Upstream gaps

- **Standalone permission/service-tier updates:** `threads.update` only accepts
  model/reasoning and metadata. Tracked in
  [BB #3401](https://github.com/get-bb/bb/issues/3401). Until BB adds this, use
  create/send fields; the MCP never sends an empty prompt or keeps hidden
  per-thread preferences to simulate a product update.
- **Atomic create/send deduplication:** [BB #3396](https://github.com/get-bb/bb/issues/3396).
  The same boundary applies to handoff creation.
- **Reliable plugin interaction events:** [BB #3397](https://github.com/get-bb/bb/issues/3397).
  Current reads reconcile against interactions instead of relying only on events.
- **Lossless installation source changes:** related
  [BB #2297](https://github.com/get-bb/bb/issues/2297); retain the stable-clone
  deployment fallback while a managed source switch is unavailable.
- **Plugin/API-specific gaps:** complete work-output retrieval, attachment
  inventory/removal, and unified provider goal mutation are recorded locally
  in the [repository README](../../README.md#potential-mcp-parity-api-gaps-to-validate-locally).
  Validate their exact contracts during P1/P2; issue filing is deferred.

## What stays in the product

The machine's maximum permission mode is intentionally editable only by the
owner in Settings → Machines; there is no public SDK setter. Human login,
identity consent, secure credential entry, operating-system/device permission
prompts, and actual microphone capture/playback remain interactive flows.
MCP may eventually initiate a supported secure flow and report its status; it
must not impersonate the owner, disclose credentials, or fabricate completion.

Most other gaps above are planned capabilities, not permanent product-only
restrictions. The agent-facing surface should expose the same underlying BB
operations once their scope, execution and publication contracts are explicit.
