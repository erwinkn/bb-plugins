// Two small SVG charts, no charting library: stacked columns over time buckets, and lines over
// continuous time (step lines for quota, a plain line for rates). Marks follow the dataviz specs:
// columns at most 24 px wide with a 2 px gap and a 4 px rounded top, 2 px lines, hairline grid,
// one y-axis, a tooltip on hover and on arrow keys.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface BarSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
}

export interface Line {
  id: string;
  label: string;
  color: string;
  points: Array<[number, number]>;
  // A step line holds each value until the next point, and its last one until `end` (the end of
  // the range by default); a plain line joins them.
  step: boolean;
  end?: number;
}

const MARGIN = { top: 8, right: 8, bottom: 22, left: 44 };
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round tick values from 0 (or min) to at least max. */
export function ticks(min: number, max: number, count = 4): number[] {
  const span = Math.max(max - min, Number.EPSILON);
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw)!;
  const result: number[] = [];
  for (let value = Math.floor(min / step) * step; value < max + step / 2; value += step)
    result.push(Number(value.toFixed(10)));
  return result;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const right = x > width * 0.6;
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
      style={right ? { right: width - x + 12 } : { left: x + 12 }}
    >
      {children}
    </div>
  );
}

export function TooltipRow({ color, value, label, line = false }: { color: string | null; value: string; label: string; line?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      {color === null ? (
        <span className="w-3" />
      ) : (
        <span
          aria-hidden="true"
          className={cn("shrink-0", line ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]")}
          style={{ background: color }}
        />
      )}
      <span className="font-medium tabular-nums text-foreground">{value}</span>
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
    </div>
  );
}

function YAxis({ values, y, width, format }: { values: number[]; y: (value: number) => number; width: number; format: (value: number) => string }) {
  return (
    <g>
      {values.map((value) => (
        <g key={value}>
          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" />
          <text x={MARGIN.left - 6} y={y(value)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
            {format(value)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Label every nth column so labels stay about 56 px apart. */
function labelStride(plotWidth: number, columns: number): number {
  return Math.max(1, Math.ceil(56 / Math.max(plotWidth / Math.max(columns, 1), 1)));
}

/** A path for a column whose top corners are rounded. */
function roundedTop(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

export function StackedBars({
  starts,
  labelOf,
  titleOf,
  series,
  format,
  height = 200,
  label,
}: {
  starts: number[];
  labelOf: (at: number) => string;
  titleOf: (at: number) => string;
  series: BarSeries[];
  format: (value: number) => string;
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth();
  const [hovered, setHovered] = useState<number | null>(null);
  const totals = starts.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
  const yTicks = ticks(0, Math.max(...totals, 0) || 1);
  const yMax = yTicks.at(-1)!;
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotBottom = height - MARGIN.bottom;
  const y = (value: number) => plotBottom - (value / yMax) * (plotBottom - MARGIN.top);
  const band = starts.length === 0 ? 0 : plotWidth / starts.length;
  const barWidth = Math.max(1, Math.min(BAR_MAX, band - GAP));
  const labelEvery = labelStride(plotWidth, starts.length);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setHovered((current) => Math.min(starts.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : starts.length)) + step)));
  };
  return (
    <div
      ref={ref}
      className="relative outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={label}
      onKeyDown={onKeyDown}
      onBlur={() => setHovered(null)}
    >
      {width === 0 ? null : (
        <svg width={width} height={height} className="block overflow-visible">
          <YAxis values={yTicks} y={y} width={width} format={format} />
          {starts.map((at, index) => {
            const center = MARGIN.left + band * index + band / 2;
            const x = center - barWidth / 2;
            let base = 0;
            const segments = series.flatMap((item) => {
              const value = item.values[index] ?? 0;
              if (value <= 0) return [];
              const segment = { item, from: base, to: base + value };
              base += value;
              return [segment];
            });
            return (
              <g key={at} opacity={hovered === null || hovered === index ? 1 : 0.55}>
                {segments.map((segment, position) => {
                  const top = y(segment.to);
                  // A 2 px gap above every segment but the top one.
                  const bottom = y(segment.from) - (position === 0 ? 0 : GAP);
                  const segmentHeight = Math.max(0, bottom - top);
                  if (segmentHeight <= 0) return null;
                  return position === segments.length - 1 ? (
                    <path key={segment.item.id} d={roundedTop(x, top, barWidth, segmentHeight)} fill={segment.item.color} />
                  ) : (
                    <rect key={segment.item.id} x={x} y={top} width={barWidth} height={segmentHeight} fill={segment.item.color} />
                  );
                })}
                {index % labelEvery === 0 ? (
                  <text x={center} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">
                    {labelOf(at)}
                  </text>
                ) : null}
                <rect
                  x={MARGIN.left + band * index}
                  y={MARGIN.top}
                  width={band}
                  height={plotBottom - MARGIN.top}
                  fill="transparent"
                  onPointerEnter={() => setHovered(index)}
                  onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
                />
              </g>
            );
          })}
          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={plotBottom} y2={plotBottom} stroke="var(--chart-axis)" />
        </svg>
      )}
      {hovered === null || starts[hovered] === undefined ? null : (
        <Tooltip x={MARGIN.left + band * hovered + band / 2} width={width}>
          <div className="mb-1 font-medium text-foreground">{titleOf(starts[hovered]!)}</div>
          {[...series].reverse().map((item) =>
            (item.values[hovered] ?? 0) > 0 ? (
              <TooltipRow key={item.id} color={item.color} value={format(item.values[hovered] ?? 0)} label={item.label} />
            ) : null,
          )}
          {series.length > 1 ? <TooltipRow color={null} value={format(totals[hovered] ?? 0)} label="Total" /> : null}
        </Tooltip>
      )}
    </div>
  );
}

/** The value of a line at time t: the last point at or before it (step), or the nearest point. */
function valueAt(line: Line, at: number): number | null {
  if (line.points.length === 0) return null;
  if (line.step) {
    let value: number | null = null;
    for (const [time, point] of line.points) {
      if (time > at) break;
      value = point;
    }
    return value;
  }
  let best = line.points[0]!;
  for (const point of line.points) if (Math.abs(point[0] - at) < Math.abs(best[0] - at)) best = point;
  return best[1];
}

export function TimeLines({
  from,
  to,
  lines,
  markers = [],
  domain,
  format,
  timeLabel,
  axis,
  height = 120,
  label,
}: {
  from: number;
  to: number;
  lines: Line[];
  // Short ticks at the top edge in a line's color, e.g. its resets.
  markers?: Array<{ at: number; color: string }>;
  domain: [number, number];
  format: (value: number) => string;
  timeLabel: (at: number) => string;
  // One label per column of a column chart above, thinned the same way; five evenly spaced
  // times by default.
  axis?: Array<{ at: number; label: string }>;
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth();
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotBottom = height - MARGIN.bottom;
  const x = (at: number) => MARGIN.left + ((at - from) / (to - from)) * plotWidth;
  const y = (value: number) => plotBottom - ((value - domain[0]) / (domain[1] - domain[0])) * (plotBottom - MARGIN.top);
  const yTicks = ticks(domain[0], domain[1], 2).filter((value) => value >= domain[0] - 1e-9 && value <= domain[1] + 1e-9);
  const stride = axis === undefined ? 1 : labelStride(plotWidth, axis.length);
  const xTicks = axis?.filter((_, index) => index % stride === 0) ?? Array.from({ length: 5 }, (_, index) => {
    const at = from + ((to - from) * index) / 4;
    return { at, label: timeLabel(at) };
  });
  const path = (line: Line) => {
    let d = "";
    line.points.forEach(([time, value], index) => {
      const px = x(Math.max(from, time));
      const py = y(value);
      if (index === 0) d += `M${px},${py}`;
      else d += line.step ? `H${px}V${py}` : `L${px},${py}`;
    });
    // A step line holds its last value until the end of the range.
    const last = line.points.at(-1);
    if (line.step && last !== undefined) d += `H${x(Math.min(to, Math.max(last[0], line.end ?? to)))}`;
    return d;
  };
  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setHoverAt(from + ratio * (to - from));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = ((to - from) / 48) * (event.key === "ArrowLeft" ? -1 : 1);
    setHoverAt((current) => Math.min(to, Math.max(from, (current ?? (step > 0 ? from : to)) + step)));
  };
  return (
    <div
      ref={ref}
      className="relative outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={label}
      onKeyDown={onKeyDown}
      onBlur={() => setHoverAt(null)}
    >
      {width === 0 ? null : (
        <svg width={width} height={height} className="block overflow-visible">
          <YAxis values={yTicks} y={y} width={width} format={format} />
          {markers.map((marker) => (
            <rect key={`${marker.color}${marker.at}`} x={x(marker.at) - 1} y={MARGIN.top - 4} width={2} height={7} rx={1} fill={marker.color} />
          ))}
          {lines.map((line) => (
            <path key={line.id} d={path(line)} fill="none" stroke={line.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {xTicks.map((tick, index) => (
            <text
              key={tick.at}
              x={x(tick.at)}
              y={height - 6}
              textAnchor={axis !== undefined ? "middle" : index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {tick.label}
            </text>
          ))}
          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={plotBottom} y2={plotBottom} stroke="var(--chart-axis)" />
          {hoverAt === null ? null : (
            <line x1={x(hoverAt)} x2={x(hoverAt)} y1={MARGIN.top} y2={plotBottom} stroke="var(--muted-foreground)" strokeWidth={1} />
          )}
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={plotWidth}
            height={plotBottom - MARGIN.top}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHoverAt(null)}
          />
        </svg>
      )}
      {hoverAt === null ? null : (
        <Tooltip x={x(hoverAt)} width={width}>
          <div className="mb-1 font-medium text-foreground">{timeLabel(hoverAt)}</div>
          {lines.map((line) => {
            const value = valueAt(line, hoverAt);
            return value === null ? null : <TooltipRow key={line.id} line color={line.color} value={format(value)} label={line.label} />;
          })}
        </Tooltip>
      )}
    </div>
  );
}

/** A legend entry: the mark's shape in the series color, then text in text colors. */
export function LegendItem({ color, label, value, line = false }: { color: string; label: string; value?: string; line?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        aria-hidden="true"
        className={cn("shrink-0", line ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]")}
        style={{ background: color }}
      />
      <span className="text-muted-foreground">{label}</span>
      {value === undefined ? null : <span className="tabular-nums text-foreground">{value}</span>}
    </span>
  );
}
