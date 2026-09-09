import { cn } from "@/lib/utils";

export interface SegmentOption<Value extends string> {
  value: Value;
  label: string;
  count?: number;
}

interface SegmentedControlProps<Value extends string> {
  value: Value;
  options: readonly SegmentOption<Value>[];
  onChange: (value: Value) => void;
  label: string;
  className?: string;
}

/** A tab-like switch for views of the same thing; uses the host's active tint. */
export function SegmentedControl<Value extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: SegmentedControlProps<Value>) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("inline-flex h-8 items-center gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.count !== undefined && option.count > 0 ? (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums leading-4",
                  active ? "bg-muted text-foreground" : "bg-background/60 text-muted-foreground",
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
