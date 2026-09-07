import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** `panel` draws the dashed frame BB's own list pages use; `page` stays open. */
  variant?: "panel" | "page";
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
  variant = "panel",
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        variant === "panel" && "rounded-lg border border-dashed border-border",
        className,
      )}
    >
      {icon ? (
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon name={icon} className="size-5" aria-hidden />
        </span>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{actions}</div> : null}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Icon name="Loading" className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}
