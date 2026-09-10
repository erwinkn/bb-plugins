import { useId, useState } from "react";

export const DAY = 86_400_000;
export const SELECT_CLASS = "h-8 min-w-0 rounded-md border border-input bg-popover px-2 text-[16px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 sm:text-[12px] [@media(pointer:coarse)]:text-[16px]";
const PRESETS = [7, 30, 90];

export function ExpirySelect({ expiresAt, disabled, save }: {
  expiresAt: number | null;
  disabled: boolean;
  save: (expiresAt: number | null) => Promise<boolean>;
}) {
  const id = useId();
  const [custom, setCustom] = useState(false);
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const preset = expiresAt === null ? undefined : PRESETS.find((days) => Math.abs(expiresAt - Date.now() - days * DAY) < 60_000);
  const selected = expiresAt === null ? "never" : preset ? String(preset) : "current";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id}>Expiry</label>
        <select id={id} className={SELECT_CLASS} disabled={disabled} value={custom ? "custom" : selected}
          onChange={(event) => {
            const value = event.target.value;
            setCustom(value === "custom"); setError(null);
            if (value !== "custom" && value !== "current") void save(value === "never" ? null : Date.now() + Number(value) * DAY);
          }}>
          <option value="never">Never</option>
          {PRESETS.map((days) => <option key={days} value={days}>{days} days</option>)}
          {selected === "current" && <option value="current">{new Date(expiresAt!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</option>}
          <option value="custom">Custom date</option>
        </select>
      </div>
      {custom && <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
        event.preventDefault();
        const timestamp = new Date(date).getTime();
        if (!Number.isFinite(timestamp) || timestamp <= Date.now()) { setError("Choose a future date and time."); return; }
        if (await save(timestamp)) { setCustom(false); setError(null); }
      }}>
        <input type="datetime-local" aria-label="Expiry date" required value={date} disabled={disabled}
          aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
          className={`${SELECT_CLASS} w-full`} onChange={(event) => { setDate(event.target.value); setError(null); }} />
        <button type="submit" disabled={disabled} className="cursor-pointer rounded px-2 py-1 font-medium hover:bg-[var(--state-hover)] focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">Save date</button>
        <button type="button" disabled={disabled} onClick={() => setCustom(false)} className="cursor-pointer rounded px-2 py-1 text-muted-foreground hover:bg-[var(--state-hover)] focus-visible:ring-1 focus-visible:ring-ring">Cancel</button>
        {error && <p id={`${id}-error`} role="alert" className="text-destructive">{error}</p>}
      </form>}
    </div>
  );
}
