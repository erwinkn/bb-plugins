// One feed of findings across every watched Initiative and thread, newest
// first. "Mark seen" is a local mark that clears the sidebar badge, not a
// review. "Discuss" opens BB's composer seeded with the finding; nothing is
// sent until you submit it there.

import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { FeedItem, FeedView as Feed } from "../src/views";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FindingCard } from "./findings";
import { Chip, Empty, HintButton, errorText } from "./ui";

type Filter = { initiativeId?: string; watchId?: string };

export function FeedView({ onOpenWatch, onDiscuss }: { onOpenWatch: (watchId: string) => void; onDiscuss: (occurrenceId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [filter, setFilter] = useState<Filter>({});
  // What is on screen and the filter it was fetched for. Mark all seen acts on that filter only.
  const [feed, setFeed] = useState<{ view: Feed; filter: Filter } | null>(null);
  const [more, setMore] = useState<{ items: FeedItem[]; next: Feed["next"] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every request gets a generation; a response from an earlier one (an old filter or page) is dropped.
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const gen = ++generation.current;
    rpc.call("feed", filter).then(
      (view) => {
        if (gen !== generation.current) return;
        setFeed({ view, filter });
        setMore(null);
        setError(null);
      },
      (e) => {
        if (gen === generation.current) setError(errorText(e));
      },
    );
  }, [rpc, filter]);
  useEffect(() => refetch(), [refetch]);
  useRealtime("advisor.changed", refetch);
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!feed) return <Empty>Loading…</Empty>;
  const shown = feed.filter;
  const current = shown.watchId === filter.watchId && shown.initiativeId === filter.initiativeId;
  const items = [...feed.view.items, ...(more?.items ?? [])];
  const next = more ? more.next : feed.view.next;
  const act = (p: Promise<unknown>) => p.then(refetch, (e) => toast.error(errorText(e)));
  const scoped = shown.watchId ?? shown.initiativeId ?? null;
  const older = () => {
    const gen = generation.current;
    rpc.call("feed", { ...shown, before: next! }).then(
      (f) => {
        if (gen === generation.current) setMore({ items: [...(more?.items ?? []), ...f.items], next: f.next });
      },
      (e) => toast.error(errorText(e)),
    );
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">Findings</h2>
        <Chip tone={feed.view.unseen > 0 ? "strong" : "neutral"}>{feed.view.unseen} new</Chip>
        <span className="flex-1" />
        <HintButton
          size="sm"
          variant="outline"
          // Unseen anywhere in the shown filter counts, loaded or not; nothing acts while a new filter loads.
          disabled={!current || (feed.view.filterUnseen === 0 && items.every((f) => f.acknowledgedAt !== null))}
          onClick={() => act(rpc.call("feedMarkSeen", shown))}
          hint={`Marks every finding ${scoped ? "in this filter" : "of every watch"} seen. A local mark that clears the badge, not a review or sign-off.`}
        >
          Mark all seen
        </HintButton>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <select
          aria-label="Initiative"
          className="min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1"
          value={filter.initiativeId ?? ""}
          onChange={(e) => setFilter(e.target.value ? { initiativeId: e.target.value } : {})}
        >
          <option value="">All Initiatives and threads</option>
          {feed.view.initiatives.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {i.unseen ? ` (${i.unseen} new)` : ""}
            </option>
          ))}
        </select>
        <select
          aria-label="Thread"
          className="min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1"
          value={filter.watchId ?? ""}
          onChange={(e) => setFilter(e.target.value ? { watchId: e.target.value } : filter.initiativeId ? { initiativeId: filter.initiativeId } : {})}
        >
          <option value="">All threads</option>
          {feed.view.threads.map((t) => (
            <option key={t.watchId} value={t.watchId}>
              {t.title ?? t.threadId}
              {t.initiative ? ` · ${t.initiative}` : ""}
              {t.unseen ? ` (${t.unseen} new)` : ""}
            </option>
          ))}
        </select>
      </div>
      {items.length === 0 ? (
        <Empty>No findings here yet. No finding is not a verdict: each thread's Coverage shows what was not judged.</Empty>
      ) : (
        <ul className="space-y-3">
          {items.map((f) => (
            <FindingCard
              key={f.id}
              f={f}
              watchId={f.watchId}
              act={act}
              context={
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button className="min-w-0 cursor-pointer truncate font-medium hover:underline" onClick={() => onOpenWatch(f.watchId)} title="Findings, evidence and coverage of this thread">
                    {f.threadTitle ?? f.threadId}
                  </button>
                  {f.initiative ? <Chip>{f.initiative.name} · {f.initiative.label}</Chip> : null}
                  <span className="flex-1" />
                  {f.threadId ? (
                    <Button size="sm" variant="ghost" onClick={() => nav.toThread(f.threadId!)}>
                      <Icon name="ArrowUpRight" className="size-4" />
                      Open thread
                    </Button>
                  ) : null}
                </div>
              }
              extra={
                f.discussionThreadId ? (
                  <Button size="sm" variant="ghost" onClick={() => nav.toThread(f.discussionThreadId!)}>
                    Open discussion
                  </Button>
                ) : (
                  <HintButton size="sm" variant="ghost" onClick={() => onDiscuss(f.id)} hint="Opens BB's new-thread composer with this finding filled in. Nothing is sent until you submit it.">
                    Discuss
                  </HintButton>
                )
              }
            />
          ))}
        </ul>
      )}
      {next ? (
        <Button size="sm" variant="ghost" disabled={!current} onClick={older}>
          Older findings
        </Button>
      ) : null}
    </div>
  );
}
