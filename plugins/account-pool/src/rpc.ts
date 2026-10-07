import { defineRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  accountAddInputSchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountSchema,
  accountSummarySchema,
  bypassInputSchema,
  codexLoginCancelSchema,
  codexLoginPollInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  hubTokenSummarySchema,
  loginCompleteInputSchema,
  loginStartSchema,
  routedThreadStatusListSchema,
  statusSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import {
  advisorConfigViewSchema,
  type AdvisorConfigController,
  type AdvisorConfigSetInput,
} from "./advisor-config.js";
import {
  warmingConfigViewSchema,
  type WarmingConfigController,
  type WarmingConfigSetInput,
} from "./warming-config.js";
import { warmingStatusSchema, type WarmingStatus } from "./warming.js";
import {
  threadCacheStateInputSchema,
  threadCacheStateSchema,
  type ThreadCacheState,
} from "./thread-cache.js";
import type { PoolOperations } from "./operations.js";
import type { ClaudeOAuthLogin } from "./oauth-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";

// Accepts any JSON input with the given type; the handler validates it.
function validatedByHandler<T>() {
  return z.custom<T>(() => true);
}

export const accountPoolRpcContract = defineRpcContract({
  "account.add": {
    input: accountAddInputSchema,
    output: accountSchema,
  },
  "account.list": {
    input: z.null(),
    output: z.array(accountSummarySchema),
  },
  "account.remove": {
    input: accountIdInputSchema,
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "account.enable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.disable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.setPriority": {
    input: accountPriorityInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.reorder": {
    input: accountReorderInputSchema,
    output: z.null(),
  },
  "account.refreshUsage": {
    input: z.object({ accountId: z.string().uuid() }).strict(),
    output: z.object({ account: accountSummarySchema.nullable() }).strict(),
  },
  "routing.set": {
    input: routingSetInputSchema,
    output: z
      .object({ provider: z.enum(["claude", "codex"]), enabled: z.boolean() })
      .strict(),
  },
  "config.get": {
    input: z.null(),
    output: accountPoolConfigSchema,
  },
  "config.set": {
    input: accountPoolConfigSetInputSchema,
    output: accountPoolConfigSchema,
  },
  "advisor.get": {
    input: z.null(),
    output: advisorConfigViewSchema,
  },
  // The two settings updates are typed here but validated in their handlers (mergeAdvisorConfig,
  // mergeWarmingConfig), so an RPC caller gets the same plain-text error as Settings and the CLI
  // rather than the host's generic "rpc input validation failed".
  "advisor.set": {
    input: validatedByHandler<AdvisorConfigSetInput>(),
    output: advisorConfigViewSchema,
  },
  "warming.get": {
    input: z.null(),
    output: warmingConfigViewSchema,
  },
  "warming.set": {
    input: validatedByHandler<WarmingConfigSetInput>(),
    output: warmingConfigViewSchema,
  },
  "warming.status": {
    input: z.null(),
    output: warmingStatusSchema,
  },
  // Initiatives asks this before it gives more work to an idle worker (T142).
  "threads.cacheState": {
    input: threadCacheStateInputSchema,
    output: threadCacheStateSchema,
  },
  "login.start": {
    input: z.null(),
    output: loginStartSchema,
  },
  "login.complete": {
    input: loginCompleteInputSchema,
    output: accountSchema,
  },
  "codexLogin.start": {
    input: z.null(),
    output: codexLoginStartSchema,
  },
  "codexLogin.poll": {
    input: codexLoginPollInputSchema,
    output: codexLoginPollSchema,
  },
  "codexLogin.cancel": {
    input: codexLoginPollInputSchema,
    output: codexLoginCancelSchema,
  },
  "status.get": {
    input: z.null(),
    output: statusSchema,
  },
  "status.routedThreads": {
    input: z.null(),
    output: routedThreadStatusListSchema,
  },
  "token.rotate": {
    input: tokenRotateInputSchema,
    output: hubTokenSummarySchema,
  },
  "bypass.set": {
    input: bypassInputSchema,
    output: bypassInputSchema,
  },
});

export function createRpcHandlers(
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
  advisor: AdvisorConfigController,
  warming: {
    config: WarmingConfigController;
    status: () => WarmingStatus;
    threadCache: (threadIds: string[]) => Promise<ThreadCacheState>;
  },
): PluginRpcHandlers<typeof accountPoolRpcContract> {
  return {
    "account.add": (input) => operations.add(input),
    "account.list": () => operations.list(),
    "account.remove": async ({ id }) => ({
      removed: await operations.remove(id),
    }),
    "account.enable": async ({ id }) => ({
      account: await operations.enable(id),
    }),
    "account.disable": async ({ id }) => ({
      account: await operations.disable(id),
    }),
    "account.setPriority": async ({ accountId, priority }) => ({
      account: await operations.setPriority(accountId, priority),
    }),
    "account.refreshUsage": async ({ accountId }) => ({
      account: await operations.refreshUsage(accountId),
    }),
    "account.reorder": async ({ provider, accountIds }) => {
      await operations.reorder(provider, accountIds);
      return null;
    },
    "routing.set": async ({ provider, enabled }) => {
      await operations.setRouting(provider, enabled);
      return { provider, enabled };
    },
    "config.get": () => config.get(),
    "config.set": (input) => config.set(input),
    "advisor.get": () => advisor.get(),
    "advisor.set": (input) => advisor.set(input),
    "warming.get": () => warming.config.get(),
    "warming.set": (input) => warming.config.set(input),
    "warming.status": () => warming.status(),
    "threads.cacheState": ({ threadIds }) => warming.threadCache(threadIds),
    "login.start": () => login.start(),
    "login.complete": (input) => login.complete(input),
    "codexLogin.start": () => codexLogin.start(),
    "codexLogin.poll": (input) => codexLogin.poll(input),
    "codexLogin.cancel": (input) => ({
      cancelled: codexLogin.cancel(input),
    }),
    "status.get": () => operations.status(),
    "status.routedThreads": () => operations.routedThreadsWithoutLocalLogin(),
    "token.rotate": ({ machine }) => operations.rotateToken(machine),
    "bypass.set": ({ threadId, bypassed }) =>
      operations.setBypass(threadId, bypassed),
  };
}
