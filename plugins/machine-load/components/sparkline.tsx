import { useId } from "react";

export interface SparklinePoint {
  t: number;
  value: number | null;
}

/** Breaks the line where samples stopped, e.g. while no window was open. */
const GAP_FACTOR = 3;

/**
 * A 0–100 area sparkline over time. The x axis spans from the first point to
 * the last, so a fresh history fills the width instead of hugging the edge.
 */
export function Sparkline({
  points,
  intervalMs,
  className,
  label,
}: {
  points: SparklinePoint[];
  intervalMs: number;
  className?: string;
  label: string;
}) {
  const clipId = useId();
  const width = 100;
  const height = 24;
  const known = points.filter((point) => point.value !== null) as Array<{ t: number; value: number }>;
  if (known.length < 2) {
    return <div aria-hidden="true" className={className} style={{ height }} />;
  }
  const start = known[0]!.t;
  const span = Math.max(1, known.at(-1)!.t - start);
  const x = (t: number) => ((t - start) / span) * width;
  const y = (value: number) => height - (Math.min(100, Math.max(0, value)) / 100) * (height - 1) - 0.5;
  const segments: Array<Array<{ t: number; value: number }>> = [];
  for (const point of known) {
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    if (segment === undefined || previous === undefined || point.t - previous.t > intervalMs * GAP_FACTOR) {
      segments.push([point]);
    } else {
      segment.push(point);
    }
  }
  const line = segments
    .map((segment) => segment.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.t).toFixed(2)},${y(point.value).toFixed(2)}`).join(""))
    .join("");
  const area = segments
    .filter((segment) => segment.length > 1)
    .map(
      (segment) =>
        `M${x(segment[0]!.t).toFixed(2)},${height}` +
        segment.map((point) => `L${x(point.t).toFixed(2)},${y(point.value).toFixed(2)}`).join("") +
        `L${x(segment.at(-1)!.t).toFixed(2)},${height}Z`,
    )
    .join("");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height }}
    >
      <clipPath id={clipId}>
        <rect width={width} height={height} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <path d={area} fill="currentColor" opacity={0.12} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
