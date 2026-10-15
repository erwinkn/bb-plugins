/**
 * The count chip on a group header. Muted by default; Needs Attention turns
 * amber while it holds rows. Decorative: the rows below carry the meaning.
 */
export function GroupCount({
  count,
  attention = false,
}: {
  count: number;
  attention?: boolean;
}) {
  const alert = attention && count > 0;
  return (
    <span
      aria-hidden="true"
      data-group-count={count}
      data-group-count-tone={alert ? "attention" : "muted"}
      className={`shrink-0 rounded px-1 text-[10px] leading-4 tabular-nums ${alert ? "bg-[var(--surface-attention)] font-medium text-[var(--warning-text)]" : "bg-muted text-muted-foreground"}`}
    >
      {count}
    </span>
  );
}
