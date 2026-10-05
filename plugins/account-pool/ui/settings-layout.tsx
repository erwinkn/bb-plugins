import type { ReactNode } from "react";

// Shared layout for the Account Pooler settings sections.
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {description}
          </p>
        </div>
        <div className="shrink-0 self-start">{action}</div>
      </div>
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

export function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
