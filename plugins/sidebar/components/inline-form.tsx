import { useEffect, useRef, useState, type ReactNode } from "react";

export const formButtonClass =
  "rounded-md px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const formInputClass =
  "min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

// A small form that lives where the action was triggered. The caller performs
// the save; errors stay next to the fields and the input is not lost.
export function InlineForm({
  label,
  submitLabel,
  destructive = false,
  canSubmit = true,
  hint,
  onSubmit,
  onClose,
  children,
}: {
  label: string;
  submitLabel: string;
  destructive?: boolean;
  canSubmit?: boolean;
  hint?: string;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Menus that open a form give up their focus restoration; take focus here
  // so typing or confirming starts immediately.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const form = formRef.current;
      if (!form || form.contains(document.activeElement)) return;
      const target =
        form.querySelector<HTMLElement>("input, select") ??
        form.querySelector<HTMLElement>("button[type=submit]");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <form
      ref={formRef}
      aria-label={label}
      className="mt-2 flex flex-wrap items-center gap-2 px-2"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !savingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (savingRef.current || !canSubmit) return;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        try {
          await onSubmit();
          onClose();
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The change was not saved.",
          );
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      }}
    >
      {children}
      <button
        type="submit"
        disabled={saving || !canSubmit}
        className={`${formButtonClass} ${destructive ? "text-destructive" : ""}`}
      >
        {saving ? "Saving…" : submitLabel}
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={onClose}
        className={formButtonClass}
      >
        Cancel
      </button>
      {hint && !error && (
        <p className="w-full text-xs text-muted-foreground">{hint}</p>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** A single trimmed text field with a maximum length. */
export function NameField({
  label,
  value,
  max,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      aria-label={label}
      placeholder={placeholder ?? label}
      maxLength={max}
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => onChange(event.target.value)}
      className={formInputClass}
    />
  );
}
