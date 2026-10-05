// Small presentational pieces shared by the Advisor surfaces. Host token
// classes only; no hard-coded colors.

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function Chip({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "strong" | "danger" | "muted"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px] leading-4",
        tone === "neutral" && "border-border text-muted-foreground",
        tone === "strong" && "border-border bg-secondary text-foreground",
        tone === "danger" && "border-destructive/40 text-destructive",
        tone === "muted" && "border-transparent text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function Severity({ severity }: { severity: string }) {
  const icon = severity === "critical" ? "AlertCircle" : severity === "concern" || severity === "unrated" ? "AlertTriangle" : "Info";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", severity === "critical" ? "text-destructive" : severity === "note" ? "text-muted-foreground" : "text-foreground")}>
      <Icon name={icon} className="size-3.5" />
      {severity}
    </span>
  );
}

/** A cited excerpt: the plugin rebuilds it from verified positions, so it cannot be misquoted. */
export function Excerpt({ label, lines, text, mark }: { label: string; lines?: number[]; text: string; mark: "-" | "+" | " " }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[11px] text-muted-foreground">
        {label}
        {lines && lines.length === 2 ? ` · L${lines[0]}${lines[1] !== lines[0] ? `–${lines[1]}` : ""}` : ""}
      </div>
      <pre className={cn("max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs", mark === "-" && "text-muted-foreground")}>
        {text
          .split("\n")
          .map((l) => (mark === " " ? l : `${mark} ${l}`))
          .join("\n")}
      </pre>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ id: T; label: string; count?: number }> }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-border">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "-mb-px shrink-0 cursor-pointer border-b-2 px-2.5 py-1.5 text-sm",
            value === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 ? <span className="ml-1 text-xs text-muted-foreground">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ago(at: number | null, now = Date.now()): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A button whose meaning needs a sentence: the hint is the hover text and the accessible description. */
export function HintButton({ hint, ...props }: ComponentProps<typeof Button> & { hint: string }) {
  return (
    <span title={hint} className="inline-flex">
      <Button aria-description={hint} {...props} />
    </span>
  );
}
