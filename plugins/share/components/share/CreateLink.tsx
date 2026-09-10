import { useId, useState } from "react";
import type { Status, Visibility } from "../../lib/model";
import type { SharesController } from "../../hooks/useShares";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { SELECT_CLASS } from "./ExpirySelect";

export function CreateLink({ status, controller }: { status: Status; controller: SharesController }) {
  const [mode, setMode] = useState<Visibility | null>(status.accessConfigured ? "access" : null);
  const [expiry, setExpiry] = useState(status.defaultExpiryDays);
  const id = useId();
  const choices = [
    { mode: "access" as const, label: "Sign-in required", enabled: status.accessConfigured, reason: "Set accessTeamDomain and accessAudience in Share settings to require sign-in." },
    { mode: "public" as const, label: "Public", enabled: status.publicLinksEnabled, reason: "Public links are disabled in Share settings (publicLinksEnabled)." },
  ];
  const canCreate = !controller.busy && (mode === "access" ? status.accessConfigured : mode === "public" && status.publicLinksEnabled);
  const create = async () => {
    if (!canCreate || mode === null) return;
    if (await controller.create({ visibility: mode, includeTools: false, expiresInDays: expiry === 0 ? null : expiry })) {
      // Creating a second public link needs a fresh explicit choice.
      setMode(status.accessConfigured ? "access" : null);
    }
  };
  return (
    <div className="space-y-3 border-b border-border p-3">
      <TooltipProvider delayDuration={200}>
        <div role="group" aria-label="Link visibility" className="flex gap-1 rounded-md bg-muted p-1">
          {choices.map((choice) => <Tooltip key={choice.mode}>
            <TooltipTrigger asChild>
              <span className="flex flex-1" tabIndex={!choice.enabled ? 0 : undefined} aria-label={!choice.enabled ? `${choice.label} unavailable` : undefined}>
                <Button type="button" variant="ghost" size="sm" aria-pressed={mode === choice.mode} disabled={!choice.enabled || controller.busy}
                  aria-describedby={!choice.enabled ? `${id}-${choice.mode}` : undefined}
                  className="h-7 w-full px-2 text-[12px] aria-pressed:bg-background aria-pressed:shadow-xs"
                  onClick={() => setMode(choice.mode)}>{choice.label}</Button>
              </span>
            </TooltipTrigger>
            {!choice.enabled && <>
              <span id={`${id}-${choice.mode}`} className="sr-only">{choice.reason}</span>
              <TooltipContent>{choice.reason}</TooltipContent>
            </>}
          </Tooltip>)}
        </div>
      </TooltipProvider>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`${id}-expiry`}>New link expiry</label>
        <select id={`${id}-expiry`} className={SELECT_CLASS} value={expiry} disabled={controller.busy} onChange={(event) => setExpiry(Number(event.target.value))}>
          <option value={0}>Never</option>
          {[7, 30, 90].map((days) => <option key={days} value={days}>{days} days</option>)}
          {![0, 7, 30, 90].includes(status.defaultExpiryDays) && <option value={status.defaultExpiryDays}>{status.defaultExpiryDays} days (default)</option>}
        </select>
      </div>
      {mode === "public" && status.publicLinksEnabled ? (
        <div className="space-y-2 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
          <p className="text-[12px] text-[var(--warning-text)]">Anyone with the link can read this thread.</p>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" className="h-7 text-[12px]" disabled={!canCreate} onClick={() => void create()}>Create public link</Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={controller.busy} onClick={() => setMode(status.accessConfigured ? "access" : null)}>Cancel</Button>
          </div>
        </div>
      ) : <Button type="button" size="sm" className="h-7 w-full text-[12px]" disabled={!canCreate} onClick={() => void create()}>Create link</Button>}
    </div>
  );
}
