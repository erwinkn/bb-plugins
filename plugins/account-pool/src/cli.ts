import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import { setTimeout as wait } from "node:timers/promises";
import {
  accountAddInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountPoolConfigSetInputSchema,
  bypassInputSchema,
  codexLoginPollInputSchema,
  loginCompleteInputSchema,
  modelFamilySchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfig,
  type AccountPoolConfigController,
  type AccountPoolConfigSetInput,
  type AccountSummary,
  type FamilyQuota,
  type LimitWindow,
  type ModelFamily,
  type PoolStatusReport,
} from "./contracts.js";
import type {
  AdvisorConfigController,
  AdvisorConfigView,
} from "./advisor-config.js";
import {
  parseWarmingUpdate,
  type WarmingConfigController,
  type WarmingConfigView,
} from "./warming-config.js";
import type { WarmingStatus } from "./warming.js";
import {
  formatUsageReport,
  parseSince,
  type UsageReport,
} from "./usage-report.js";
import type { PoolOperations } from "./operations.js";
import type { ClaudeOAuthLogin } from "./oauth-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";

interface ParsedFlags {
  booleans: Set<string>;
  values: Map<string, string>;
}

const HELP = [
  "Usage:",
  "  bb pool-local account add --provider claude --import [--label <text>] [--priority <n>]",
  "  bb pool-local account add --provider codex --import [--label <text>] [--priority <n>]",
  "  bb pool-local account add --provider claude --login",
  "  bb pool-local account add --provider codex --login",
  "  bb pool-local account login-poll --session <id>",
  "  printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb pool-local account login-complete --session <id> --code-stdin",
  "  bb pool-local account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]",
  "  bb pool-local account add --provider claude --api-key <key> [--label <text>] [--priority <n>]  Unsafe: exposes the key in process arguments.",
  "  bb pool-local account list [--json]",
  "  bb pool-local account remove <id>",
  "  bb pool-local account enable <id>",
  "  bb pool-local account disable <id>",
  "  bb pool-local account priority <id> <n>",
  "  bb pool-local account reorder <claude|codex> <id>...",
  "  bb pool-local account refresh <id>",
  "  bb pool-local status [--json]",
  "  bb pool-local routing <claude|codex> [--off]",
  "  bb pool-local config",
  "  bb pool-local config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold|claudeMainCacheTtl|sessionAffinityIdleMinutes> <value>",
  "  bb pool-local advisor",
  "  bb pool-local advisor set <claude|codex|maxUtilization> <on|off|value|null>",
  "  bb pool-local warming",
  "  bb pool-local warming set <key> <value>",
  "  bb pool-local warming status [--json]",
  "  bb pool-local usage report [--since <90m|24h|7d|iso>] [--json]",
  "  bb pool-local usage retention [<days>]",
  "  bb pool-local token rotate --machine <id-or-name>",
  "  bb pool-local bypass <thread-id> [--off]",
  "",
  "Accounts run sequentially by priority, then order added. The current fallback stays active until unavailable.",
  "Reorder includes every account for the provider and changes the next failover sequence; existing conversations stay pinned.",
].join("\n");

function parseFlags(
  argv: readonly string[],
  allowedBooleans: readonly string[],
  allowedValues: readonly string[],
): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${JSON.stringify(arg)}.`);
    }
    const name = arg.slice(2);
    if (booleans.has(name) || values.has(name)) {
      throw new Error(`Duplicate flag --${name}.`);
    }
    if (allowedBooleans.includes(name)) {
      booleans.add(name);
      continue;
    }
    if (!allowedValues.includes(name))
      throw new Error(`Unknown flag --${name}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }
  return { booleans, values };
}

function formatReset(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString();
}

function formatUtilization(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function familyLabel(family: ModelFamily): string {
  return family[0]?.toUpperCase() + family.slice(1);
}

function formatWindowLabel(window: LimitWindow): string {
  if (window.windowMinutes === null) return window.slot;
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}d`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}h`;
  return `${window.windowMinutes}m`;
}

function formatLimitWindows(windows: readonly LimitWindow[]): string {
  if (windows.length === 0) return "-";
  return windows
    .map(
      (window) =>
        `${formatWindowLabel(window)}=${formatUtilization(window.utilization)} ${formatReset(window.resetAt)}`,
    )
    .join("; ");
}

function formatFamilyQuota(quota: FamilyQuota | null): string {
  if (quota === null) return "-";
  return [
    formatUtilization(quota.utilization),
    quota.status ?? "-",
    formatReset(quota.resetAt),
    quota.source,
  ].join(" ");
}

function formatAccounts(accounts: readonly AccountSummary[]): string {
  if (accounts.length === 0) return "No accounts configured.";
  const families = modelFamilySchema.options.filter((family) =>
    accounts.some((account) => account.familyWeekly[family] !== null),
  );
  return [
    [
      "ID",
      "Label",
      "Email",
      "Provider",
      "Kind",
      "Enabled",
      "Priority",
      "5h",
      "5h reset",
      "7d",
      "7d reset",
      "Windows",
      ...families.map(familyLabel),
      "Status",
    ].join("\t"),
    ...accounts.map((account) =>
      [
        account.id,
        account.label,
        account.email ?? "-",
        account.provider,
        account.kind,
        String(account.enabled),
        String(account.priority),
        formatUtilization(account.fiveHourUtilization),
        formatReset(account.fiveHourResetAt),
        formatUtilization(account.sevenDayUtilization),
        formatReset(account.sevenDayResetAt),
        formatLimitWindows(account.limitWindows),
        ...families.map((family) =>
          formatFamilyQuota(account.familyWeekly[family]),
        ),
        account.status,
      ].join("\t"),
    ),
  ].join("\n");
}

function formatStatus(status: PoolStatusReport): string {
  return [
    `Route: ${status.route}`,
    `Accepting: ${status.accepting}`,
    `Enabled accounts: ${status.enabledAccountCount}`,
    `In flight: ${status.inFlight}`,
    "",
    "Machine tokens:",
    ...(status.hosts.length === 0
      ? ["None minted."]
      : status.hosts.map(
          (host) =>
            `${host.hostName ?? host.hostId}\t${new Date(host.mintedAt).toISOString()}\t${host.lastUsedAt === null ? "never" : new Date(host.lastUsedAt).toISOString()}`,
        )),
    "",
    "Recently routed threads without a local Claude login:",
    ...(status.routedThreadsWithoutLocalLogin.length === 0
      ? ["None."]
      : status.routedThreadsWithoutLocalLogin.map(
          (thread) =>
            `${thread.threadId}\t${thread.hostName ?? thread.hostId}\t${thread.localClaudeStatus}`,
        )),
    "",
    formatAccounts(status.accounts),
  ].join("\n");
}

function formatConfig(config: AccountPoolConfig): string {
  return [
    `anthropicUpstreamBaseUrl: ${config.anthropicUpstreamBaseUrl}`,
    `codexUpstreamBaseUrl: ${config.codexUpstreamBaseUrl}`,
    `switchThreshold: ${config.switchThreshold}`,
    `claudeMainCacheTtl: ${config.claudeMainCacheTtl}`,
    `sessionAffinityIdleMinutes: ${config.sessionAffinityIdleMinutes}`,
  ].join("\n");
}

function formatAdvisor(view: AdvisorConfigView): string {
  return [
    ...(view.error === null ? [] : [`error: ${view.error}`]),
    `claude: ${view.routes.claude ? "on" : "off"}`,
    `codex: ${view.routes.codex ? "on" : "off"}`,
    `maxUtilization: ${view.maxUtilization ?? "null (switchThreshold)"}`,
    `effectiveMaxUtilization: ${view.effectiveMaxUtilization}`,
  ].join("\n");
}

function formatAdvisorStatus(view: AdvisorConfigView): string {
  if (view.error !== null) return `Advisor routes: off (${view.error})`;
  const on = (["claude", "codex"] as const).filter(
    (provider) => view.routes[provider],
  );
  return `Advisor routes: ${on.length === 0 ? "off" : on.join(", ")}`;
}

// A raw update: advisor.set validates it, so the CLI prints the same plain text as RPC and Settings.
function parseAdvisorUpdate(key: string, value: string): Record<string, unknown> {
  if (key === "claude" || key === "codex") {
    if (value !== "on" && value !== "off")
      throw new Error("Advisor route value must be on or off.");
    return { routes: { [key]: value === "on" } };
  }
  if (key === "maxUtilization")
    return {
      maxUtilization:
        value === "null" ? null : value.trim() === "" ? Number.NaN : Number(value),
    };
  throw new Error("Advisor key must be claude, codex, or maxUtilization.");
}

function formatWarming(view: WarmingConfigView): string {
  return [
    ...(view.error === null ? [] : [`error: ${view.error}`]),
    ...Object.entries(view.config).map(
      ([key, value]) =>
        `${key}: ${Array.isArray(value) ? value.join(",") || "none" : (value ?? "null (switchThreshold)")}`,
    ),
    `effectiveQuotaReserve: ${view.effectiveQuotaReserve}`,
  ].join("\n");
}

function formatWarmingStatusLine(view: WarmingConfigView): string {
  return view.error === null
    ? `Cache warming: ${view.config.mode}`
    : `Cache warming: off (${view.error})`;
}

function formatTime(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString();
}

// Requests and token counts only: the Pooler makes no dollar estimate.
function formatWarmingStatus(status: WarmingStatus): string {
  const totals = status.totals;
  return [
    `mode: ${status.mode}`,
    `since: ${formatTime(status.since)}`,
    `native requests observed: ${totals.nativeObserved}`,
    `leases started: ${totals.leasesStarted}`,
    `refreshes: ${totals.refreshesSent} sent, ${totals.refreshesConfirmed} confirmed, ${totals.cacheMisses} found the entry gone, ${totals.refreshesPlanned} dry-run`,
    `refresh tokens: cache read ${totals.refreshCacheReadTokens}, cache write ${totals.refreshCacheWriteTokens}, uncached input ${totals.refreshInputTokens}, output ${totals.refreshOutputTokens}`,
    `retained request bytes: ${status.retainedBodyBytes}`,
    `awaiting link or classification: ${status.admissions.length === 0 ? "none" : status.admissions.map((admission) => `${admission.threadId ?? "unlinked"} (${admission.state})`).join(", ")}`,
    "",
    status.leases.length === 0
      ? "No active leases."
      : status.leases
          .map(
            (lease) =>
              `${lease.threadId} ${lease.model ?? "-"} ttl=${lease.ttl} ${lease.dryRun ? "dry-run " : ""}${lease.state} refreshes=${lease.refreshes} covered=${formatTime(lease.coveredUntil)} deadline=${formatTime(lease.deadline)} next=${formatTime(lease.nextRefreshAt)} window=${lease.windowLabel ?? "-"} prefix=${lease.prefixTokens} body=${lease.bodyHash}`,
          )
          .join("\n"),
    "",
    ...status.events.map(
      (event) =>
        `${formatTime(event.at)} ${event.kind} ${event.threadId ?? "-"} ${event.model ?? "-"}${event.ttl === null ? "" : ` ttl=${event.ttl}`}: ${event.message}`,
    ),
  ].join("\n");
}

function parseConfigUpdate(
  key: string | undefined,
  value: string | undefined,
): AccountPoolConfigSetInput {
  if (value === undefined) throw new Error(HELP);
  if (key === "anthropicUpstreamBaseUrl") {
    return accountPoolConfigSetInputSchema.parse({
      anthropicUpstreamBaseUrl: value,
    });
  }
  if (key === "codexUpstreamBaseUrl") {
    return accountPoolConfigSetInputSchema.parse({
      codexUpstreamBaseUrl: value,
    });
  }
  if (key === "claudeMainCacheTtl") {
    return accountPoolConfigSetInputSchema.parse({ claudeMainCacheTtl: value });
  }
  if (key === "sessionAffinityIdleMinutes") {
    return accountPoolConfigSetInputSchema.parse({
      sessionAffinityIdleMinutes: Number(value),
    });
  }
  if (key === "switchThreshold") {
    return accountPoolConfigSetInputSchema.parse({
      switchThreshold: Number(value),
    });
  }
  throw new Error(
    "Config key must be anthropicUpstreamBaseUrl, codexUpstreamBaseUrl, switchThreshold, claudeMainCacheTtl, or sessionAffinityIdleMinutes.",
  );
}

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface UsageController {
  now: () => number;
  report: (since: number) => Promise<UsageReport>;
  retentionDays: () => number;
  setRetentionDays: (days: number) => Promise<number>;
}

const DEFAULT_REPORT_SINCE = "7d";

export function registerPoolCli(
  bb: Pick<BbPluginApi, "cli">,
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
  advisor: AdvisorConfigController,
  warming: { config: WarmingConfigController; status: () => WarmingStatus },
  usage: UsageController,
): void {
  bb.cli.register({
    name: "pool-local",
    summary:
      "Manage Claude and Codex accounts and inspect the Account Pooler hub",
    commands: [
      {
        name: "account-add",
        summary:
          "Sign in to Claude or Codex, import credentials, or add an Anthropic API key",
        usage:
          "bb pool-local account add --provider <claude|codex> --login\nbb pool-local account add --provider <claude|codex> --import [--label <text>] [--priority <n>]\nbb pool-local account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]\nUnsafe compatibility form: bb pool-local account add --provider claude --api-key <key> [--label <text>] [--priority <n>]",
      },
      {
        name: "account-login-poll",
        summary: "Wait for a Codex device-code login to complete",
        usage: "bb pool-local account login-poll --session <id>",
      },
      {
        name: "account-login-complete",
        summary: "Complete a Claude browser login with its manual code",
        usage:
          "printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb pool-local account login-complete --session <id> --code-stdin",
      },
      {
        name: "account-list",
        summary: "List pool accounts and observed quota",
        usage: "bb pool-local account list [--json]",
      },
      {
        name: "account-remove",
        summary: "Remove an account and its secret token file",
        usage: "bb pool-local account remove <id>",
      },
      {
        name: "account-enable",
        summary: "Enable an account",
        usage: "bb pool-local account enable <id>",
      },
      {
        name: "account-disable",
        summary: "Disable an account",
        usage: "bb pool-local account disable <id>",
      },
      {
        name: "account-priority",
        summary: "Set an account's position in the failover priority order",
        usage: "bb pool-local account priority <id> <n>",
      },
      {
        name: "account-reorder",
        summary: "Set the complete failover order for one provider",
        usage: "bb pool-local account reorder <claude|codex> <id>...",
      },
      {
        name: "account-refresh",
        summary: "Refresh one account's observed usage",
        usage: "bb pool-local account refresh <id>",
      },
      {
        name: "status",
        summary: "Show hub, machine token, routing, and account status",
        usage: "bb pool-local status [--json]",
      },
      {
        name: "routing",
        summary: "Enable or disable pooled routing for one provider",
        usage: "bb pool-local routing <claude|codex> [--off]",
      },
      {
        name: "config",
        summary: "Show Account Pooler routing configuration",
        usage: "bb pool-local config",
      },
      {
        name: "config-set",
        summary: "Update one Account Pooler routing configuration value",
        usage:
          "bb pool-local config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold|claudeMainCacheTtl|sessionAffinityIdleMinutes> <value>",
      },
      {
        name: "advisor",
        summary: "Show Account Pooler advisor routes and their reserve",
        usage: "bb pool-local advisor",
      },
      {
        name: "advisor-set",
        summary: "Turn one advisor route on or off, or set the advisor reserve",
        usage:
          "bb pool-local advisor set <claude|codex|maxUtilization> <on|off|value|null>",
      },
      {
        name: "warming",
        summary: "Show Account Pooler cache-warming settings",
        usage: "bb pool-local warming",
      },
      {
        name: "warming-set",
        summary:
          "Set one cache-warming setting (mode, windows, families, limits, reserve)",
        usage: "bb pool-local warming set <key> <value>",
      },
      {
        name: "warming-status",
        summary: "Show cache-warming leases, refreshes and recent decisions",
        usage: "bb pool-local warming status [--json]",
      },
      {
        name: "usage-report",
        summary:
          "Report requests, cache use, cold starts, warming cost and quota burn by day and settings period",
        usage:
          "bb pool-local usage report [--since <90m|24h|7d|iso>] [--json]",
      },
      {
        name: "usage-retention",
        summary: "Show or set how many days the usage ledger keeps",
        usage: "bb pool-local usage retention [<days>]",
      },
      {
        name: "token-rotate",
        summary: "Rotate one machine's Account Pooler bearer token",
        usage: "bb pool-local token rotate --machine <id-or-name>",
      },
      {
        name: "bypass",
        summary: "Bypass Account Pooler routing for one thread",
        usage: "bb pool-local bypass <thread-id> [--off]",
      },
    ],
    async run(argv, ctx): Promise<PluginCliResult> {
      try {
        if (argv.includes("--help") || argv.includes("-h")) {
          return { exitCode: 0, stdout: `${HELP}\n` };
        }
        if (argv[0] === "account" && argv[1] === "priority") {
          if (argv.length !== 4 || argv[3]?.trim() === "")
            throw new Error(HELP);
          const input = accountPriorityInputSchema.parse({
            accountId: argv[2],
            priority: Number(argv[3]),
          });
          const account = await operations.setPriority(
            input.accountId,
            input.priority,
          );
          if (account === null) throw new Error("Account not found.");
          return {
            exitCode: 0,
            stdout: `Set ${account.label} priority to ${account.priority}.\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "reorder") {
          const input = accountReorderInputSchema.parse({
            provider: argv[2],
            accountIds: argv.slice(3),
          });
          await operations.reorder(input.provider, input.accountIds);
          return {
            exitCode: 0,
            stdout: `Updated ${input.provider} account order.\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "refresh") {
          if (argv.length !== 3) throw new Error(HELP);
          const { id } = accountIdInputSchema.parse({ id: argv[2] });
          if ((await operations.refreshUsage(id)) === null)
            throw new Error("Account not found.");
          return { exitCode: 0, stdout: `Refreshed usage for ${id}.\n` };
        }
        if (argv[0] === "account" && argv[1] === "add") {
          const flags = parseFlags(
            argv.slice(2),
            ["import", "api-key-stdin", "login"],
            ["provider", "api-key", "label", "priority"],
          );
          const imported = flags.booleans.has("import");
          const apiKeyStdin = flags.booleans.has("api-key-stdin");
          const loginRequested = flags.booleans.has("login");
          const apiKey = flags.values.get("api-key");
          const sourceCount =
            Number(imported) +
            Number(apiKeyStdin) +
            Number(loginRequested) +
            Number(apiKey !== undefined);
          if (sourceCount !== 1)
            throw new Error(
              "Choose exactly one of --login, --import, --api-key-stdin, or --api-key <key>.",
            );
          if (loginRequested) {
            const provider = flags.values.get("provider");
            if (provider !== "claude" && provider !== "codex") {
              throw new Error(
                "--login requires --provider claude or --provider codex.",
              );
            }
            if (flags.values.has("label") || flags.values.has("priority")) {
              throw new Error("--login does not accept --label or --priority.");
            }
            if (provider === "codex") {
              const started = await codexLogin.start();
              return {
                exitCode: 0,
                stdout: `${[
                  "Open this URL to sign in to Codex:",
                  started.verificationUri,
                  "",
                  `Enter this code: ${started.userCode}`,
                  `Session ID: ${started.sessionId}`,
                  "",
                  "After authorizing, wait for the account to be added with:",
                  `bb pool-local account login-poll --session ${started.sessionId}`,
                ].join("\n")}\n`,
              };
            }
            const started = login.start();
            return {
              exitCode: 0,
              stdout: `${[
                "Open this URL to sign in to Claude:",
                started.authorizeUrl,
                "",
                `Session ID: ${started.sessionId}`,
                "",
                "After signing in, pipe the code shown on the final page into:",
                `printf '%s\\n' \"$CLAUDE_AUTH_CODE\" | bb pool-local account login-complete --session ${started.sessionId} --code-stdin`,
              ].join("\n")}\n`,
            };
          }
          if (apiKeyStdin) {
            throw new Error(
              "--api-key-stdin must be invoked through the bb CLI so it can read stdin safely.",
            );
          }
          if (!imported && flags.values.get("provider") !== "claude") {
            throw new Error("Anthropic API keys require --provider claude.");
          }
          const priorityText = flags.values.get("priority") ?? "100";
          const input = accountAddInputSchema.parse({
            provider: flags.values.get("provider"),
            source: imported ? { kind: "import" } : { kind: "api-key", apiKey },
            label: flags.values.get("label") ?? null,
            priority: Number(priorityText),
          });
          const account = await operations.add(input);
          return {
            exitCode: 0,
            stdout: `Added ${account.label} (${account.id}).\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "login-poll") {
          const flags = parseFlags(argv.slice(2), [], ["session"]);
          const input = codexLoginPollInputSchema.parse({
            sessionId: flags.values.get("session"),
          });
          const signal = ctx.signal;
          const cancel = () => codexLogin.cancel(input);
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            if (signal?.aborted) {
              cancel();
              throw signal.reason ?? new Error("Codex login was cancelled.");
            }
            while (true) {
              await wait(
                codexLogin.nextPollDelayMs(input.sessionId),
                undefined,
                { signal },
              );
              const result = await codexLogin.poll(input);
              if (signal?.aborted) {
                throw signal.reason ?? new Error("Codex login was cancelled.");
              }
              if (result.status === "complete") {
                return {
                  exitCode: 0,
                  stdout: `Added ${result.account.label} (${result.account.id}).\n`,
                };
              }
              if (result.status === "error") {
                throw new Error(result.message);
              }
            }
          } catch (error) {
            if (signal?.aborted) codexLogin.cancel(input);
            throw error;
          } finally {
            signal?.removeEventListener("abort", cancel);
          }
        }
        if (argv[0] === "account" && argv[1] === "login-complete") {
          const flags = parseFlags(
            argv.slice(2),
            ["code-stdin"],
            ["session", "code"],
          );
          if (flags.booleans.has("code-stdin")) {
            throw new Error(
              "--code-stdin requires the current bb CLI so it can read stdin safely.",
            );
          }
          const input = loginCompleteInputSchema.parse({
            sessionId: flags.values.get("session"),
            pasted: flags.values.get("code"),
          });
          const account = await login.complete(input);
          return {
            exitCode: 0,
            stdout: `Added ${account.label} (${account.id}).\n`,
          };
        }
        if (argv[0] === "account" && argv[1] === "list") {
          const flags = parseFlags(argv.slice(2), ["json"], []);
          const accounts = await operations.list();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json({ accounts })
              : `${formatAccounts(accounts)}\n`,
          };
        }
        if (
          argv[0] === "account" &&
          ["remove", "enable", "disable"].includes(argv[1] ?? "")
        ) {
          if (argv.length !== 3) throw new Error(HELP);
          const { id } = accountIdInputSchema.parse({ id: argv[2] });
          if (argv[1] === "remove") {
            const removed = await operations.remove(id);
            if (!removed) throw new Error(`Account ${id} does not exist.`);
            return { exitCode: 0, stdout: `Removed ${id}.\n` };
          }
          const account =
            argv[1] === "enable"
              ? await operations.enable(id)
              : await operations.disable(id);
          if (account === null)
            throw new Error(`Account ${id} does not exist.`);
          return {
            exitCode: 0,
            stdout: `${argv[1] === "enable" ? "Enabled" : "Disabled"} ${id}.\n`,
          };
        }
        if (argv[0] === "status") {
          const flags = parseFlags(argv.slice(1), ["json"], []);
          const [poolStatus, routedThreadsWithoutLocalLogin] =
            await Promise.all([
              operations.status(),
              operations.routedThreadsWithoutLocalLogin(),
            ]);
          const status: PoolStatusReport = {
            ...poolStatus,
            routedThreadsWithoutLocalLogin,
          };
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json(status)
              : `${formatStatus(status)}\n${formatAdvisorStatus(advisor.get())}\n${formatWarmingStatusLine(warming.config.get())}\n`,
          };
        }
        if (argv[0] === "routing") {
          const flags = parseFlags(argv.slice(2), ["off"], []);
          const input = routingSetInputSchema.parse({
            provider: argv[1],
            enabled: !flags.booleans.has("off"),
          });
          await operations.setRouting(input.provider, input.enabled);
          return {
            exitCode: 0,
            stdout: `${input.enabled ? "Enabled" : "Disabled"} ${input.provider} Account Pooler routing.\n`,
          };
        }
        if (argv[0] === "config" && argv.length === 1) {
          return { exitCode: 0, stdout: `${formatConfig(config.get())}\n` };
        }
        if (argv[0] === "config" && argv[1] === "set") {
          if (argv.length !== 4) throw new Error(HELP);
          const next = await config.set(parseConfigUpdate(argv[2], argv[3]));
          return { exitCode: 0, stdout: `${formatConfig(next)}\n` };
        }
        if (argv[0] === "advisor" && argv.length === 1) {
          return { exitCode: 0, stdout: `${formatAdvisor(advisor.get())}\n` };
        }
        if (argv[0] === "advisor" && argv[1] === "set") {
          if (argv.length !== 4) throw new Error(HELP);
          const next = await advisor.set(
            parseAdvisorUpdate(argv[2], argv[3]),
          );
          return { exitCode: 0, stdout: `${formatAdvisor(next)}\n` };
        }
        if (argv[0] === "warming" && argv.length === 1) {
          return {
            exitCode: 0,
            stdout: `${formatWarming(warming.config.get())}\n`,
          };
        }
        if (argv[0] === "warming" && argv[1] === "set") {
          if (argv.length !== 4) throw new Error(HELP);
          const next = await warming.config.set(
            parseWarmingUpdate(argv[2] ?? "", argv[3] ?? ""),
          );
          return { exitCode: 0, stdout: `${formatWarming(next)}\n` };
        }
        if (argv[0] === "warming" && argv[1] === "status") {
          const flags = parseFlags(argv.slice(2), ["json"], []);
          const status = warming.status();
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json(status)
              : `${formatWarmingStatus(status)}\n`,
          };
        }
        if (argv[0] === "usage" && argv[1] === "report") {
          const flags = parseFlags(argv.slice(2), ["json"], ["since"]);
          const report = await usage.report(
            parseSince(
              flags.values.get("since") ?? DEFAULT_REPORT_SINCE,
              usage.now(),
            ),
          );
          return {
            exitCode: 0,
            stdout: flags.booleans.has("json")
              ? json(report)
              : `${formatUsageReport(report)}\n`,
          };
        }
        if (argv[0] === "usage" && argv[1] === "retention") {
          if (argv.length === 2)
            return {
              exitCode: 0,
              stdout: `retentionDays: ${usage.retentionDays()}\n`,
            };
          if (argv.length !== 3 || argv[2]?.trim() === "") throw new Error(HELP);
          const days = await usage.setRetentionDays(Number(argv[2]));
          return { exitCode: 0, stdout: `retentionDays: ${days}\n` };
        }
        if (argv[0] === "token" && argv[1] === "rotate") {
          const flags = parseFlags(argv.slice(2), [], ["machine"]);
          const { machine } = tokenRotateInputSchema.parse({
            machine: flags.values.get("machine"),
          });
          const token = await operations.rotateToken(machine);
          return {
            exitCode: 0,
            stdout: `Rotated the Account Pooler token for ${token.hostName ?? token.hostId}.\n`,
          };
        }
        if (argv[0] === "bypass") {
          const threadId = argv[1];
          if (threadId === undefined) throw new Error(HELP);
          const flags = parseFlags(argv.slice(2), ["off"], []);
          const input = bypassInputSchema.parse({
            threadId,
            bypassed: !flags.booleans.has("off"),
          });
          const result = await operations.setBypass(
            input.threadId,
            input.bypassed,
          );
          return {
            exitCode: 0,
            stdout: `${result.bypassed ? "Enabled" : "Disabled"} Account Pooler bypass for ${result.threadId}.\n`,
          };
        }
        throw new Error(HELP);
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
