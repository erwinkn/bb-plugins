import { useId, useRef, useState } from "react";
import { normalizeEntries } from "../../lib/allow";

export function AllowedPeople({ entries, disabled, save }: {
  entries: string[];
  disabled: boolean;
  save: (entries: string[]) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const draftVersion = useRef(0);
  const commit = async (text: string) => {
    if (disabled) return;
    const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return;
    let next: string[];
    try {
      next = normalizeEntries([...entries, ...parts]);
      if (next.length > 1000) throw new Error("Use at most 1,000 allowed people or domains.");
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    setError(null);
    const version = draftVersion.current;
    setDraft("");
    // Leave room for the next entry while saving; a late result must not erase it.
    if (next.length !== entries.length && !await save(next) && draftVersion.current === version) setDraft(text);
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="font-medium">Allowed people</label>
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-input p-1.5 focus-within:ring-1 focus-within:ring-ring">
        {entries.map((entry) => (
          <span key={entry} className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[12px]">
            <span className="break-all">{entry}</span>
            <button type="button" aria-label={`Remove ${entry}`} disabled={disabled} onClick={() => void save(entries.filter((item) => item !== entry))}
              className="shrink-0 cursor-pointer rounded px-1 hover:bg-[var(--state-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">×</button>
          </span>
        ))}
        <input id={id} value={draft} aria-busy={disabled} autoComplete="off" autoCapitalize="none" spellCheck={false}
          aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          placeholder={entries.length === 0 ? "Anyone who can sign in" : "Email or @domain"}
          className="min-w-0 basis-40 grow border-0 bg-transparent px-0.5 py-1 text-[16px] outline-none placeholder:text-muted-foreground sm:text-[13px] [@media(pointer:coarse)]:text-[16px]"
          onChange={(event) => {
            const value = event.target.value;
            ++draftVersion.current;
            setDraft(value); setError(null);
            // Mobile keyboards may insert a comma without a keydown event.
            if (value.endsWith(",")) void commit(value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === ",") { event.preventDefault(); void commit(draft); }
            if (!disabled && event.key === "Backspace" && draft === "" && entries.length > 0) {
              event.preventDefault(); void save(entries.slice(0, -1));
            }
          }}
        />
      </div>
      <p id={`${id}-hint`} className="text-[11px] text-muted-foreground">Add emails or @domain, then press Enter or comma.</p>
      {error && <p id={`${id}-error`} role="alert" className="break-words text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
