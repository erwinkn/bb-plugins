import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { HistoryPoint, LoadSettings, Machine, ProcessSummary, Sample } from "../lib/contract.js";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatUptime,
  formatUsedOfTotal,
  percentOf,
  toneFor,
  type Tone,
} from "../lib/format.js";
import type { LoadStore } from "../lib/load-store.js";
import { cn } from "../lib/utils.js";
import { Icon } from "./host-icon";
import { Sparkline } from "./sparkline.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { LIST_HOVER_TRANSITION } from "./ui/motion";

const BAR_CLASS: Record<Tone, string> = {
  normal: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
};

const TEXT_CLASS: Record<Tone, string> = {
  normal: "text-primary",
  warning: "text-warning",
  critical: "text-destructive",
};

const VALUE_CLASS: Record<Tone, string> = {
  normal: "text-muted-foreground",
  warning: "text-warning-text",
  critical: "text-destructive",
};

function Row({ label, value, tone = "normal", title }: { label: ReactNode; value: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs" title={title}>
      <span className="min-w-0 truncate text-sidebar-foreground">{label}</span>
      <span className={cn("shrink-0 tabular-nums", VALUE_CLASS[tone])}>{value}</span>
    </div>
  );
}

/** Several values in one row, spaced apart. */
function Spaced({ parts }: { parts: string[] }) {
  return (
    <span className="inline-flex gap-2">
      {parts.map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </span>
  );
}

function Bar({ percent, tone }: { percent: number | null; tone: Tone }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-border">
      {percent === null ? null : (
        <div
          className={cn("h-full rounded-full", BAR_CLASS[tone])}
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      )}
    </div>
  );
}

function CoreGrid({ cores, settings }: { cores: number[]; settings: LoadSettings }) {
  const columns = Math.min(cores.length, 24);
  return (
    <div
      aria-hidden="true"
      data-core-grid=""
      className="grid gap-px"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {cores.map((percent, index) => {
        const tone = toneFor(percent, settings);
        return (
          <div
            key={index}
            title={`CPU ${index}: ${Math.round(percent)}%`}
            className="h-1.5 rounded-[1px] bg-sidebar-border"
          >
            <div
              className={cn("size-full rounded-[1px]", BAR_CLASS[tone])}
              style={{ opacity: tone === "normal" ? Math.max(0.06, percent / 100) : 1 }}
            />
          </div>
        );
      })}
    </div>
  );
}

function MachinePicker({
  machines,
  active,
  onSelect,
  onOpenChange,
}: {
  machines: Machine[];
  active: Machine | null;
  onSelect: (machineId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const label = active?.name ?? "No machine";
  const triggerClass =
    "flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground";
  if (machines.length <= 1) {
    return (
      <div className={triggerClass} title={label}>
        <Icon name="ComputerTerminal01" fallback="Terminal" aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
    );
  }
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Machine: ${label}`}
          title={label}
          className={cn(
            triggerClass,
            LIST_HOVER_TRANSITION,
            "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          )}
        >
          <Icon name="ComputerTerminal01" fallback="Terminal" aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{label}</span>
          <Icon name="ChevronDown" aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle="Machine" className="max-h-72 max-w-72 overflow-y-auto">
        {machines.map((machine) => {
          const isActive = machine.id === active?.id;
          return (
            <DropdownMenuItem
              key={machine.id}
              role="menuitemradio"
              aria-checked={isActive}
              onSelect={() => onSelect(machine.id)}
              className={cn("flex items-center justify-between gap-3", LIST_HOVER_TRANSITION)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    machine.connected ? "bg-success" : "border border-muted-foreground",
                  )}
                />
                <span className="min-w-0 truncate">{machine.name}</span>
                {machine.primary ? <span className="shrink-0 text-muted-foreground">BB server</span> : null}
                {machine.connected ? null : <span className="shrink-0 text-muted-foreground">Offline</span>}
              </span>
              <Icon
                name="Check"
                fallback="CircleCheck"
                aria-hidden="true"
                className={cn("size-3.5 shrink-0", isActive ? "opacity-100" : "opacity-0")}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SparkMetric({
  label,
  value,
  percent,
  history,
  pick,
  settings,
  children,
}: {
  label: string;
  value: string;
  percent: number | null;
  history: HistoryPoint[];
  pick: (point: HistoryPoint) => number | null;
  settings: LoadSettings;
  children?: ReactNode;
}) {
  const tone = toneFor(percent, settings);
  return (
    <section className="space-y-1.5">
      <Row label={label} value={value} tone={tone} />
      <Sparkline
        label={`${label} over the last ${historySpan(history)}`}
        points={history.map((point) => ({ t: point.t, value: pick(point) }))}
        intervalMs={settings.refreshMs}
        className={cn("block w-full", TEXT_CLASS[tone])}
      />
      {children}
    </section>
  );
}

function historySpan(history: HistoryPoint[]): string {
  const first = history[0];
  const last = history.at(-1);
  if (first === undefined || last === undefined) return "moment";
  const minutes = Math.max(1, Math.round((last.t - first.t) / 60_000));
  return `${minutes} min`;
}

function ProcessList({ processes, kind }: { processes: NonNullable<Sample["processes"]>; kind: "cpu" | "memory" }) {
  const rows: ProcessSummary[] = kind === "cpu" ? processes.byCpu : processes.byMemory;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Measuring…</p>;
  }
  return (
    <ol className="space-y-1">
      {rows.map((row) => (
        <li key={row.pid}>
          <Row
            title={`${row.command}\npid ${row.pid}`}
            label={row.name}
            value={kind === "cpu" ? formatPercent(row.cpuPercent) : formatBytes(row.memoryBytes)}
          />
        </li>
      ))}
    </ol>
  );
}

function SectionHeading({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">{children}</h3>
      {trailing}
    </div>
  );
}

function LoadDetails({ sample, history, settings }: { sample: Sample; history: HistoryPoint[]; settings: LoadSettings }) {
  const [processKind, setProcessKind] = useState<"cpu" | "memory">("cpu");
  const memory = sample.memory;
  const memoryUsed = memory.totalBytes - memory.availableBytes;
  const memoryPercent = percentOf(memoryUsed, memory.totalBytes);
  const swapPercent = percentOf(memory.swapUsedBytes, memory.swapTotalBytes);
  const loadPercent = sample.load === null ? null : (sample.load[0] / sample.cpu.count) * 100;
  const loadTone = toneFor(loadPercent, settings);
  return (
    <div className="space-y-3">
      <SparkMetric
        label="CPU"
        value={formatPercent(sample.cpu.percent)}
        percent={sample.cpu.percent}
        history={history}
        pick={(point) => point.cpu}
        settings={settings}
      >
        {sample.cpu.cores === null || sample.cpu.cores.length < 2 ? null : (
          <CoreGrid cores={sample.cpu.cores} settings={settings} />
        )}
      </SparkMetric>
      <SparkMetric
        label="Memory"
        value={formatUsedOfTotal(memoryUsed, memory.totalBytes)}
        percent={memoryPercent}
        history={history}
        pick={(point) => point.memory}
        settings={settings}
      >
        {memory.swapTotalBytes === 0 ? null : (
          <Row
            label={<span className="text-muted-foreground">Swap</span>}
            value={formatUsedOfTotal(memory.swapUsedBytes, memory.swapTotalBytes)}
            tone={toneFor(swapPercent, settings)}
          />
        )}
      </SparkMetric>
      {sample.load === null ? null : (
        <section className="space-y-1.5">
          <Row
            label="Load"
            title="1, 5, and 15 minute load averages"
            value={<Spaced parts={[...sample.load.map((value) => value.toFixed(2)), `/ ${sample.cpu.count}`]} />}
            tone={loadTone}
          />
          <Bar percent={loadPercent} tone={loadTone} />
        </section>
      )}
      {sample.disks.length === 0 ? null : (
        <section className="space-y-2">
          <SectionHeading>Disks</SectionHeading>
          {sample.disks.map((disk) => {
            const percent = percentOf(disk.usedBytes, disk.usedBytes + disk.availableBytes);
            const tone = toneFor(percent, settings);
            return (
              <div key={disk.mountPoint} className="space-y-1.5">
                <Row
                  label={disk.mountPoint}
                  title={`${disk.device} · ${disk.fsType} · ${formatBytes(disk.availableBytes)} free`}
                  value={formatUsedOfTotal(disk.usedBytes, disk.totalBytes)}
                  tone={tone}
                />
                <Bar percent={percent} tone={tone} />
              </div>
            );
          })}
        </section>
      )}
      {sample.io.diskReadBps === null && sample.io.netReceiveBps === null ? null : (
        <section className="space-y-1">
          <SectionHeading>Throughput</SectionHeading>
          <Row
            label="Disk"
            title="Read and written by the mounted disks"
            value={<Spaced parts={[`↓ ${formatRate(sample.io.diskReadBps)}`, `↑ ${formatRate(sample.io.diskWriteBps)}`]} />}
          />
          <Row
            label="Network"
            title="Received and sent by physical interfaces"
            value={<Spaced parts={[`↓ ${formatRate(sample.io.netReceiveBps)}`, `↑ ${formatRate(sample.io.netSendBps)}`]} />}
          />
        </section>
      )}
      {sample.processes === null ? null : (
        <section className="space-y-1.5">
          <SectionHeading
            trailing={
              <div role="tablist" aria-label="Sort processes by" className="flex gap-0.5">
                {(["cpu", "memory"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="tab"
                    aria-selected={processKind === kind}
                    onClick={() => setProcessKind(kind)}
                    className={cn(
                      "rounded-sm px-1.5 py-0.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                      processKind === kind
                        ? "bg-sidebar-border/60 text-sidebar-foreground"
                        : "text-muted-foreground hover:text-sidebar-foreground",
                    )}
                  >
                    {kind === "cpu" ? "CPU" : "Memory"}
                  </button>
                ))}
              </div>
            }
          >
            Top processes
          </SectionHeading>
          <ProcessList processes={sample.processes} kind={processKind} />
        </section>
      )}
    </div>
  );
}

export function createLoadPanel(store: LoadStore) {
  return function MachineLoadPanel({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
    const cardRef = useRef<HTMLDivElement>(null);
    const machineMenuOpen = useRef(false);
    const onMachineMenuOpenChange = useCallback((open: boolean) => {
      machineMenuOpen.current = open;
    }, []);
    useEffect(() => store.openDetail(), []);
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
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const result = snapshot.result;
    const machines = result?.machines ?? [];
    const active = machines.find((machine) => machine.id === result?.machineId) ?? null;
    const sample = result?.sample ?? null;
    const subtitle =
      sample === null
        ? null
        : [`${sample.cpu.count} ${sample.cpu.count === 1 ? "core" : "cores"}`, formatUptime(sample.uptimeSeconds)]
            .filter((part) => part !== null)
            .join(" · ");
    const message = snapshot.error ?? result?.error ?? null;
    return (
      <div ref={cardRef} data-machine-load-panel="">
        <div className="flex min-w-0 items-center gap-1 border-b border-sidebar-border p-1.5">
          <MachinePicker
            machines={machines}
            active={active}
            onSelect={store.selectMachine}
            onOpenChange={onMachineMenuOpenChange}
          />
          {subtitle === null ? null : (
            <span className="ml-auto shrink-0 pr-1.5 text-2xs tabular-nums text-subtle-foreground">{subtitle}</span>
          )}
        </div>
        <div className="max-h-[min(36rem,70dvh)] overflow-y-auto p-2.5">
          {result === null || sample === null ? (
            <p className="text-xs text-muted-foreground">{message ?? "Reading machine load…"}</p>
          ) : (
            <>
              <LoadDetails sample={sample} history={snapshot.history} settings={result.settings} />
              {message === null ? null : (
                <p role="status" className="mt-2 text-xs text-warning-text">
                  Showing the last reading. {message}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    );
  };
}
