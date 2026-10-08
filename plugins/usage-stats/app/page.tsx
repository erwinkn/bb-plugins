// The Usage page: one row of filters, the headline numbers, cost over time, breakdowns, cache and
// warming, reliability, and each account's quota. Every number below the filters comes from one
// `page` call over the same slice, so they always agree.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { Label, Metrics, OkPage, Page, PageInput, Row } from "../src/model";
import { filterDimensions, hitRate, OTHER_ID, type FilterDimension, type Split } from "../src/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LegendItem, StackedBars, TimeLines, type BarSeries, type Line } from "./charts";
import { bucketLabel, bucketTitle, compact, dateTime, integer, percent, seconds, share } from "./format";

export const PANEL_PATH = "usage";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const PRESETS = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS } as const;
type Preset = keyof typeof PRESETS | "custom";

const SERIES = Array.from({ length: 7 }, (_, index) => `var(--series-${index + 1})`);
const OTHER_COLOR = "var(--series-other)";

const DIMENSION_LABELS: Record<FilterDimension, string> = {
  provider: "Provider",
  model: "Model",
  account: "Account",
  role: "Role",
  project: "Project",
  initiative: "Initiative",
};
const SPLIT_LABELS: Record<Split, string> = {
  type: "Token type",
  model: "Model",
  account: "Account",
  role: "Role",
  provider: "Provider",
};

// --- Range ---

export interface RangeState {
  preset: Preset;
  // Local dates (YYYY-MM-DD), both included, for a custom range.
  customFrom: string;
  customTo: string;
}

// The browser's zone: the server lays hours and days on its calendar.
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function localDate(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function rangeOf(state: RangeState, now: number): { from: number; to: number } {
  if (state.preset !== "custom") {
    // The next whole minute, so a refresh within a minute asks for the same range.
    const to = Math.ceil(now / 60_000) * 60_000;
    return { from: to - PRESETS[state.preset], to };
  }
  // The first instants of the first day and of the day after the last, by the calendar: a day can
  // last 23 or 25 hours, and its midnight can be skipped (it then starts at 01:00).
  const from = new Date(`${state.customFrom}T00:00`).getTime();
  const [year, month, day] = state.customTo.split("-").map(Number);
  const to = new Date(year!, month! - 1, day! + 1).getTime();
  return Number.isNaN(from) || Number.isNaN(to) || from >= to ? { from: now - DAY_MS, to: now } : { from, to: Math.min(to, now + DAY_MS) };
}

// --- Data ---

// While the Account Pooler is still building its rollup, how soon to ask again.
const PENDING_RELOAD_MS = 3_000;

// The page for input, fetched again when input changes, on reload(), and while rows are pending.
function usePage(input: PageInput) {
  const rpc = useRpc<typeof rpcContract>();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloads, setReloads] = useState(0);
  const key = JSON.stringify(input);
  const pending = page?.status === "ok" && page.pendingRows > 0;
  useEffect(() => {
    if (!pending || loading) return;
    const timer = setTimeout(() => setReloads((count) => count + 1), PENDING_RELOAD_MS);
    return () => clearTimeout(timer);
  }, [pending, loading]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc.call("page", input).then(
      (result) => {
        if (cancelled) return;
        setPage(result);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // The input is compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key, reloads]);
  return { page, error, loading, reload: () => setReloads((count) => count + 1) };
}

// --- Controls ---

function Segmented<T extends string>({ value, items, onChange, label }: { value: T; items: Array<{ id: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-8 items-center rounded-md border border-border p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={value === item.id}
          onClick={() => onChange(item.id)}
          className={cn(
            "h-full cursor-pointer rounded-[5px] px-2.5 text-xs transition-colors",
            value === item.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A menu of values with an "all" choice; `defaultLabel` names the unset choice on the button too. */
function Picker({ label, value, options, onChange, allLabel = "All", defaultLabel }: { label: string; value: string | undefined; options: Label[]; onChange: (value: string | undefined) => void; allLabel?: string; defaultLabel?: string }) {
  const selected = value === undefined ? null : (options.find((option) => option.id === value) ?? { id: value, label: value, detail: null });
  const shown = defaultLabel !== undefined ? (selected?.label.toLowerCase() ?? defaultLabel) : (selected?.label ?? null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 max-w-56 cursor-pointer items-center gap-1 rounded-md border px-2.5 text-xs transition-colors",
            selected === null ? "border-border text-muted-foreground hover:text-foreground" : "border-foreground/30 bg-secondary text-foreground",
          )}
        >
          <span className="shrink-0">{label}</span>
          {shown === null ? null : <span className={cn("min-w-0 truncate", selected !== null && "font-medium", selected === null && "text-foreground")}>{shown}</span>}
          <Icon name="ChevronDown" className="size-3.5 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle={label} className="max-h-80 min-w-48 overflow-y-auto">
        <DropdownMenuRadioGroup value={value ?? "\u0000all"} onValueChange={(next) => onChange(next === "\u0000all" ? undefined : next)}>
          <DropdownMenuRadioItem value={"\u0000all"}>{allLabel}</DropdownMenuRadioItem>
          {options.length === 0 ? null : <DropdownMenuSeparator />}
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              <span className="min-w-0 truncate">{option.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Pieces ---

function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-card p-4", className)}>
      {title === undefined && actions === undefined ? null : (
        <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  total,
  onSelect,
  footer,
  className,
}: {
  title: string;
  rows: Row[];
  total: number;
  onSelect?: (row: Row) => void;
  footer?: ReactNode;
  className?: string;
}) {
  const max = Math.max(...rows.map((row) => row.metrics.inputEquivalent), 0);
  return (
    <Card title={title} className={className}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing in this range.</p>
      ) : (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-1.5 font-normal">Name</th>
              <th className="w-16 pb-1.5 text-right font-normal">Requests</th>
              <th className="w-40 pb-1.5 pl-4 font-normal">Cost</th>
              <th className="w-14 pb-1.5 text-right font-normal">Hit rate</th>
              <th className="w-12 pb-1.5 text-right font-normal">Cold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={cn("border-t border-border/60", onSelect !== undefined && "cursor-pointer hover:bg-secondary/60")}
                onClick={onSelect === undefined ? undefined : () => onSelect(row)}
              >
                <td className="py-1.5 pr-2">
                  <div className="truncate text-foreground" title={row.label}>
                    {row.label}
                  </div>
                  {row.detail === null ? null : (
                    <div className="truncate text-[11px] text-muted-foreground" title={row.detail}>
                      {row.detail}
                    </div>
                  )}
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{compact(row.metrics.requests)}</td>
                <td className="py-1.5 pl-4">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-foreground/70" style={{ width: `${max === 0 ? 0 : Math.max(1, (row.metrics.inputEquivalent / max) * 100)}%` }} />
                    </div>
                    <span className="w-12 shrink-0 text-right tabular-nums text-foreground">{compact(row.metrics.inputEquivalent)}</span>
                    <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{share(row.metrics.inputEquivalent, total)}</span>
                  </div>
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{percent(hitRate(row.metrics))}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{row.metrics.coldRewrites === 0 ? "–" : integer(row.metrics.coldRewrites)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {footer}
    </Card>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS: Record<NonNullable<OkPage["quota"][number]["status"]>, { label: string; dot: string }> = {
  ready: { label: "Ready", dot: "bg-success" },
  held: { label: "Held", dot: "bg-warning" },
  exhausted: { label: "Exhausted", dot: "bg-destructive" },
  error: { label: "Error", dot: "bg-destructive" },
  disabled: { label: "Disabled", dot: "border border-muted-foreground" },
};

function windowLabel(name: string): string {
  const [length, family] = name.split(" ");
  return family === undefined ? length! : `${family.charAt(0).toUpperCase()}${family.slice(1)} ${length}`;
}

/** Every local hour (ranges up to two days) or midnight in range, for a time axis to thin. */
function timeAxis(from: number, to: number): Array<{ at: number; label: string }> {
  const hourly = to - from <= 2 * DAY_MS;
  const start = new Date(from);
  if (hourly) start.setMinutes(60, 0, 0);
  else start.setHours(24, 0, 0, 0);
  const axis: Array<{ at: number; label: string }> = [];
  for (const date = start; date.getTime() < to; hourly ? date.setHours(date.getHours() + 1) : date.setDate(date.getDate() + 1))
    axis.push({ at: date.getTime(), label: bucketLabel(date.getTime(), hourly ? "hour" : "day") });
  return axis;
}

function QuotaCard({ account, from, to }: { account: OkPage["quota"][number]; from: number; to: number }) {
  const lines: Line[] = account.windows.map((window, index) => ({
    id: window.name,
    label: windowLabel(window.name),
    color: SERIES[index] ?? OTHER_COLOR,
    points: window.points,
    step: true,
    // What a removed account last showed is not its state now.
    end: account.status === null ? window.points.at(-1)?.[0] : undefined,
  }));
  const markers = account.windows.flatMap((window, index) => window.resets.map((at) => ({ at, color: SERIES[index] ?? OTHER_COLOR })));
  const status = account.status === null ? { label: "Removed", dot: "border border-muted-foreground" } : STATUS[account.status];
  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
          <span className="truncate">{account.label}</span>
        </span>
      }
      actions={
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {account.active ? <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[11px] text-foreground">Active</span> : null}
          {status.label}
        </span>
      }
    >
      {lines.length === 0 ? (
        <p className="text-xs text-muted-foreground">No quota observed in this range.</p>
      ) : (
        <>
          <TimeLines
            from={from}
            to={to}
            lines={lines}
            markers={markers}
            domain={[0, 1]}
            format={(value) => percent(value, 0)}
            timeLabel={dateTime}
            axis={timeAxis(from, to)}
            label={`${account.label} quota utilization`}
          />
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {lines.map((line) => (
              <LegendItem key={line.id} line color={line.color} label={line.label} value={percent(line.points.at(-1)?.[1] ?? null, 0)} />
            ))}
            <span className="text-xs text-muted-foreground">Ticks mark resets.</span>
          </div>
        </>
      )}
    </Card>
  );
}

// --- The page ---

function costSeries(page: OkPage, metric: "cost" | "requests", split: Split, colorOf: (dimension: FilterDimension, id: string) => string): BarSeries[] {
  const buckets = page.series.buckets;
  if (split === "type") {
    const w = page.weights;
    if (metric === "requests")
      return [
        { id: "native", label: "Requests", color: SERIES[0]!, values: buckets.map((bucket) => bucket.metrics.requests - bucket.metrics.refreshes) },
        { id: "refresh", label: "Warming refreshes", color: SERIES[1]!, values: buckets.map((bucket) => bucket.metrics.refreshes) },
      ];
    const types: Array<[string, string, (metrics: Metrics) => number]> = [
      ["input", "Uncached input", (m) => m.input * w.input],
      ["output", "Output", (m) => m.output * w.output],
      ["cacheRead", "Cache read", (m) => m.cacheRead * w.cacheRead],
      ["cacheWrite5m", "Cache write 5m", (m) => m.cacheWrite5m * w.cacheWrite5m],
      ["cacheWrite1h", "Cache write 1h", (m) => m.cacheWrite1h * w.cacheWrite1h],
    ];
    return types.map(([id, label, value], index) => ({ id, label, color: SERIES[index]!, values: buckets.map((bucket) => value(bucket.metrics)) }));
  }
  const values = metric === "cost" ? page.series.cost : page.series.requests;
  return page.series.keys.map((key, index) => ({
    id: key.id,
    label: key.label,
    color: key.id === OTHER_ID ? OTHER_COLOR : colorOf(split, key.id),
    values: values[index] ?? [],
  }));
}

export function UsagePage() {
  const navigate = useBbNavigate();
  const [range, setRange] = useState<RangeState>(() => ({ preset: "7d", customFrom: localDate(Date.now() - 6 * DAY_MS), customTo: localDate(Date.now()) }));
  const [bucket, setBucket] = useState<"hour" | "day">("day");
  const [split, setSplit] = useState<Split>("type");
  const [metric, setMetric] = useState<"cost" | "requests">("cost");
  const [filter, setFilter] = useState<PageInput["filter"]>({});
  const [now, setNow] = useState(() => Date.now());
  const { from, to } = rangeOf(range, now);
  const input: PageInput = { from, to, bucket, timeZone: TIME_ZONE, split, filter };
  const { page, error, loading, reload } = usePage(input);
  const ok = page?.status === "ok" ? page : null;

  // A series keeps its color across filters and splits: slots follow the unfiltered option order.
  const colorOf = useMemo(() => {
    const slots = new Map<string, string>();
    return (dimension: FilterDimension, id: string) => {
      const key = `${dimension}:${id}`;
      const known = slots.get(key);
      if (known !== undefined) return known;
      const position = ok?.options[dimension].findIndex((option) => option.id === id) ?? -1;
      const color = position >= 0 && position < SERIES.length ? SERIES[position]! : OTHER_COLOR;
      slots.set(key, color);
      return color;
    };
  }, [ok?.options]);

  const setPreset = (preset: Preset) => {
    setRange((current) => ({ ...current, preset }));
    if (preset === "24h") setBucket("hour");
    else if (preset !== "custom") setBucket("day");
    setNow(Date.now());
  };
  const select = (dimension: FilterDimension) => (row: Row) => setFilter((current) => ({ ...current, [dimension]: row.id }));

  return (
    <div className="usage-stats h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl space-y-4 px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Range"
            value={range.preset}
            onChange={setPreset}
            items={[
              { id: "24h", label: "24 hours" },
              { id: "7d", label: "7 days" },
              { id: "30d", label: "30 days" },
              { id: "custom", label: "Custom" },
            ]}
          />
          {range.preset === "custom" ? (
            <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground">
              <input type="date" aria-label="From" value={range.customFrom} max={range.customTo} onChange={(event) => setRange((current) => ({ ...current, customFrom: event.target.value }))} className="bg-transparent text-foreground outline-none" />
              <span>–</span>
              <input type="date" aria-label="To" value={range.customTo} min={range.customFrom} onChange={(event) => setRange((current) => ({ ...current, customTo: event.target.value }))} className="bg-transparent text-foreground outline-none" />
            </span>
          ) : null}
          <Segmented label="Resolution" value={bucket} onChange={setBucket} items={[{ id: "hour", label: "Hourly" }, { id: "day", label: "Daily" }]} />
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          {filterDimensions.map((dimension) => (
            <Picker
              key={dimension}
              label={DIMENSION_LABELS[dimension]}
              value={filter[dimension]}
              options={ok?.options[dimension] ?? []}
              onChange={(value) =>
                setFilter((current) => {
                  const next = { ...current };
                  if (value === undefined) delete next[dimension];
                  else next[dimension] = value;
                  return next;
                })
              }
            />
          ))}
          {Object.keys(filter).length === 0 ? null : (
            <Button variant="ghost" size="sm" onClick={() => setFilter({})}>
              Clear filters
            </Button>
          )}
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => {
              setNow(Date.now());
              reload();
            }}
            className="ml-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="RotateCcw" className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")} />
          </button>
        </div>

        {error !== null && page !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {page === null ? (
          error === null ? (
            <Empty>Loading usage…</Empty>
          ) : (
            <Empty>
              <span role="alert">Usage could not be loaded: {error}</span>
            </Empty>
          )
        ) : page.status === "unavailable" ? (
          <Empty>
            Usage statistics come from the Account Pooler's request ledger. {page.reason}
          </Empty>
        ) : (
          <Body page={page} loading={loading} accountWideQuota={Object.keys(filter).some((dimension) => dimension !== "account" && dimension !== "provider")} metric={metric} setMetric={setMetric} split={split} setSplit={setSplit} colorOf={colorOf} select={select} openThread={(threadId) => navigate.toThread(threadId)} />
        )}
      </div>
    </div>
  );
}

function Body({
  page,
  loading,
  accountWideQuota,
  metric,
  setMetric,
  split,
  setSplit,
  colorOf,
  select,
  openThread,
}: {
  page: OkPage;
  loading: boolean;
  // A filter that quota cannot follow (model, role, project, Initiative) is set.
  accountWideQuota: boolean;
  metric: "cost" | "requests";
  setMetric: (metric: "cost" | "requests") => void;
  split: Split;
  setSplit: (split: Split) => void;
  colorOf: (dimension: FilterDimension, id: string) => string;
  select: (dimension: FilterDimension) => (row: Row) => void;
  openThread: (threadId: string) => void;
}) {
  const totals = page.totals;
  const w = page.weights;
  const bucket = page.input.bucket;
  const starts = page.series.buckets.map((item) => item.at);
  const series = costSeries(page, metric, split, colorOf);
  const format = metric === "cost" ? compact : integer;
  const cost = totals.inputEquivalent;
  const warmNet = totals.savedInputEquivalent - totals.refreshInputEquivalent;
  // Where a bucket ends and its middle is: a local day can last 23 or 25 hours.
  const end = (index: number) => starts[index + 1] ?? page.series.end;
  const middle = (index: number) => (starts[index]! + end(index)) / 2;
  const hitLine: Line = {
    id: "hit",
    label: "Cache hit rate",
    color: SERIES[0]!,
    step: false,
    points: page.series.buckets.flatMap((item, index) => {
      const rate = hitRate(item.metrics);
      return rate === null ? [] : [[middle(index), rate] as [number, number]];
    }),
  };
  const lowestHit = Math.min(...hitLine.points.map(([, rate]) => rate), 1);
  const codexWithoutUsage = page.breakdowns.provider.find((row) => row.id === "codex" && row.metrics.withUsage === 0 && row.metrics.requests > 0);
  const unlinked = page.breakdowns.thread.find((row) => row.id === "");
  const initiatives = page.breakdowns.initiative.filter((row) => row.id !== "");

  // The Account Pooler is still building its rollup (a first start): what it has not counted yet
  // may fall in this range. The page asks again until it is done.
  const counting = page.pendingRows === 0 ? null : `Still counting ${integer(page.pendingRows)} requests from the ledger…`;

  if (totals.requests === 0)
    return <Empty>{counting ?? `No requests in this range${page.oldestHour === null ? "" : `. The ledger starts ${dateTime(page.oldestHour)}`}.`}</Empty>;

  return (
    <div className={cn("space-y-4 transition-opacity", loading && "opacity-60")}>
      {counting === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {counting}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Cost" value={compact(cost)} detail="input-equivalent tokens" />
        <Stat label="Requests" value={compact(totals.requests)} detail={`${integer(totals.refreshes)} warming refreshes`} />
        <Stat label="Cache hit rate" value={percent(hitRate(totals))} detail={`${compact(totals.cacheRead)} read · ${compact(totals.cacheWrite5m + totals.cacheWrite1h)} written`} />
        <Stat label="Cold rewrites" value={integer(totals.coldRewrites)} detail={`${compact(totals.coldRewriteTokens)} tokens rewritten`} />
        <Stat label="Warming" value={`${warmNet >= 0 ? "+" : "−"}${compact(Math.abs(warmNet))}`} detail={`net saved · ${integer(totals.rewritesAvoided)} rewrites avoided`} />
        <Stat label="Errors" value={integer(totals.errors)} detail={`${integer(totals.rateLimited)} × 429 · ${integer(totals.overloaded)} × 529`} />
      </div>

      <Card
        title={metric === "cost" ? "Cost over time" : "Requests over time"}
        actions={
          <>
            <Segmented label="Measure" value={metric} onChange={setMetric} items={[{ id: "cost", label: "Cost" }, { id: "requests", label: "Requests" }]} />
            <Picker label="By" value={split === "type" ? undefined : split} allLabel={SPLIT_LABELS.type} defaultLabel={SPLIT_LABELS.type.toLowerCase()} options={(["model", "account", "role", "provider"] as const).map((id) => ({ id, label: SPLIT_LABELS[id], detail: null }))} onChange={(value) => setSplit((value as Split | undefined) ?? "type")} />
          </>
        }
      >
        <StackedBars
          starts={starts}
          series={series}
          format={format}
          labelOf={(at) => bucketLabel(at, bucket)}
          titleOf={(at) => bucketTitle(at, bucket)}
          label={`${metric === "cost" ? "Cost" : "Requests"} per ${bucket}`}
        />
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {series.map((item) => {
            const total = item.values.reduce((sum, value) => sum + value, 0);
            const whole = series.reduce((sum, other) => sum + other.values.reduce((inner, value) => inner + value, 0), 0);
            return total === 0 ? null : <LegendItem key={item.id} color={item.color} label={item.label} value={`${format(total)} · ${share(total, whole)}`} />;
          })}
        </div>
        {hitLine.points.length < 2 ? null : (
          <div className="mt-4 border-t border-border/60 pt-3">
            <div className="mb-1 text-xs text-muted-foreground">Cache hit rate, native Claude prompts</div>
            <TimeLines
              from={starts[0] ?? page.input.from}
              to={page.series.end}
              lines={[hitLine]}
              axis={starts.map((at, index) => ({ at: middle(index), label: bucketLabel(at, bucket) }))}
              domain={[Math.min(0.9, Math.floor(lowestHit * 20) / 20), 1]}
              format={(value) => percent(value, 0)}
              timeLabel={(at) => bucketTitle(starts.filter((start) => start <= at).at(-1) ?? starts[0] ?? at, bucket)}
              height={96}
              label="Cache hit rate over time"
            />
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownTable title="By model" rows={page.breakdowns.model} total={cost} onSelect={select("model")} />
        <BreakdownTable title="By account" rows={page.breakdowns.account} total={cost} onSelect={select("account")} />
        <BreakdownTable title="By role" rows={page.breakdowns.role} total={cost} onSelect={select("role")} />
        <BreakdownTable title="By project" rows={page.breakdowns.project} total={cost} onSelect={select("project")} />
        {initiatives.length === 0 ? null : <BreakdownTable title="By Initiative" rows={page.breakdowns.initiative} total={cost} onSelect={select("initiative")} />}
        {page.breakdowns.provider.length < 2 ? null : <BreakdownTable title="By provider" rows={page.breakdowns.provider} total={cost} onSelect={select("provider")} />}
        <BreakdownTable
          title="Top threads"
          className="lg:col-span-2"
          rows={page.breakdowns.thread}
          total={cost}
          onSelect={(row) => (row.id === "" ? undefined : openThread(row.id))}
          footer={
            <p className="mt-2 text-xs text-muted-foreground">
              {page.breakdowns.threadCount > page.breakdowns.thread.length ? `The ${page.breakdowns.thread.length} costliest of ${page.breakdowns.threadCount} threads. ` : ""}
              {unlinked === undefined ? "" : `${share(unlinked.metrics.inputEquivalent, cost)} of the cost is not linked to a thread. `}
              Open a thread by clicking it.
            </p>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cache and warming">
          <Facts
            items={[
              ["Resumes after the cache entry expired", integer(totals.afterExpiry)],
              ["Cold: the prefix was written again", `${integer(totals.coldRewrites)} · ${compact(totals.coldRewriteTokens)} tokens`],
              ["Kept warm by a refresh", `${integer(totals.rewritesAvoided)} · ${compact(totals.rewriteTokensAvoided)} tokens`],
              ["Warm without a refresh", integer(Math.max(0, totals.afterExpiry - totals.coldRewrites - totals.rewritesAvoided))],
              ["Warming refreshes", `${integer(totals.refreshes)} · cost ${compact(totals.refreshInputEquivalent)}`],
              ["Rewrites they avoided", `saved ${compact(totals.savedInputEquivalent)}`],
              ["Net", `${warmNet >= 0 ? "+" : "−"}${compact(Math.abs(warmNet))}`],
            ]}
          />
        </Card>
        <Card title="Reliability">
          <Facts
            items={[
              ["Requests that failed or never answered", `${integer(totals.errors)} · ${share(totals.errors, totals.requests)}`],
              ["Rate limited (429)", integer(totals.rateLimited)],
              ["Overloaded (529)", integer(totals.overloaded)],
              ["Mean request time", totals.requests === 0 ? "–" : seconds(totals.latencyMs / totals.requests)],
              ["Requests without token counts", `${integer(totals.requests - totals.withUsage)} · ${share(totals.requests - totals.withUsage, totals.requests)}`],
            ]}
          />
          {codexWithoutUsage === undefined ? null : (
            <p className="mt-3 text-xs text-muted-foreground">Codex requests carry no token counts in the ledger, so they count as requests but add no cost.</p>
          )}
        </Card>
      </div>

      {page.quota.length === 0 ? null : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-sm font-medium text-foreground">Quota by account</h2>
            {accountWideQuota ? <span className="text-xs text-muted-foreground">Quota is account-wide: only the provider and account filters narrow it.</span> : null}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {page.quota.map((account) => (
              <QuotaCard key={account.accountId} account={account} from={page.input.from} to={page.input.to} />
            ))}
          </div>
        </div>
      )}

      <footer className="space-y-1 text-xs text-muted-foreground">
        <p>
          Cost counts tokens in input-equivalents, at API price ratios to uncached input: input {w.input}×, cache read {w.cacheRead}×, 5-minute cache write {w.cacheWrite5m}×, 1-hour cache write {w.cacheWrite1h}×, output {w.output}×. It is the closest public proxy for subscription quota, not a bill.
        </p>
        <p>
          From the Account Pooler's request ledger, kept {page.retentionDays} days{page.oldestHour === null ? "" : `; the oldest hour is ${dateTime(page.oldestHour)}`}. Hourly resolution: a range starts at the hour.
        </p>
      </footer>
    </div>
  );
}
