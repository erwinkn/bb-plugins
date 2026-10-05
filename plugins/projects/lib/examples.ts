/** Small validated examples, rather than a second schema/command implementation. */
const report = {
  outcome: "succeeded", summary: "Streaming milestone implemented; awaiting independent review.",
  evidence: [{ kind: "check", label: "Focused streaming checks", result: "passed" }],
  handoff: { summary: "Streaming implementation", workspaceRevision: "checked-sha", verificationRevision: "checked-sha", files: ["src/stream.ts"] },
};
export const COMMAND_EXAMPLES = {
  message: { action: "message", target: "W4", text: "The agreed RPC contract is ready in the linked handoff; no scope change.", mode: "queue" },
  "task-checkpoint": { action: "task-checkpoint", task: "T11", worker: "W4", report },
  review: { action: "delegate", role: "review", route: "fresh", label: "Streaming review", area: "Streaming", reviewOf: ["T11"], reviewTargets: [{ task: "T11", assignment: "A34", revision: "checked-sha" }], access: "read-only" },
  question: { action: "question", question: "Who signs off the macOS bridge?", context: "Requires a native machine check before rollout.", options: [{ label: "Erwin", consequences: "Wait for the human machine check." }, "Skip the check"], recommendation: "Erwin runs the native check.", blocksTaskIds: ["T11"] },
  answer: { action: "answer", ref: "D12", choice: "Erwin", note: "I will run the check." },
  "quiet-answer": { action: "answer", ref: "D12", choice: null, note: "Already resolved in this chat.", notify: false },
  decision: { action: "decision", madeBy: "user", description: "Erwin chose one per-key batch-size setting." },
  supersede: { action: "decision", madeBy: "user", description: "Erwin now wants two batch-size settings, per input.", supersedes: "D7" },
  "scope-release": { action: "assignment-scope-release", assignment: "A34", reportVersion: "3f9c2a7d1e0b4c6a", reason: "Checked: the nohup migrate job A34 listed is gone; release its write scope." },
  reject: { action: "assignment-reject", assignment: "A34", reason: "Blocked on the staging credential; retry the same task with the answer." },
  "decision-cleanup": { action: "cleanup", ref: "D13", operation: "remove", reason: "Erwin requested removing routine execution steps from active decisions." },
  withdraw: { action: "withdraw", ref: "D12", reason: "Settled by D15: Erwin chose Base UI in chat." },
  "fresh-with-handoff": { action: "delegate", route: "fresh", label: "Search ranking", area: "Ranking", tasks: ["T12"], handoffs: ["A34"], note: "A34 finished search; start from its handoff and verify it against current source." },
  "urgent-continue": { action: "delegate", route: "continue", worker: "W4", tasks: ["T11"], delivery: "steer", note: "Urgent correction: use the agreed wire contract before continuing." },
} as const;
export const READ_EXAMPLES = {
  mixed: { refs: ["A34", "T11", "D12"], detailed: true },
  report: { view: "assignments", refs: ["A34"], detailed: true, fields: ["report.handoff", "report.evidence"] },
  handoff: { refs: ["A34"], detailed: true, fields: ["standardHandoff"] },
  peers: { view: "workers", offset: 0, limit: 8 },
  page: { view: "tasks", offset: 0, limit: 5 },
} as const;
