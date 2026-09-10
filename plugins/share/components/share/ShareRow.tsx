import { useId, useState } from "react";
import { toast } from "sonner";
import type { Share } from "../../lib/model";
import type { SharesController } from "../../hooks/useShares";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AllowedPeople } from "./AllowedPeople";
import { DAY, ExpirySelect } from "./ExpirySelect";

function relativeDate(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ShareRow({ share, controller }: { share: Share; controller: SharesController }) {
  const id = useId();
  const [showUrl, setShowUrl] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const active = share.state === "active";
  const disabledBySettings = share.visibility === "public" && controller.status?.publicLinksEnabled === false;
  const stateLabel = active ? disabledBySettings ? "Disabled by settings" : "Active" : share.state === "revoked" ? "Revoked" : "Expired";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(share.url);
      setShowUrl(false);
      toast.success("Link copied");
    } catch { setShowUrl(true); }
  };
  return (
    <li aria-label={`${share.visibility === "public" ? "Public" : "Sign-in"} link, ${stateLabel.toLowerCase()}`} className="space-y-3 border-b border-border p-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", share.visibility === "public" ? "bg-[var(--warning)]/10 text-[var(--warning-text)]" : "bg-muted text-muted-foreground")}>
          {share.visibility === "public" ? "Public" : "Sign-in"}
        </span>
        <span className={cn("text-[12px]", active && !disabledBySettings ? "text-foreground" : "text-muted-foreground")}>{stateLabel}</span>
        <time className="ml-auto text-[11px] text-muted-foreground" dateTime={new Date(share.createdAt).toISOString()} title={new Date(share.createdAt).toLocaleString()}>Created {relativeDate(share.createdAt)}</time>
      </div>
      {active && <>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">
            {share.viewCount} {share.viewCount === 1 ? "view" : "views"} · {share.lastViewedAt === null ? "Never viewed" : <>Last viewed <time dateTime={new Date(share.lastViewedAt).toISOString()} title={new Date(share.lastViewedAt).toLocaleString()}>{relativeDate(share.lastViewedAt)}</time></>}
          </p>
          {!disabledBySettings && <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[12px]" onClick={() => void copy()}>Copy</Button>}
        </div>
        {showUrl && !disabledBySettings && <div className="space-y-1">
          <label htmlFor={`${id}-url`} className="text-[11px] text-muted-foreground">Copy this link</label>
          <input id={`${id}-url`} readOnly value={share.url} autoFocus onFocus={(event) => event.currentTarget.select()}
            className="w-full min-w-0 rounded-md border border-input bg-transparent p-2 text-[16px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:text-[12px]" />
        </div>}
        {share.visibility === "access" && <AllowedPeople entries={share.allowedEmails} disabled={controller.busy} save={(allowedEmails) => controller.update(share.id, { allowedEmails })} />}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${id}-tools`}>Include tool output</label>
            <Switch id={`${id}-tools`} checked={share.includeTools} disabled={controller.busy}
              aria-describedby={share.includeTools ? `${id}-warning` : undefined}
              onCheckedChange={(includeTools) => void controller.update(share.id, { includeTools })} />
          </div>
          {share.includeTools && <p id={`${id}-warning`} className="text-[11px] text-[var(--warning-text)]">Tool output can contain file contents, paths, and logs.</p>}
        </div>
        <ExpirySelect expiresAt={share.expiresAt} disabled={controller.busy} save={(expiresAt) => controller.update(share.id, { expiresAt })} />
        <div className="flex flex-wrap items-center gap-2">
          {confirmRevoke ? <>
            <span className="mr-auto text-[12px]">Revoke this link?</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={controller.busy} onClick={() => setConfirmRevoke(false)}>Cancel</Button>
            <Button type="button" size="sm" variant="destructive" className="h-7 text-[12px]" disabled={controller.busy} onClick={() => void controller.revoke(share.id)}>Revoke link</Button>
          </> : <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 px-2 text-[12px] text-destructive" disabled={controller.busy} onClick={() => setConfirmRevoke(true)}>Revoke</Button>}
        </div>
      </>}
    </li>
  );
}
