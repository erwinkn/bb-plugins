import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/components/ui/dropdown-menu";
import { Icon } from "./ui/components/ui/icon";
import { Input } from "./ui/components/ui/input";
import { Switch } from "./ui/components/ui/switch";
import { ConfigFieldRow, SettingsSection } from "./ui/settings-layout";
import {
  advisorConfigSetInputSchema,
  type AdvisorConfigSetInput,
  type AdvisorConfigView,
} from "./src/advisor-config.js";
import type { accountPoolRpcContract } from "./src/rpc.js";
import { ACCOUNT_POOL_CONFIG_CHANGED } from "./src/realtime.js";
import type { WarmingStatus } from "./src/warming.js";
import {
  warmingConfigSetInputSchema,
  warmingFamilySchema,
  type WarmingConfig,
  type WarmingConfigKey,
  type WarmingConfigView,
  type WarmingFamily,
  type WarmingMode,
} from "./src/warming-config.js";

const STATUS_POLL_MS = 10_000;
const RECENT_EVENTS = 20;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueText(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Invalid value.";
}

function clock(value: number | null): string {
  return value === null ? "—" : new Date(value).toLocaleTimeString();
}

// A number field that saves on blur or Enter, validated by the same schema the RPC and CLI use.
// An empty draft means null where the field allows it.
function NumberField({
  label,
  value,
  nullable = false,
  disabled,
  validate,
  onSave,
}: {
  label: string;
  value: number | null;
  nullable?: boolean;
  disabled: boolean;
  validate: (value: number | null) => string | null;
  onSave: (value: number | null) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value === null ? "" : String(value));
  }, [value]);
  async function commit(): Promise<void> {
    const raw = draft.trim();
    const parsed = raw === "" && nullable ? null : Number(raw === "" ? Number.NaN : raw);
    const invalid = validate(parsed);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setError(null);
    if (parsed === value) return;
    setError(await onSave(parsed));
  }
  return (
    <div>
      <Input
        type="number"
        aria-label={label}
        aria-invalid={error === null ? undefined : true}
        disabled={disabled}
        value={draft}
        placeholder={nullable ? "switch threshold" : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {error === null ? null : (
        <p className="mt-1 text-xs text-destructive-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <p className="py-2.5 text-xs text-destructive-text" role="alert">
      {message}
    </p>
  );
}

export function AdvisorRoutesSection() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [view, setView] = useState<AdvisorConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    try {
      setView(await rpc.call("advisor.get", null));
      setError(null);
    } catch (loadError) {
      setError(errorText(loadError));
    }
  }, [rpc]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void load();
  });
  async function save(input: AdvisorConfigSetInput): Promise<string | null> {
    setPending(true);
    try {
      setView(await rpc.call("advisor.set", input));
      return null;
    } catch (saveError) {
      return errorText(saveError);
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsSection
      title="Advisor routes"
      description="Let the Advisor plugin send single review requests through pooled subscription accounts: one vendor request, no retry or failover, and never an account error or hold. Off until you turn a route on."
      action={null}
    >
      <div className="divide-y divide-border">
        {error === null ? null : <SectionError message={error} />}
        {view?.error ? <SectionError message={view.error} /> : null}
        {(["claude", "codex"] as const).map((provider) => (
          <ConfigFieldRow
            key={provider}
            label={provider === "claude" ? "Claude route" : "Codex route"}
            description={
              provider === "claude"
                ? "POST /advisor/v1/messages, token auth."
                : "POST /advisor/v1/responses, token auth."
            }
            error={null}
          >
            <div className="flex justify-end">
              <Switch
                checked={view?.routes[provider] ?? false}
                disabled={view === null || pending}
                aria-label={`Advisor ${provider} route`}
                onCheckedChange={(enabled) =>
                  void save({ routes: { [provider]: enabled } }).then(
                    (message) => setError(message),
                  )
                }
              />
            </div>
          </ConfigFieldRow>
        ))}
        <ConfigFieldRow
          label="Advisor quota reserve"
          description={`Stop picking an account for advisor traffic at this quota fraction. Empty uses the switch threshold; never above it. In effect: ${view?.effectiveMaxUtilization ?? "—"}.`}
          error={null}
        >
          <NumberField
            label="Advisor quota reserve"
            nullable
            value={view?.maxUtilization ?? null}
            disabled={view === null || pending}
            validate={(value) => {
              const result = advisorConfigSetInputSchema.shape.maxUtilization.safeParse(value);
              return result.success ? null : issueText(result.error);
            }}
            onSave={(maxUtilization) => save({ maxUtilization })}
          />
        </ConfigFieldRow>
      </div>
    </SettingsSection>
  );
}

const MODES: Array<{ value: WarmingMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "observe", label: "Observe" },
  { value: "warm", label: "Warm" },
];

const MODE_HINTS: Record<WarmingMode, string> = {
  off: "Nothing is observed or sent, and threads get no extra environment.",
  observe:
    "Records request timing, TTL and cache usage and plans refreshes, but sends nothing.",
  warm: "Re-sends an idle thread's last request with max_tokens 0 on the same account before its cache entry expires.",
};

const WINDOWS: Array<{
  key: WarmingConfigKey;
  label: string;
  description: string;
  inactive?: boolean;
}> = [
  { key: "coordinatorMinutes", label: "Coordinator", description: "Active Initiative coordinators." },
  { key: "workerActiveMinutes", label: "Worker mid-assignment", description: "Workers with an active assignment and no report yet." },
  { key: "workerReportedMinutes", label: "Worker reported", description: "Workers whose report awaits review." },
  { key: "workerAcceptedMinutes", label: "Worker accepted", description: "Workers whose assignment was accepted but who are not retired. Acceptance alone does not end a worker; a short grace is a tradeoff." },
  { key: "reviewerMinutes", label: "Reviewer", description: "Reviewers with an active or reported review assignment. Worker windows never apply to reviewers." },
  { key: "reviewerAcceptedMinutes", label: "Reviewer accepted", description: "Reviewers whose review was accepted but who are not retired. Set apart from the worker grace, so raising that never warms reviewers." },
  { key: "workerEndedMinutes", label: "Ended", description: "Retired, stopped or former members, rejected, cancelled or failed assignments, and workers between assignments." },
  {
    key: "standaloneMinutes",
    label: "Standalone thread",
    description:
      "Inactive: Projects reports standalone, unknown and not-yet-linked threads the same way, so none of them is warmed until a verified way to tell them apart exists.",
    inactive: true,
  },
];

const LIMITS: Array<{ key: WarmingConfigKey; label: string; description: string; nullable?: boolean }> = [
  { key: "safetyMarginSeconds", label: "Safety margin (seconds)", description: "Send a refresh this long before the entry would expire." },
  { key: "maxRefreshesPerLease", label: "Refreshes per idle period", description: "Most refreshes after one native request." },
  { key: "maxRefreshesPerHour", label: "Refreshes per hour", description: "Across all threads." },
  { key: "maxConcurrentRefreshes", label: "Concurrent refreshes", description: "Refreshes in flight at once." },
  { key: "maxLeases", label: "Threads kept warm", description: "Idle threads with a lease at once." },
  { key: "maxLeaseBodyKiB", label: "Request kept per thread (KiB)", description: "Largest request body a lease holds in memory to re-send." },
  { key: "refreshTimeoutSeconds", label: "Refresh timeout (seconds)", description: "Give up on a refresh after this long." },
  { key: "quotaReserve", label: "Warming quota reserve", description: "Stop refreshing on an account at this quota fraction. Empty uses the switch threshold; never above it.", nullable: true },
  { key: "historyLimit", label: "Decisions kept", description: "Recent observations and decisions shown below." },
  { key: "historyMinutes", label: "Decision history (minutes)", description: "Drop recent decisions older than this." },
];

function validateField(key: WarmingConfigKey, value: unknown): string | null {
  const result = warmingConfigSetInputSchema.shape[key].safeParse(value);
  return result.success ? null : issueText(result.error);
}

function WarmingStatusPanel({ status }: { status: WarmingStatus }) {
  const totals = status.totals;
  const events = status.events.slice(-RECENT_EVENTS).reverse();
  return (
    <div className="space-y-3 py-2.5 text-xs">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        {[
          ["Native requests", totals.nativeObserved],
          ["Leases", totals.leasesStarted],
          ["Refreshes sent", totals.refreshesSent],
          ["Confirmed", totals.refreshesConfirmed],
          ["Entry already gone", totals.cacheMisses],
          ["Dry-run refreshes", totals.refreshesPlanned],
          ["Refresh cache reads", totals.refreshCacheReadTokens],
          ["Refresh output tokens", totals.refreshOutputTokens],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-subtle-foreground">{label}</dt>
            <dd className="tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-subtle-foreground">
        Counts requests and tokens since {clock(status.since)}. Subscription
        quota is shown on each account; no dollar estimate is made.
      </p>
      {status.admissions.length === 0 ? null : (
        <p className="text-subtle-foreground">
          {status.admissions.length} finished request
          {status.admissions.length === 1 ? "" : "s"} waiting for a thread link or
          role check; none holds a lease yet.
        </p>
      )}
      {status.leases.length === 0 ? (
        <p className="text-subtle-foreground">No thread is being kept warm.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {status.leases.map((lease) => (
            <li key={lease.sessionId} className="flex flex-wrap gap-x-3 px-2 py-1.5">
              <span className="font-medium text-foreground">
                {lease.threadId ?? "thread not linked yet"}
              </span>
              <span>{lease.model ?? "unknown model"}</span>
              <span>{lease.ttl} entry</span>
              <span>{lease.windowLabel ?? "role not read yet"}</span>
              <span>
                {lease.dryRun ? "dry run, " : ""}
                {lease.refreshes} refresh{lease.refreshes === 1 ? "" : "es"}
              </span>
              <span>covered until {clock(lease.coveredUntil)}</span>
              <span>deadline {clock(lease.deadline)}</span>
              <span>next {clock(lease.nextRefreshAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {events.length === 0 ? null : (
        <ol className="space-y-0.5 text-subtle-foreground" aria-label="Recent warming decisions">
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="break-words">
              <span className="tabular-nums">{clock(event.at)}</span>{" "}
              <span className="text-foreground">{event.threadId ?? "no thread"}</span>{" "}
              {event.message}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function CacheWarmingSection() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [view, setView] = useState<WarmingConfigView | null>(null);
  const [status, setStatus] = useState<WarmingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const loadStatus = useCallback(async () => {
    try {
      const next = await rpc.call("warming.status", null);
      if (mounted.current) setStatus(next);
    } catch {}
  }, [rpc]);
  const load = useCallback(async () => {
    try {
      const next = await rpc.call("warming.get", null);
      if (!mounted.current) return;
      setView(next);
      setError(null);
      await loadStatus();
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [loadStatus, rpc]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void load();
  });
  const mode = view?.config.mode ?? "off";
  useEffect(() => {
    if (mode === "off") return;
    const interval = window.setInterval(() => void loadStatus(), STATUS_POLL_MS);
    return () => window.clearInterval(interval);
  }, [loadStatus, mode]);
  async function save(
    input: Partial<WarmingConfig>,
  ): Promise<string | null> {
    setPending(true);
    try {
      const next = await rpc.call("warming.set", input);
      if (mounted.current) setView(next);
      await loadStatus();
      return null;
    } catch (saveError) {
      return errorText(saveError);
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  const disabled = view === null || pending;
  function toggleFamily(family: WarmingFamily, enabled: boolean): void {
    if (view === null) return;
    const families = warmingFamilySchema.options.filter((candidate) =>
      candidate === family ? enabled : view.config.families.includes(candidate),
    );
    void save({ families }).then((message) => setError(message));
  }
  return (
    <SettingsSection
      title="Cache warming"
      description={`Keep an idle Claude thread's prompt cache alive, timed from its actual requests and cache usage. ${MODE_HINTS[mode]}`}
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" aria-label="Cache warming mode" disabled={disabled}>
              {MODES.find((entry) => entry.value === mode)?.label}
              <Icon name="ChevronDown" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={mode}
              onValueChange={(value) => {
                const parsed = warmingConfigSetInputSchema.shape.mode.safeParse(value);
                if (parsed.success && parsed.data !== undefined)
                  void save({ mode: parsed.data }).then((message) => setError(message));
              }}
            >
              {MODES.map((entry) => (
                <DropdownMenuRadioItem key={entry.value} value={entry.value}>
                  {entry.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <div className="divide-y divide-border">
        {error === null ? null : <SectionError message={error} />}
        {view?.error ? <SectionError message={view.error} /> : null}
        {mode === "off" ? null : (
          <p className="py-2.5 text-xs text-subtle-foreground">
            Requests are matched to threads through BB&apos;s record of each
            thread&apos;s Claude session, refreshed when a thread starts or
            finishes a turn and again right before every refresh. No
            environment variable is added. A thread starting a turn, or any
            request in its session (helpers Claude Code sends after a turn
            included), ends its warming at once. Adhoc threads,
            archived Initiatives, and threads with an undelivered assignment
            are never warmed.
          </p>
        )}
        {WINDOWS.map((window) => (
          <ConfigFieldRow
            key={window.key}
            label={`${window.label} window (minutes)`}
            description={window.description}
            error={null}
          >
            <NumberField
              label={`${window.label} window (minutes)`}
              value={(view?.config[window.key] as number | undefined) ?? null}
              disabled={disabled || window.inactive === true}
              validate={(value) => validateField(window.key, value)}
              onSave={(value) => save({ [window.key]: value })}
            />
          </ConfigFieldRow>
        ))}
        <ConfigFieldRow
          label="Paused Initiatives"
          description="Send no refreshes while a thread's Initiative is paused. Off keeps the role windows through a pause."
          error={null}
        >
          <Switch
            checked={view?.config.pauseStopsWarming ?? true}
            disabled={disabled}
            aria-label="Pause stops warming"
            onCheckedChange={(pauseStopsWarming) =>
              void save({ pauseStopsWarming }).then((message) => setError(message))
            }
          />
        </ConfigFieldRow>
        <ConfigFieldRow
          label="Model families"
          description="A request in these families can start a lease; a request in any family ends one. Removing a family ends its leases at once."
          error={null}
        >
          <div className="flex flex-wrap justify-end gap-3">
            {warmingFamilySchema.options.map((family) => (
              <label key={family} className="flex items-center gap-1.5 text-xs text-foreground">
                <Switch
                  checked={view?.config.families.includes(family) ?? false}
                  disabled={disabled}
                  aria-label={`Warm ${family}`}
                  onCheckedChange={(enabled) => toggleFamily(family, enabled)}
                />
                {family[0]?.toUpperCase()}
                {family.slice(1)}
              </label>
            ))}
          </div>
        </ConfigFieldRow>
        <Collapsible>
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm text-foreground">
            <Icon
              name="ChevronRight"
              className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
            />
            Limits
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y divide-border border-t border-border">
              {LIMITS.map((limit) => (
                <ConfigFieldRow
                  key={limit.key}
                  label={limit.label}
                  description={
                    limit.key === "quotaReserve"
                      ? `${limit.description} In effect: ${view?.effectiveQuotaReserve ?? "—"}.`
                      : limit.description
                  }
                  error={null}
                >
                  <NumberField
                    label={limit.label}
                    nullable={limit.nullable}
                    value={(view?.config[limit.key] as number | null | undefined) ?? null}
                    disabled={disabled}
                    validate={(value) => validateField(limit.key, value)}
                    onSave={(value) => save({ [limit.key]: value })}
                  />
                </ConfigFieldRow>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        {status === null || (mode === "off" && status.events.length === 0) ? null : (
          <div>
            <div className="flex items-center justify-between pt-2.5">
              <span className="text-sm text-foreground">Activity</span>
              <Button size="sm" variant="ghost" onClick={() => void loadStatus()}>
                Update
              </Button>
            </div>
            <WarmingStatusPanel status={status} />
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
