import type { DecisionRecord } from "./store";
/** Shared backend eligibility; the dashboard receives this fact without full bodies. */
export const isAcceptableAgentDecision = (item: Pick<DecisionRecord, "status" | "madeBy" | "body" | "humanAttention" | "review">) =>
  item.status === "active" && item.madeBy === "agent" && item.review === "pending" && !("question" in item.body && item.body.question != null) && !item.body.answer && item.humanAttention !== "needs-opinion";
