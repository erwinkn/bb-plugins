import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon,
  experimental_useSidebarThreads,
  type ExperimentalSidebarFooterDisclosureProps,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/host-icon";
import { isHostIconName } from "./lib/host-icon-names";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { cn } from "./lib/utils";
import { createUsageStore } from "./usage-store.js";
import { LIST_HOVER_TRANSITION } from "./components/ui/motion";

import {
  providerUsageTone,
  type UsageMachine,
  type UsageProvider,
  type UsageWindow as UsageWindowValue,
} from "./usage-schema.js";

// JSX treats lowercase tags as intrinsic elements, so alias the SDK component.
const ProviderIcon = experimental_ProviderIcon;

const CARD_MAX_AGE_MS = 2 * 60_000;
const FOCUS_MAX_AGE_MS = 5 * 60_000;
const SAFETY_REFRESH_INTERVAL_MS = 30 * 60_000;
let lastMachineId: string | null = null;
let lastProviderIdByMachine = new Map<string, string>();

const { subscribeStore, getStoreSnapshot, refreshUsage } = createUsageStore();

function providerIconStyle(provider: UsageProvider): CSSProperties | undefined {
  if (provider.iconTint === null) return undefined;
  return {
    color:
      "light-dark(" +
      provider.iconTint.light +
      ", " +
      provider.iconTint.dark +
      ")",
  };
}

function ProviderMark({
  provider,
  className,
}: {
  provider: UsageProvider;
  className: string;
}) {
  const tintStyle = providerIconStyle(provider);
  if (provider.logoUrl !== null) {
    const image = 'url("' + provider.logoUrl.replace(/["\\]/gu, "\\$&") + '")';
    return (
      <span
        aria-hidden="true"
        data-provider-logo={provider.logoUrl}
        className={className + " inline-block shrink-0 bg-current"}
        style={{
          ...tintStyle,
          maskImage: image,
          WebkitMaskImage: image,
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
          maskSize: "contain",
          WebkitMaskSize: "contain",
        }}
      />
    );
  }
  const iconName =
    provider.iconGlyph !== null && isHostIconName(provider.iconGlyph)
      ? provider.iconGlyph
      : "Bot";
  return (
    <span aria-hidden="true" style={tintStyle}>
      <Icon name={iconName} fallback="Bot" className={className} />
    </span>
  );
}

function MachineIcon({
  machine,
  className,
}: {
  machine: UsageMachine | null;
  className: string;
}) {
  const machineProvider = machine?.machineProvider ?? null;
  if (machineProvider === null) {
    return (
      <Icon
        name="ComputerTerminal01"
        fallback="Terminal"
        aria-hidden="true"
        className={className}
      />
    );
  }
  return (
    <ProviderIcon
      providerKind="machine"
      provider={{
        id: machineProvider.id,
        logoUrl: machineProvider.logoUrl,
        icon: machineProvider.icon,
      }}
      fallback="ComputerTerminal01"
      aria-hidden="true"
      className={className}
    />
  );
}

function barColorClass(usedPercent: number): string {
  if (usedPercent >= 95) return "bg-destructive";
  if (usedPercent >= 80) return "bg-warning";
  return "bg-primary";
}

function formatReset(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return null;
  const diffMs = reset.getTime() - Date.now();
  if (diffMs <= 0) return "Resetting now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return "Resets in " + minutes + " min";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0
      ? "Resets in " + hours + " hr"
      : "Resets in " + hours + " hr " + remainingMinutes + " min";
  }
  return (
    "Resets " +
    reset.toLocaleString(undefined, {
      weekday: diffMs < 7 * 24 * 60 * 60_000 ? "short" : undefined,
      month: diffMs < 7 * 24 * 60 * 60_000 ? undefined : "short",
      day: diffMs < 7 * 24 * 60 * 60_000 ? undefined : "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  );
}

function formatUsdCents(cents: number, alwaysShowCents: boolean): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: alwaysShowCents || cents % 100 !== 0 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function UsageWindow({ window }: { window: UsageWindowValue }) {
  const reset = formatReset(window.resetsAt);
  const value =
    window.cost === null
      ? Math.round(window.usedPercent) + "% used"
      : formatUsdCents(window.cost.usedUsdCents, true) +
        " / " +
        formatUsdCents(window.cost.limitUsdCents, false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-sidebar-foreground">{window.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {value}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-border">
        <div
          className={"h-full rounded-full " + barColorClass(window.usedPercent)}
          style={{
            width: Math.max(2, Math.min(100, window.usedPercent)) + "%",
          }}
        />
      </div>
      {reset === null ? null : (
        <p className="text-xs tabular-nums text-muted-foreground">{reset}</p>
      )}
    </div>
  );
}

function ProviderUsageBody({ provider }: { provider: UsageProvider }) {
  const usage = provider.usage;
  if (usage === null) {
    return <p className="text-xs text-muted-foreground">Usage not reported.</p>;
  }
  switch (usage.status) {
    case "ok":
      return usage.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No usage limits reported for this plan.
        </p>
      ) : (
        <div className="space-y-3">
          {usage.windows.map((window) => (
            <UsageWindow key={window.label} window={window} />
          ))}
        </div>
      );
    case "not_installed":
      return (
        <p className="text-xs text-muted-foreground">
          Not installed on this machine.
        </p>
      );
    case "unauthenticated":
      return (
        <p className="text-xs text-muted-foreground">{provider.signInHint}</p>
      );
    case "expired":
      return (
        <p className="text-xs text-muted-foreground">{provider.expiredHint}</p>
      );
    case "error":
      return <p className="text-xs text-muted-foreground">{usage.message}</p>;
  }
}

function MachineSelector({
  machines,
  activeMachine,
  onOpenChange,
  onSelect,
}: {
  machines: UsageMachine[];
  activeMachine: UsageMachine | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (machineId: string) => void;
}) {
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={machines.length === 0}>
        <button
          type="button"
          aria-label={
            activeMachine === null
              ? "Usage machine"
              : "Usage machine: " + activeMachine.displayName
          }
          title={activeMachine?.displayName ?? "No machines"}
          disabled={machines.length === 0}
          className={cn(
            LIST_HOVER_TRANSITION,
            "flex size-8 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50",
          )}
        >
          <MachineIcon machine={activeMachine} className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        mobileTitle="Usage machine"
        className="max-h-72 max-w-72 overflow-y-auto"
      >
        {machines.map((machine) => {
          const isActive = machine.id === activeMachine?.id;
          return (
            <DropdownMenuItem
              key={machine.id}
              role="menuitemradio"
              aria-label={machine.displayName}
              aria-checked={isActive}
              onSelect={() => onSelect(machine.id)}
              className={cn(
                "flex items-center justify-between gap-3",
                LIST_HOVER_TRANSITION,
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <MachineIcon
                  machine={machine}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    machine.status === "connected"
                      ? "bg-success"
                      : "border border-muted-foreground",
                  )}
                />
                <span className="min-w-0 truncate">{machine.displayName}</span>
                {machine.status === "disconnected" ? (
                  <span className="shrink-0 text-muted-foreground">
                    Offline
                  </span>
                ) : null}
              </span>
              <Icon
                name="Check"
                fallback="CircleCheck"
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderUsageStatus({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const machineMenuOpen = useRef(false);
  const onMachineMenuOpenChange = useCallback((open: boolean) => {
    machineMenuOpen.current = open;
  }, []);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      // The nested menu owns dismissal until its drawer or popover closes.
      if (machineMenuOpen.current) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cardRef.current?.contains(target)) return;
      // Let the host footer button toggle its own disclosure on click.
      const control = target instanceof Element ? target.closest("[aria-controls]") : null;
      const controlledId = control?.getAttribute("aria-controls");
      if (controlledId && cardRef.current && document.getElementById(controlledId)?.contains(cardRef.current)) return;
      dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [dismiss]);
  const snapshot = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot,
  );
  const machines = snapshot.data?.machines ?? [];
  const { threadId } = useBbContext();
  const sidebarThreads = experimental_useSidebarThreads();
  const threadMachineId = useMemo(
    () =>
      sidebarThreads.threads.find((thread) => thread.id === threadId)?.host
        ?.id ?? null,
    [sidebarThreads.threads, threadId],
  );
  const [requestedMachineId, setRequestedMachineId] = useState<string | null>(
    lastMachineId,
  );
  const [requestedProviderIds, setRequestedProviderIds] = useState(
    lastProviderIdByMachine,
  );
  const activeMachine =
    machines.find((machine) => machine.id === requestedMachineId) ??
    machines.find((machine) => machine.id === threadMachineId) ??
    machines.find((machine) => machine.status === "connected") ??
    machines[0] ??
    null;
  const providers = activeMachine?.providers ?? [];
  const requestedProviderId =
    activeMachine === null
      ? null
      : (requestedProviderIds.get(activeMachine.id) ?? null);
  const activeProvider =
    providers.find((provider) => provider.id === requestedProviderId) ??
    providers[0] ??
    null;
  const panelId = useId();
  const activeMachineId = activeMachine?.id ?? null;

  useEffect(() => {
    const controller = new AbortController();
    void refreshUsage({
      force: false,
      machineIds: activeMachineId === null ? null : [activeMachineId],
      maxAgeMs: CARD_MAX_AGE_MS,
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [activeMachineId]);

  const selectMachine = useCallback((machineId: string) => {
    lastMachineId = machineId;
    setRequestedMachineId(machineId);
  }, []);

  const selectProvider = useCallback(
    (providerId: string) => {
      if (activeMachine === null) return;
      setRequestedProviderIds((current) => {
        const next = new Map(current);
        next.set(activeMachine.id, providerId);
        lastProviderIdByMachine = next;
        return next;
      });
    },
    [activeMachine],
  );

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % providers.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + providers.length) % providers.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = providers.length - 1;
    } else {
      return;
    }
    const nextProvider = providers[nextIndex];
    if (nextProvider === undefined) return;
    event.preventDefault();
    selectProvider(nextProvider.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(nextIndex)
      .focus();
  };

  return (
    <div ref={cardRef}>
      <div
        data-provider-usage-header=""
        className="flex min-w-0 items-start gap-1 border-b border-sidebar-border p-1.5"
      >
        {providers.length === 0 ? (
          <div className="min-w-0 flex-1" />
        ) : (
          <div
            role="tablist"
            aria-label="Usage provider"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5"
          >
            {providers.map((provider, index) => {
              const isActive = provider.id === activeProvider?.id;
              const tone = providerUsageTone(provider);
              return (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  title={provider.displayName}
                  aria-label={provider.displayName}
                  aria-selected={isActive}
                  aria-controls={panelId}
                  tabIndex={isActive ? 0 : -1}
                  className={cn(
                    "relative flex size-8 shrink-0 items-center justify-center border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring",
                    isActive
                      ? "border-sidebar-foreground text-sidebar-foreground"
                      : "border-transparent text-muted-foreground hover:text-sidebar-foreground",
                  )}
                  onClick={() => selectProvider(provider.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <ProviderMark provider={provider} className="size-4" />
                  {tone === null ? null : (
                    <span
                      aria-hidden="true"
                      data-provider-usage-tone={tone}
                      className={cn(
                        "absolute right-1 top-1.5 size-1.5 rounded-full ring-2 ring-sidebar-accent",
                        tone === "critical" ? "bg-destructive" : "bg-warning",
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
        <MachineSelector
          machines={machines}
          onOpenChange={onMachineMenuOpenChange}
          activeMachine={activeMachine}
          onSelect={selectMachine}
        />
        <button
          type="button"
          aria-label="Reload provider usage"
          title="Refresh usage"
          disabled={snapshot.isRefreshing}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
          onClick={() =>
            void refreshUsage({
              force: true,
              machineIds: activeMachineId === null ? null : [activeMachineId],
              maxAgeMs: 0,
            })
          }
        >
          <Icon
            name="RotateCcw"
            fallback="ArrowReloadHorizontal"
            aria-hidden="true"
            className={
              "size-4 " + (snapshot.isRefreshing ? "animate-spin motion-reduce:animate-none" : "")
            }
          />
        </button>

      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-label={
          activeMachine === null || activeProvider === null
            ? "Provider usage"
            : activeMachine.displayName +
              " " +
              activeProvider.displayName +
              " usage"
        }
        className="p-2.5"
      >
        {activeMachine === null ? (
          <p className="text-xs text-muted-foreground">
            {snapshot.error ??
              (snapshot.isRefreshing
                ? "Loading provider usage…"
                : "No machines are enrolled.")}
          </p>
        ) : activeProvider === null ? (
          <p className="text-xs text-muted-foreground">
            {activeMachine.status === "disconnected"
              ? activeMachine.displayName +
                " is offline. Usage will refresh when it reconnects."
              : (activeMachine.error ??
                "No providers report usage limits on this machine.")}
          </p>
        ) : (
          <>
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-xs font-medium text-sidebar-foreground">
                  {activeProvider.displayName}
                </h2>
                {activeProvider.usage?.status === "ok" &&
                activeProvider.usage.accountEmail !== null ? (
                  <p
                    title={activeProvider.usage.accountEmail}
                    className="truncate text-2xs text-subtle-foreground"
                  >
                    {activeProvider.usage.accountEmail}
                  </p>
                ) : null}
              </div>
              {activeProvider.usage?.status === "ok" &&
              activeProvider.usage.planLabel !== null ? (
                <span className="ml-auto shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-subtle-foreground">
                  {activeProvider.usage.planLabel}
                </span>
              ) : null}
            </div>
            <div className="mt-2.5">
              {activeMachine.status === "disconnected" ? (
                <p className="text-xs text-muted-foreground">
                  {activeMachine.displayName} is offline. Usage will refresh
                  when it reconnects.
                </p>
              ) : activeMachine.error === null ? (
                <ProviderUsageBody provider={activeProvider} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {activeMachine.error}
                </p>
              )}
            </div>
            {snapshot.error === null ? null : (
              <p role="status" className="mt-2 text-xs text-warning-text">
                Showing the last update. {snapshot.error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "usage",
    label: "Provider usage",
    icon: "ChartColumn",
    component: ProviderUsageStatus,
  });
  app.contentScripts.register({
    id: "refresh-usage",
    mount({ signal }) {
      let timer: number | null = null;
      let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
      let blurredAt: number | null = null;
      const scheduleSafetyRefresh = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (signal.aborted || document.visibilityState !== "visible") return;
        timer = window.setTimeout(runSafetyRefresh, SAFETY_REFRESH_INTERVAL_MS);
      };
      const reconcile = (maxAgeMs: number, machineIds: string[] | null) => {
        void refreshUsage({
          force: false,
          machineIds,
          maxAgeMs,
          signal,
        });
      };
      const runSafetyRefresh = () => {
        if (document.visibilityState === "visible") {
          reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onActive = () => {
        const inactiveAt =
          hiddenAt === null
            ? blurredAt
            : blurredAt === null
              ? hiddenAt
              : Math.min(hiddenAt, blurredAt);
        hiddenAt = null;
        blurredAt = null;
        if (
          inactiveAt !== null &&
          Date.now() - inactiveAt >= FOCUS_MAX_AGE_MS
        ) {
          reconcile(FOCUS_MAX_AGE_MS, null);
        }
        scheduleSafetyRefresh();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          hiddenAt ??= Date.now();
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
          return;
        }
        onActive();
      };
      const onBlur = () => {
        blurredAt ??= Date.now();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("blur", onBlur);
      window.addEventListener("focus", onActive);
      reconcile(SAFETY_REFRESH_INTERVAL_MS, null);
      scheduleSafetyRefresh();
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("focus", onActive);
      };
    },
  });
});
