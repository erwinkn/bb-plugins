// Small shared controls that follow the approved prototype's spacing and use
// only host theme tokens. Everything else in the notebook composes these.
import type React from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** 20px to 26px square ghost button used in title rows and pickers. */
export function IconButton({
  className,
  icon,
  label,
  size = 26,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "children"> & {
  icon: IconName;
  label: string;
  size?: 20 | 22 | 26 | 28;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[var(--subtle-foreground)] transition-colors hover:bg-[var(--state-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        size === 20 && "size-5",
        size === 22 && "size-[22px]",
        size === 26 && "size-[26px]",
        size === 28 && "size-7",
        className,
      )}
      {...props}
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

/** The prototype's `.btn`: 32px outline button; `sm` is 28px. */
export function PanelButton({
  className,
  primary = false,
  small = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; small?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        small ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
        primary
          ? "border-transparent bg-foreground text-background hover:bg-foreground/90"
          : "border-[var(--input)] bg-transparent text-foreground hover:bg-[var(--state-hover)]",
        className,
      )}
      {...props}
    />
  );
}

/** Radio in the vendored checkbox's visual language: 16px, border-input. */
export function Radio({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <input type="radio" className={cn("peer absolute inset-0 m-0 size-4 cursor-pointer appearance-none opacity-0", className)} {...props} />
      <span
        aria-hidden="true"
        className="pointer-events-none inline-block size-4 rounded-full border border-input shadow-xs transition-colors peer-checked:border-foreground peer-checked:bg-foreground peer-focus-visible:ring-1 peer-focus-visible:ring-ring"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute size-1.5 rounded-full bg-background opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}

/** The prototype's `.ta`: bordered text area with the panel's text size. */
export function TextArea({
  className,
  ref,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "block w-full min-h-11 resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[13px] leading-[1.45] text-foreground placeholder:text-[var(--subtle-foreground)] focus:border-[var(--input)] focus:outline-none focus:ring-1 focus:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

export function Hint({ children, className, role }: { children: ReactNode; className?: string; role?: string }) {
  return (
    <span role={role} className={cn("text-[12px] text-[var(--subtle-foreground)]", className)}>
      {children}
    </span>
  );
}
