// Small shared controls that follow the approved prototype's spacing and use
// only host theme tokens. The question controls compose these.
import type React from "react";
import { useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
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

// Keep editable text large enough for mobile focus without disabling zoom.
export const INPUT_TEXT_CLASS = "text-[16px] sm:text-[13px] [@media(pointer:coarse)]:text-[16px]";

/** Grow with content, including restored drafts and changes in panel width. */
export function TextArea({
  className,
  ref,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  const elementRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => elementRef.current!, []);
  const resize = useCallback(() => {
    const element = elementRef.current;
    if (!element || element.clientWidth === 0) return;
    element.style.height = "auto";
    const border = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + border}px`;
  }, []);
  useLayoutEffect(resize, [resize, props.value, props.defaultValue, props.rows, className]);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        resize();
      }
    });
    observer?.observe(element);
    window.addEventListener("resize", resize);
    let active = true;
    void document.fonts?.ready.then(() => { if (active) resize(); });
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [resize]);
  return (
    <textarea
      ref={elementRef}
      className={cn(
        "box-border block w-full min-h-11 resize-none overflow-y-hidden rounded-md border border-border bg-background px-2 py-1.5 leading-[1.45] text-foreground placeholder:text-[var(--subtle-foreground)] focus:border-[var(--input)] focus:outline-none focus:ring-1 focus:ring-ring",
        INPUT_TEXT_CLASS,
        className,
      )}
      {...props}
      onInput={(event) => {
        props.onInput?.(event);
        resize();
      }}
    />
  );
}

/**
 * Role hues from the theme plugin with BB fallbacks. Glyphs need 3:1 on both
 * canvases; chip text needs 4.5:1, so amber text always uses BB's `-text`
 * token and green leans on the foreground when `--success` is too light.
 */
export const ATTENTION_TINT = "var(--bbp-attention, var(--warning-text))";
export const DONE_TINT = "var(--bbp-done, color-mix(in oklch, var(--success) 65%, var(--foreground)))";

export type ChipTone = "done" | "pending" | "neutral";

function chipStyle(tone: ChipTone): CSSProperties | undefined {
  const tint = tone === "done" ? DONE_TINT : tone === "pending" ? ATTENTION_TINT : null;
  if (tint === null) return undefined;
  return {
    color: tone === "pending" ? "var(--warning-text)" : DONE_TINT,
    borderColor: `color-mix(in oklab, ${tint} 35%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${tint} 10%, transparent)`,
  };
}

/** Small counter chip; the text carries the meaning, the tone only reinforces it. */
export function Chip({ tone = "neutral", className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone }) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none tabular-nums",
        tone === "neutral" && "border-[var(--border)] text-[var(--subtle-foreground)]",
        className,
      )}
      style={chipStyle(tone)}
      {...props}
    >
      {children}
    </span>
  );
}

/** Answered-over-total: green with a check once every answer is submitted, amber while some are missing. */
export function CountChip({ done, total, className }: { done: number; total: number; className?: string }) {
  const complete = total > 0 && done >= total;
  return (
    <Chip tone={complete ? "done" : "pending"} className={className}>
      {complete ? <Icon name="Check" className="size-3" aria-hidden /> : null}
      {done}/{total}
    </Chip>
  );
}

export function Hint({ children, className, role }: { children: ReactNode; className?: string; role?: string }) {
  return (
    <span role={role} className={cn("text-[12px] text-[var(--subtle-foreground)]", className)}>
      {children}
    </span>
  );
}
