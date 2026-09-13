import { cn } from "@/lib/utils";
import { STATUS_LABEL, type PlanStatus } from "../lib/plan-model";

const DOT_CLASS: Record<PlanStatus, string> = {
  open: "bg-warning",
  approved: "bg-success",
};

/**
 * Glyph tints by status (≥ 3:1 on both canvases): the theme plugin's role
 * hues when its palette is selected, BB's own tokens otherwise. `--success`
 * is too light for a glyph on white, so its fallback leans on the foreground.
 */
export const STATUS_TINT: Record<PlanStatus, string> = {
  open: "var(--bbp-attention, var(--warning-text))",
  approved: "var(--bbp-done, color-mix(in oklch, var(--success) 65%, var(--foreground)))",
};

/** Text colors by status (≥ 4.5:1): BB's `-text` token for amber, the done hue for green. */
const CHIP_TEXT: Record<PlanStatus, string> = {
  open: "var(--warning-text)",
  approved: STATUS_TINT.approved,
};

export function StatusDot({ status, className }: { status: PlanStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_CLASS[status], className)}
    />
  );
}

/** Status as a labelled chip: the word carries the state, the tint only reinforces it. */
export function StatusChip({ status, className }: { status: PlanStatus; className?: string }) {
  const tint = STATUS_TINT[status];
  return (
    <span
      data-status={status}
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none", className)}
      style={{
        color: CHIP_TEXT[status],
        borderColor: `color-mix(in oklab, ${tint} 35%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${tint} 10%, transparent)`,
      }}
    >
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}
