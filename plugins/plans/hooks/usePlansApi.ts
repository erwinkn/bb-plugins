import { useRpc } from "@get-bb/plugin-sdk/app";
import type { plansContract } from "../contract";

export type PlansRpc = ReturnType<typeof useRpc<typeof plansContract>>;

/** One typed client for the plans backend; components call it, never raw rpc. */
export function usePlansApi(): PlansRpc {
  return useRpc<typeof plansContract>();
}

export const PLANS_CHANGED = "plans-changed";
export const PLANS_PAGE_SIZE = 10;
