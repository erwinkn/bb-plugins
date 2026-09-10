# BB MCP scope and native boundaries

BB MCP 0.3.1 deliberately exposes thread management, not general BB
administration. The endpoint covers every ordinary and Personal project and
all hidden/visible threads, with 35 explicit tools.

## Included

Read-only project/host/provider discovery; thread create/fork/handoff,
send/steer, stop/retry; title, parent, section, visibility, pins/read state and
archive/unarchive; full conversation/result/change reads and native waits;
queued-message reads, versioned edits, ordering, cancellation and send-now;
pending questions/forms and permission approval or denial.

Approvals name one pending interaction. The requested decision must appear in
its native availableDecisions. Session grants are supported when offered.
This is not a machine-wide permission setter.

## Intentionally excluded

General SDK dispatch, CLI execution, arbitrary plugin RPC, permanent
thread/project/section deletion, direct filesystem/terminal access,
attachment administration, Git/PR writes, publishing/sharing, and
BB/plugin/provider/machine administration. The earlier general bridges and
generated full-SDK catalog have been removed, not merely hidden from discovery.

There are no project allowlists or plugin quotas, permission ceilings,
payload/output clipping or ledger-count admission caps. Old administrative
operation receipts are preserved on disk but cannot be read through the MCP.

The tool boundary does not prevent a coding agent from executing a task under
its native permissions. Starting work or approving an interaction can still
authorize file/command effects inside that thread.

## Native boundaries

- Host/provider availability and policy, native concurrency limits, costs,
  retained-history truncation, pagination and client/proxy timeouts remain.
- On BB 0.42.1, a follow-up queued before a scheduled thread's first run must
  specify `model`; otherwise BB reports "no stored execution model". Reuse
  the creation model. This was verified live in `pulse-ui`.
- Sticky permission-mode/service-tier updates are missing from
  `threads.update`; use create/send. Tracked in
  [BB #3401](https://github.com/get-bb/bb/issues/3401).
- Native fork requires cloneable provider sessions. Cross-provider handoff is
  a new conversation seeded with a rich source reference, not a cloned session.
- Archive can cascade to descendants and trigger managed-workspace cleanup;
  thread history is retained. Stop and queue cancellation are separate.
- Question/form values must satisfy the target's native response contract.
  The MCP cannot synthesize provider capabilities or device/login consent.
- Native waits require an active caller. There are no automatic completion
  callbacks for disconnected clients.
- The plugin ledger cannot atomically commit with BB dispatch.
  Lost responses remain outcome_unknown without automatic redispatch.
  Tracked in [BB #3396](https://github.com/get-bb/bb/issues/3396).
- Data-preserving managed source/ref switches remain an installer limitation.
  Follow the root README's stable-clone fallback.
  Tracked in [BB #2297](https://github.com/get-bb/bb/issues/2297).

All-project visibility and pending permission approvals use existing public
SDK methods; no upstream change is needed for those features.
