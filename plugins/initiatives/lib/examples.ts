/** Small validated examples for `bb initiative command`, rather than a second schema. */
export const COMMAND_EXAMPLES = {
  spawn: { action: "delegate", route: "fresh", label: "Search index", area: "search ranking", tasks: ["T11"], note: "Index archived records and rank them below live ones. Verify with npm test." },
  review: { action: "delegate", route: "fresh", role: "review", label: "Review search", area: "review W4", reviews: "W4", note: "Check ranking and the archived-record tests." },
  "work-message": { action: "delegate", route: "continue", worker: "W4", tasks: ["T11"], note: "Fix the two review findings below…", delivery: "queue" },
  "fresh-with-handoff": { action: "delegate", route: "fresh", label: "Search ranking", area: "ranking", handoffs: ["W4"], note: "Start from W4's report and verify it against the current source." },
  message: { action: "message", target: "W4", text: "The agreed RPC contract is in the linked artifact; no scope change.", mode: "queue" },
  "task-close": { action: "task-close", task: "T11", outcome: "done", note: "Shipped in W4's report; review found nothing blocking." },
  question: { action: "question", question: "Who signs off the macOS bridge?", context: "Requires a native machine check before rollout.", options: [{ label: "Erwin", consequences: "Wait for the human machine check." }, "Skip the check"], recommendation: "Erwin" },
  answer: { action: "answer", ref: "D12", choice: "Erwin", note: "I will run the check." },
  "quiet-answer": { action: "answer", ref: "D12", choice: null, note: "Already resolved in this chat.", notify: false },
  "user-choice": { action: "user-choice", description: "Erwin chose one per-key batch-size setting." },
  "veto-request": { action: "veto-request", description: "I'm keeping the old index format for one release so rollbacks stay possible." },
  supersede: { action: "user-choice", description: "Erwin now wants two batch-size settings, per input.", supersedes: "D7" },
  withdraw: { action: "withdraw", ref: "D12", reason: "Settled by D15: Erwin chose Base UI in chat." },
  handover: { action: "coordinator-handover", reason: "Context is getting long", note: "W4 is mid-way through T11; the review of T9 is due." },
} as const;
export const READ_EXAMPLES = {
  overview: {},
  exact: { refs: ["W4", "T11"] },
  reports: { view: "reports", limit: 5 },
  fullReport: { refs: ["A34"], detailed: true, fields: ["report"] },
  workers: { view: "workers", limit: 8 },
  context: { view: "context" },
} as const;
