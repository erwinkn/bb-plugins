import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  ADVISOR_CONFIG_KEY,
  advisorConfigView,
  loadAdvisorConfig,
  mergeAdvisorConfig,
  type AdvisorConfigController,
} from "./advisor-config.js";
import { registerPoolCli } from "./cli.js";
import {
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  type AccountPoolConfigController,
  type PoolProvider,
} from "./contracts.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { createHub, type AccountPoolHub } from "./hub.js";
import {
  DEFAULT_RETENTION_DAYS,
  USAGE_LEDGER_KEY,
  UsageLedger,
  openLedgerDatabase,
  usageLedgerConfigSchema,
  type LedgerSettings,
} from "./ledger.js";
import { PoolOperations } from "./operations.js";
import { accountPoolRpcContract, createRpcHandlers } from "./rpc.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";
import {
  createProjectsContextReader,
  PROJECTS_PLUGIN_ID,
} from "./thread-context.js";
import {
  CacheWarmer,
  realWarmingTimers,
  type WarmingTimers,
} from "./warming.js";
import {
  effectiveWarmingConfig,
  loadWarmingConfig,
  mergeWarmingConfig,
  WARMING_CONFIG_KEY,
  warmingConfigView,
  type WarmingConfigController,
} from "./warming-config.js";
import { buildUsageReport } from "./usage-report.js";
import { parseOrThrow } from "./validation.js";

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  usageUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  disposeTimeoutMs?: number;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
  // Loopback fetch for the Projects context read; tests stub it.
  projectsFetch?: typeof fetch;
  warmingTimers?: WarmingTimers;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    let currentSettings = accountPoolConfigSchema.parse(
      (await bb.storage.kv.get("config")) ?? {},
    );
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        // Declared below; config.set is reachable only once RPC and the CLI are registered.
        recordLedgerSettings();
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return next;
      },
    };
    // Advisor and cache-warming settings are separate records. A stored record that fails
    // validation turns its feature off and reports why; native startup never depends on them.
    let advisorState = loadAdvisorConfig(
      await bb.storage.kv.get(ADVISOR_CONFIG_KEY),
    );
    if (!advisorState.ok) bb.log.warn(advisorState.error);
    const advisor: AdvisorConfigController = {
      get: () =>
        advisorConfigView(advisorState, currentSettings.switchThreshold),
      set: async (input) => {
        const next = mergeAdvisorConfig(
          advisorState,
          input,
          currentSettings.switchThreshold,
        );
        await bb.storage.kv.set(ADVISOR_CONFIG_KEY, next);
        advisorState = { ok: true, config: next };
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return advisorConfigView(advisorState, currentSettings.switchThreshold);
      },
    };
    let warmingState = loadWarmingConfig(
      await bb.storage.kv.get(WARMING_CONFIG_KEY),
    );
    if (!warmingState.ok) bb.log.warn(warmingState.error);
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const hubTokens = new HubTokenStore(secretDir, now);
    await hubTokens.initialize();
    const enrolledHosts = await bb.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const routing = new RoutingStore(bb.storage.kv, now);
    const db = bb.storage.database();
    bb.storage.migrate(db, QUOTA_MIGRATIONS);
    // The usage ledger's own record. An invalid one keeps the default retention.
    const storedLedgerConfig = usageLedgerConfigSchema.safeParse(
      (await bb.storage.kv.get(USAGE_LEDGER_KEY)) ?? {
        retentionDays: DEFAULT_RETENTION_DAYS,
      },
    );
    if (!storedLedgerConfig.success)
      bb.log.warn(
        `Stored ${USAGE_LEDGER_KEY} is invalid; keeping usage rows for ${DEFAULT_RETENTION_DAYS} days.`,
      );
    let retentionDays = storedLedgerConfig.success
      ? storedLedgerConfig.data.retentionDays
      : DEFAULT_RETENTION_DAYS;
    // Assigned below, once the warmer and the Projects reader exist.
    let threadLabel: (sessionKey: string) => {
      threadId: string;
      role: string | null;
    } | null = () => null;
    const ledgerDb = openLedgerDatabase(db, (message) => bb.log.warn(message));
    const ledger = new UsageLedger({
      db: ledgerDb,
      now,
      retentionDays: () => retentionDays,
      thread: (sessionKey) => threadLabel(sessionKey),
      log: (message) => bb.log.warn(message),
    });
    const quotas = new QuotaStore(db, (quota) => ledger.quota(quota));
    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;
    const upstreamFetch = options.fetch ?? transport?.fetch;
    let hubRef: AccountPoolHub | null = null;
    const projectsContext = createProjectsContextReader({
      fetch: options.projectsFetch ?? fetch,
      baseUrl: () => bb.server.loopbackBaseUrl,
      token: async () =>
        (await bb.sdk.plugins.token({ pluginId: PROJECTS_PLUGIN_ID })).token,
      now,
    });
    const warmer = new CacheWarmer({
      now,
      timers: options.warmingTimers ?? realWarmingTimers,
      config: () => effectiveWarmingConfig(warmingState),
      switchThreshold: () => currentSettings.switchThreshold,
      readContext: (threadId, signal, readOptions) =>
        projectsContext.read(threadId, signal, readOptions),
      threadSession: async (threadId, signal) =>
        (await bb.sdk.threads.context({ threadId, signal })).usage?.snapshot
          ?.providerSessionId ?? null,
      keepAlive: (request, signal) =>
        hubRef === null
          ? Promise.resolve({ kind: "skipped", reason: "hub not ready" })
          : hubRef.keepAlive(request, signal),
    });
    bb.onDispose(() => warmer.dispose());
    threadLabel = (sessionKey) => {
      const threadId = sessionKey.startsWith("session:")
        ? warmer.threadOf(sessionKey.slice(8))
        : null;
      if (threadId === null) return null;
      const context = projectsContext.peek(threadId);
      return {
        threadId,
        role:
          context?.kind !== "member"
            ? null
            : context.memberKind === "coordinator"
              ? "coordinator"
              : context.role,
      };
    };
    // The settings a usage report splits periods by: recorded now, and after every change.
    const recordLedgerSettings = () => {
      const { historyLimit: _limit, historyMinutes: _minutes, ...warming } =
        effectiveWarmingConfig(warmingState);
      const settings: LedgerSettings = {
        claudeMainCacheTtl: currentSettings.claudeMainCacheTtl,
        warming,
      };
      ledger.settings(settings);
    };
    recordLedgerSettings();
    ledger.flush();
    bb.onDispose(() => {
      ledger.close();
      if (ledgerDb !== db) ledgerDb.close();
    });
    const warming: WarmingConfigController = {
      get: () =>
        warmingConfigView(warmingState, currentSettings.switchThreshold),
      set: async (input) => {
        const previous = effectiveWarmingConfig(warmingState);
        const next = mergeWarmingConfig(warmingState, input);
        await bb.storage.kv.set(WARMING_CONFIG_KEY, next);
        warmingState = { ok: true, config: next };
        recordLedgerSettings();
        if (next.mode !== previous.mode)
          warmer.cancelAll(`warming mode changed to ${next.mode}`);
        // A narrower family list ends its leases and admissions before anything else is sent.
        warmer.reconcile();
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return warmingConfigView(warmingState, currentSettings.switchThreshold);
      },
    };
    for (const event of ["thread.archived", "thread.deleted"] as const) {
      bb.events.on(event, ({ thread }) =>
        warmer.cancelThread(thread.id, `thread ${event.slice(7)}`),
      );
    }
    // Links a Claude thread to the Claude Code session its requests carry, from BB's own record of
    // the thread's provider session. Nothing is added to the thread's environment. A turn start
    // ends the thread's leases first, synchronously: the snapshot read after it may still name the
    // previous session.
    for (const event of ["thread.active", "thread.idle"] as const) {
      bb.events.on(event, async ({ thread }) => {
        if (thread.providerId !== "claude-code") return;
        if (event === "thread.active") warmer.threadStarted(thread.id);
        if (!warmer.active()) return;
        try {
          const context = await bb.sdk.threads.context({ threadId: thread.id });
          const session = context.usage?.snapshot?.providerSessionId;
          if (session) warmer.linkSession(thread.id, session);
        } catch (error) {
          bb.log.debug(
            `Account Pooler could not read the session of ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }
    const hub = createHub({
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      hubTokens,
      getSettings: () => currentSettings,
      getAdvisorConfig: () => advisorState,
      fetch: upstreamFetch,
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      importClaudeCredentials: options.importCredentials,
      importCodexCredentials: options.importCodexCredentials,
      drainTimeoutMs: options.drainTimeoutMs,
      maxAffinityBindings: options.maxAffinityBindings,
      onUpstreamError: (provider, error) =>
        bb.log.warn(
          `Account Pooler ${provider} transport failed: ${transportErrorCode(error)}.`,
        ),
      onAccountsChanged: () =>
        bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      warming: warmer,
      ledger,
    });
    hubRef = hub;
    if (transport !== null) {
      bb.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => bb.sdk.hosts.list(),
      async (hostId) =>
        (await bb.sdk.system.providerStates({ hostId })).providers,
      now,
      () => bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      (accountId) => hub.refreshUsage(accountId, true),
    );
    const login = new ClaudeOAuthLogin({
      fetch: upstreamFetch,
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated) => operations.addOAuth(authenticated),
    });
    const codexLogin = new CodexDeviceLogin({
      fetch: upstreamFetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
    });
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(
        "Add and enable a Claude or Codex account with `bb pool-local account add`.",
      );
    }
    bb.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(operations, login, codexLogin, config, advisor, {
        config: warming,
        status: () => warmer.status(),
      }),
    );
    registerPoolCli(
      bb,
      operations,
      login,
      codexLogin,
      config,
      advisor,
      { config: warming, status: () => warmer.status() },
      {
        now,
        report: async (since) => {
          ledger.flush();
          const labels = Object.fromEntries(
            // Labels are often shared ("Erwin"), so the email tells accounts apart.
            (await accounts.list()).map((account) => [
              account.id,
              account.email ?? account.label,
            ]),
          );
          return buildUsageReport(db, {
            since,
            until: now(),
            ledger: { ...ledger.status(), retentionDays },
            accountLabels: labels,
          });
        },
        retentionDays: () => retentionDays,
        setRetentionDays: async (days) => {
          const next = parseOrThrow(usageLedgerConfigSchema, {
            retentionDays: days,
          });
          await bb.storage.kv.set(USAGE_LEDGER_KEY, next);
          retentionDays = next.retentionDays;
          ledger.pruneSoon();
          return retentionDays;
        },
      },
    );
    const proxiedHealth = async (provider: PoolProvider) =>
      (await operations.isRoutingEnabled(provider)) &&
      (await operations.hasUsableEnabledAccount(provider))
        ? {
            label: "Proxied",
            statusMessage:
              "Credentials are provided by the Account Pooler hub.",
          }
        : null;
    bb.providers.experimental_contributeEnv("claude-code", async (context) => {
      if (
        !(await operations.isRoutingEnabled("claude")) ||
        (await routing.isBypassed(context.threadId)) ||
        !(await operations.hasUsableEnabledAccount("claude"))
      ) {
        return [];
      }
      const token = await hubTokens.forHost(context.hostId);
      await routing.recordRouted(context.threadId, context.hostId);
      return [
        {
          name: "CLAUDE_CODE_PROMPT_CACHE_TTL",
          value: currentSettings.claudeMainCacheTtl,
          reason:
            "Explicit Claude main-session cache TTL before authentication detection",
        },
        {
          name: "ANTHROPIC_BASE_URL",
          value: {
            serverPath: "/api/v1/plugins/account-pool-local/http",
          },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
        {
          name: "ENABLE_TOOL_SEARCH",
          value: "true",
          reason:
            "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("claude-code", () =>
      proxiedHealth("claude"),
    );
    bb.providers.experimental_contributeEnv("codex", async (context) => {
      if (
        !(await operations.isRoutingEnabled("codex")) ||
        (await routing.isBypassed(context.threadId)) ||
        !(await operations.hasUsableEnabledAccount("codex"))
      ) {
        return [];
      }
      const token = await hubTokens.forHost(context.hostId);
      return [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: {
            serverPath: "/api/v1/plugins/account-pool-local/http/v1",
          },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("codex", () =>
      proxiedHealth("codex"),
    );
    bb.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Account Pooler disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    bb.http.route(
      "POST",
      "/v1/messages",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/messages/count_tokens",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    for (const route of [
      "/v1/responses",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/alpha/search",
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "codex"),
        { auth: "none" },
      );
    }
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    // Advisor routes: BB checks the plugin token; the hub applies the advisor-config switch.
    bb.http.route(
      "POST",
      "/advisor/v1/messages",
      (context) => hub.handleAdvisor(context.req.raw, "claude"),
      { auth: "token" },
    );
    bb.http.route(
      "POST",
      "/advisor/v1/responses",
      (context) => hub.handleAdvisor(context.req.raw, "codex"),
      { auth: "token" },
    );
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: (signal) => hub.start(signal),
    });
  };
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb pool-local status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
