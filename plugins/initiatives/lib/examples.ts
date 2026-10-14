/** Small validated examples for `bb initiative command`, rather than a second schema. */
export const COMMAND_EXAMPLES = {
  spawn: { action: "delegate", route: "fresh", label: "Search index", area: "search ranking", tasks: ["T11"], note: "Index archived records and rank them below live ones. Verify with npm test." },
  "work-message": { action: "delegate", route: "continue", worker: "W4", tasks: ["T11"], note: "Fix the two review findings below…" },
  "fresh-with-handoff": { action: "delegate", route: "fresh", label: "Search ranking", area: "ranking", handoffs: ["W4"], note: "Start from W4's report and verify it against the current source." },
  message: { action: "message", target: "W4", text: "The agreed RPC contract is in the linked artifact; no scope change." },
  "task-status": { action: "task-status", task: "T11", status: "cancelled", reason: "Erwin: drop T11, the vendor fixed it upstream." },
  rule: { action: "rule-add", text: "Every PR targets dev; main changes only through the release PR." },
  question: { action: "question", question: "Who signs off the macOS bridge?", context: "Requires a native machine check before rollout.", options: [{ label: "Erwin", consequences: "Wait for the human machine check." }, "Skip the check"], recommendation: "Erwin" },
  answer: { action: "answer", ref: "D12", choice: "Erwin", note: "I will run the check." },
  "quiet-answer": { action: "answer", ref: "D12", choice: null, note: "Already resolved in this chat.", notify: false },
  withdraw: { action: "withdraw", ref: "D12", reason: "Settled by D15: Erwin chose Base UI in chat." },
  handover: { action: "coordinator-handover", reason: "Context is getting long", note: "W4 is mid-way through T11; the review of T9 is due." },
} as const;
/** W188 (F5): names agents reach for, routed to the examples they mean. */
export const DESCRIBE_GROUPS: Record<string, readonly (keyof typeof COMMAND_EXAMPLES)[]> = {
  decision: ["question", "answer", "quiet-answer", "withdraw"],
  initiative_decision: ["question", "answer", "quiet-answer", "withdraw"],
  initiative_question: ["question", "withdraw"],
  initiative_rule: ["rule"],
  initiative_spawn: ["spawn", "fresh-with-handoff"],
  initiative_message: ["message", "work-message"],
  initiative_task: ["task-status"],
  initiative_manage: ["handover"],
};
export const READ_EXAMPLES = {
  overview: {},
  exact: { refs: ["W4", "T11"] },
  reports: { view: "reports", limit: 5 },
  fullReport: { refs: ["A34"], detailed: true, fields: ["report"] },
  workers: { view: "workers", limit: 8 },
  context: { view: "context" },
  rules: { view: "rules" },
} as const;
