import { useId, useState } from "react";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { useShares, type SharesController } from "../../hooks/useShares";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CreateLink } from "./CreateLink";
import { ShareRow } from "./ShareRow";

export function HeaderControl(props: PluginThreadHeaderActionProps) {
  // Hosts may reuse a slot across navigation. Reset drafts and pending work.
  return <ThreadShareControl key={props.threadId} {...props} />;
}

function Loading() {
  return <div role="status" aria-label="Loading share links" className="space-y-2 p-3">
    <span className="sr-only">Loading share links…</span>
    <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
    <div className="h-5 animate-pulse rounded bg-muted" />
  </div>;
}

function ShareContents({ controller }: { controller: SharesController }) {
  const { status, shares, statusError, listError } = controller;
  if (status && !status.configured) return <div className="space-y-2 p-3">
    <p>To enable sharing, set {status.missing.join(", ")}.</p>
    <p className="text-[12px] text-muted-foreground">Settings → Share (/settings/plugins/share)</p>
  </div>;
  if (statusError) return <div className="space-y-2 p-3">
    <p role="alert">{statusError}</p>
    <Button type="button" variant="outline" size="sm" onClick={() => void controller.refresh()}>Try again</Button>
  </div>;
  if (!status) return <Loading />;
  const sorted = [...(shares ?? [])].sort((a, b) => Number(b.state === "active") - Number(a.state === "active") || b.createdAt - a.createdAt);
  return <>
    <CreateLink key={status.defaultExpiryDays} status={status} controller={controller} />
    {listError && <div className="space-y-2 p-3">
      <p role="alert" className="text-destructive">{listError}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => void controller.refresh()}>Try again</Button>
    </div>}
    {shares === null ? !listError && <Loading /> : shares.length === 0 ? <p className="p-6 text-center text-muted-foreground">No links yet</p> : (
      <ul aria-label="Share links" className="m-0 list-none p-0">{sorted.map((share) => <ShareRow key={share.id} share={share} controller={controller} />)}</ul>
    )}
    {status.publicBaseUrl && <p className="break-all border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Links open at {new URL(status.publicBaseUrl).host}</p>}
  </>;
}

function ThreadShareControl({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const controller = useShares(threadId);
  const [open, setOpen] = useState(false);
  const id = useId();
  const active = controller.shares?.some((share) => share.state === "active") ?? false;
  return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) void controller.refresh(); }}>
    <PopoverTrigger asChild>
      <button type="button" aria-label="Share" title="Share" aria-describedby={active ? `${id}-active` : undefined}
        className={cn("inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-[var(--state-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-[var(--state-active)] data-[state=open]:text-foreground", isCompactViewport && "px-1.5")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3.5">
          <path d="M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l2-2" />
        </svg>
        {!isCompactViewport && <span>Share</span>}
        {active && <span id={`${id}-active`} role="img" aria-label="Active share links" className="size-1.5 rounded-full bg-[var(--success)]" />}
      </button>
    </PopoverTrigger>
    <PopoverContent aria-label="Share thread" align="end" sideOffset={6} collisionPadding={8}
      onOpenAutoFocus={(event) => { event.preventDefault(); document.getElementById(`${id}-heading`)?.focus(); }}
      className="max-h-[min(80dvh,var(--radix-popover-content-available-height))] w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto p-0 text-[13px]">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 id={`${id}-heading`} tabIndex={-1} className="text-[13px] font-semibold outline-none">Share thread</h2>
        <Button type="button" variant="ghost" size="sm" aria-label="Close share popover" className="size-6 p-0 text-lg text-muted-foreground" onClick={() => setOpen(false)}>×</Button>
      </div>
      <ShareContents controller={controller} />
    </PopoverContent>
  </Popover>;
}
