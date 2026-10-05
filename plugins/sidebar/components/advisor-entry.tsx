import { useEffect, useState } from "react";
import { UrlLink, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { HostIcon } from "../lib/host-icon";
import type { advisorContract } from "../lib/advisor-contract";
import { ADVISOR_FEED_HREF, ADVISOR_UNSEEN_CHANNEL } from "../lib/advisor-links";

/**
 * The one Advisor entry (T106): icon, label and the live count of new findings,
 * opening the Advisor feed. Read once on mount; afterwards the Advisor pushes
 * each change, so nothing polls. Hidden while the Advisor is missing or disabled.
 */
export function AdvisorEntry({ onNavigate }: { onNavigate: () => void }) {
  const api = useRpc<typeof advisorContract>();
  const [entry, setEntry] = useState<{ available: boolean; unseen: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    api.call("advisorEntry", null).then(
      (r) => live && setEntry(r),
      () => live && setEntry({ available: false, unseen: null }),
    );
    return () => {
      live = false;
    };
  }, [api]);
  useRealtime(ADVISOR_UNSEEN_CHANNEL, (payload) => {
    const unseen = (payload as { unseen?: unknown })?.unseen;
    if (typeof unseen === "number") setEntry({ available: true, unseen });
  });
  if (!entry?.available) return null;
  const n = entry.unseen ?? 0;
  return (
    <UrlLink
      href={ADVISOR_FEED_HREF}
      onClick={onNavigate}
      data-advisor-entry=""
      aria-label={n > 0 ? `Advisor, ${n} new findings` : "Advisor"}
      className="mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground no-underline outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <HostIcon name="SecurityCheck" fallback="Info" className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Advisor</span>
      {n > 0 && (
        <span aria-hidden="true" className="rounded-full bg-foreground px-1.5 text-[11px] leading-4 text-background">
          {n > 99 ? "99+" : n}
        </span>
      )}
    </UrlLink>
  );
}
