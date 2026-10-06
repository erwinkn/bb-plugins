import { useEffect, useState } from "react";
import { UrlLink, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { advisorContract } from "../lib/advisor-contract";
import { ADVISOR_FEED_HREF, ADVISOR_UNSEEN_CHANNEL, advisorSummary, type AdvisorSummary } from "../lib/advisor-schema";
import { usePathname } from "../lib/use-pathname";
import { EntryRowBody, entryRowClass } from "./entry-row";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The entry's one-line status: what the Advisor watches, or that reviews are off. The badge carries the count. */
export function advisorStatus(s: AdvisorSummary): string {
  if (!s.reviewing) return "Reviews off";
  const watched = [s.initiatives ? plural(s.initiatives, "initiative") : null, s.threads ? plural(s.threads, "thread") : null].filter(Boolean);
  return watched.join(" · ") || "Nothing watched";
}

/**
 * The one Advisor entry (T106, T122), drawn like an Initiative row: icon tile,
 * title over a status line, and the count of new findings as a badge, opening
 * the Advisor feed. Read once on mount; afterwards the Advisor pushes each
 * change, so nothing polls. Hidden while the Advisor is missing or disabled.
 * `alignWithInitiatives` keeps the right edge in line with Initiative rows,
 * which reserve a New thread button there.
 */
export function AdvisorEntry({ onNavigate, alignWithInitiatives = false }: { onNavigate: () => void; alignWithInitiatives?: boolean }) {
  const api = useRpc<typeof advisorContract>();
  const [entry, setEntry] = useState<{ available: boolean; summary: AdvisorSummary | null } | null>(null);
  const active = usePathname().startsWith(ADVISOR_FEED_HREF);
  useEffect(() => {
    let live = true;
    api.call("advisorEntry", null).then(
      (r) => live && setEntry(r),
      () => live && setEntry({ available: false, summary: null }),
    );
    return () => {
      live = false;
    };
  }, [api]);
  useRealtime(ADVISOR_UNSEEN_CHANNEL, (payload) => {
    const pushed = advisorSummary.safeParse(payload);
    if (pushed.success) setEntry({ available: true, summary: pushed.data });
  });
  if (!entry?.available) return null;
  const n = entry.summary?.unseen ?? 0;
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
      <UrlLink
        href={ADVISOR_FEED_HREF}
        onClick={onNavigate}
        data-advisor-entry=""
        aria-label={n > 0 ? `Advisor, ${n} new findings` : "Advisor"}
        aria-current={active ? "page" : undefined}
        className={entryRowClass(active)}
      >
        <EntryRowBody icon="SecurityCheck" fallback="Info" title="Advisor" metadata={entry.summary ? advisorStatus(entry.summary) : undefined}>
          {n > 0 && (
            <span aria-hidden="true" className="rounded-full bg-foreground px-1.5 text-[11px] leading-4 text-background">
              {n > 99 ? "99+" : n}
            </span>
          )}
        </EntryRowBody>
      </UrlLink>
      {alignWithInitiatives && <span aria-hidden="true" className="size-8 shrink-0" />}
    </div>
  );
}
