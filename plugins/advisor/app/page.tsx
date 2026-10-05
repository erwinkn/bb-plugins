// The Advisor page: what is active, which threads are watched, and one
// thread's findings and evidence. Desktop shows list and detail side by side;
// compact screens show one at a time (the detail is a sub-path).

import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { InitiativeOption, ThreadOption } from "../src/rpc";
import type { InitiativeWatchView, Overview } from "../src/views";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Chip, Empty, HintButton, errorText } from "./ui";
import { WatchView } from "./watch";
import { FeedView } from "./feed";
import { DiscussView } from "./discuss";

export const PANEL_PATH = "advisor";

export function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (x) => {
        setO(x);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, [rpc]);
  useEffect(() => refetch(), [refetch]);
  useRealtime("advisor.changed", refetch);
  return { o, error, refetch };
}

export function ActivationStrip({ o }: { o: Overview }) {
  const a = o.activation;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        <Chip tone={a.observation ? "strong" : "neutral"}>observation {a.observation ? "on" : "off"}</Chip>
        <Chip tone={a.review ? "strong" : "neutral"}>reviews {a.review ? "on" : "off"}</Chip>
        <Chip tone={a.providerRequests ? "danger" : "neutral"} title="Whether model requests (money or subscription quota) may be sent">
          provider requests {a.providerRequests ? "allowed" : "off"}
        </Chip>
        <Chip title={a.routeLabel}>route {a.route}</Chip>
        {a.billing === "usd" ? (
          <Chip>
            today ${o.today.usd.charged.toFixed(4)} of {o.today.usd.cap === null ? "unset" : `$${o.today.usd.cap}`} · {o.today.usd.requests}/{o.today.usd.requestCap ?? "unset"} requests
          </Chip>
        ) : null}
        {a.billing === "subscription" ? (
          <Chip>
            today {o.today.subscription.requests}/{o.today.subscription.requestCap ?? "unset"} requests · {o.today.subscription.tokens}/{o.today.subscription.tokenCap ?? "unset"} tokens (quota, not USD)
          </Chip>
        ) : null}
      </div>
      {[...o.errors.review, ...o.errors.observation].map((e) => (
        <p key={e} role="alert" className="text-xs text-destructive">
          {e}
        </p>
      ))}
      {o.notes.map((n) => (
        <p key={n} className="text-xs text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

function ThreadPicker({ open, onClose, onPicked }: { open: boolean; onClose: () => void; onPicked: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<ThreadOption[] | null>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      rpc.call("threadOptions", { query }).then((r) => setThreads(r.threads), (e) => toast.error(errorText(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [rpc, open, query]);
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Watch a thread</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">The Advisor reads the thread's events and environment. It never sends messages to the thread or changes its files.</p>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by title or id" aria-label="Search threads" autoFocus />
        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
          {(threads ?? []).map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">{t.title ?? t.id}</span>
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{t.id}</span>
              <Button
                size="sm"
                variant={t.watched ? "ghost" : "outline"}
                disabled={t.watched}
                onClick={() =>
                  rpc.call("watchAdd", { threadId: t.id }).then(
                    () => {
                      toast.success(`Watching ${t.title ?? t.id}`);
                      onPicked();
                    },
                    (e) => toast.error(errorText(e)),
                  )
                }
              >
                {t.watched ? "Watched" : "Watch"}
              </Button>
            </li>
          ))}
          {threads !== null && threads.length === 0 ? <li className="py-2 text-sm text-muted-foreground">No threads match.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function InitiativePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [r, setR] = useState<{ status: string; error: string | null; initiatives: InitiativeOption[] } | null>(null);
  useEffect(() => {
    if (!open) return;
    setR(null);
    rpc.call("initiativeOptions").then(setR, (e) => toast.error(errorText(e)));
  }, [rpc, open]);
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Watch an Initiative</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Watches its coordinator, workers, reviewers and your threads in it, and members that join later. Retired and replaced members stop being observed and keep their history. Reviews follow your Settings, caps and route.
        </p>
        {r === null ? <Empty>Loading…</Empty> : null}
        {r && r.status !== "ok" ? (
          <p role="alert" className="text-sm text-destructive">
            Initiatives cannot be listed: the Projects context routes are {r.status === "unavailable" ? "unavailable" : "unreadable"} ({r.error}). Nothing can be watched as an Initiative until they are.
          </p>
        ) : null}
        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
          {(r?.initiatives ?? []).map((i) => (
            <li key={i.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">{i.name}</span>
              {i.paused ? <Chip tone="muted">paused</Chip> : null}
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{i.id}</span>
              <Button
                size="sm"
                variant={i.watched ? "ghost" : "outline"}
                disabled={i.watched}
                onClick={() =>
                  rpc.call("initiativeWatchSet", { initiativeId: i.id, enabled: true }).then(
                    (x) => {
                      toast.success(`Watching ${i.name}: ${x.initiative.members.observed} threads`);
                      onClose();
                    },
                    (e) => toast.error(errorText(e)),
                  )
                }
              >
                {i.watched ? "Watched" : "Watch"}
              </Button>
            </li>
          ))}
          {r?.status === "ok" && r.initiatives.length === 0 ? <li className="py-2 text-sm text-muted-foreground">No open Initiative.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function InitiativeRow({ i }: { i: InitiativeWatchView }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const act = (p: () => Promise<unknown>) => {
    setBusy(true);
    p().then(
      () => setBusy(false),
      (e) => {
        setBusy(false);
        toast.error(errorText(e));
      },
    );
  };
  const m = i.members;
  return (
    <li className="space-y-1 rounded-md px-2 py-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("size-2 shrink-0 rounded-full", i.enabled && !i.error ? "bg-foreground" : "bg-muted-foreground/40")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{i.name}</span>
        {!i.enabled ? (
          <HintButton size="sm" variant="ghost" disabled={busy} hint="Deletes the Initiative watch and the evidence of the member watches it started. Threads you watch yourself are kept." onClick={() => act(() => rpc.call("initiativeWatchRemove", { initiativeId: i.id }))}>
            Remove
          </HintButton>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} aria-pressed={i.enabled} onClick={() => act(() => rpc.call("initiativeWatchSet", { initiativeId: i.id, enabled: !i.enabled }))}>
          {i.enabled ? "On" : "Off"}
        </Button>
      </div>
      <p className="pl-4 text-xs text-muted-foreground">
        {i.archived ? "archived · " : ""}
        {m.observed} observed of {m.live} live members
        {m.total > m.live ? ` · ${m.total - m.live} retired, former or archived` : ""}
        {m.excluded ? ` · ${m.excluded} excluded` : ""}
      </p>
      {i.error ? (
        <p role="alert" className="pl-4 text-xs text-destructive">
          {i.error}
        </p>
      ) : null}
    </li>
  );
}

export function AdvisorPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const { o, error, refetch } = useOverview();
  const [picking, setPicking] = useState(false);
  const [pickingInitiative, setPickingInitiative] = useState(false);
  // Routes: "" the findings feed, "watches" the list (on narrow screens), "<watchId>" one
  // thread, "discuss/<occurrenceId>" the Discuss composer.
  const route = subPath.replace(/^\/+|\/+$/gu, "");
  const select = (id: string | null) => nav.toPluginPanel(PANEL_PATH, { subPath: id ?? "" });
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
  if (!o) return <div className="p-4"><Empty>Loading…</Empty></div>;
  const watch = o.watches.find((w) => w.id === route) ?? null;
  const discuss = route.startsWith("discuss/") ? route.slice("discuss/".length) : null;
  const listing = route === "watches";
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col md:flex-row">
      <aside className={cn("min-h-0 shrink-0 space-y-3 overflow-y-auto border-border p-4 md:w-80 md:border-r", !listing && "hidden md:block")}>
        <Button size="sm" variant="ghost" className="md:hidden" onClick={() => select(null)}>
          <Icon name="ChevronLeft" className="size-4" />
          Findings
        </Button>
        <ActivationStrip o={o} />
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Initiatives</h2>
          <Button size="sm" variant="outline" aria-label="Watch an Initiative" onClick={() => setPickingInitiative(true)}>
            <Icon name="Plus" className="size-4" />
            Watch
          </Button>
        </div>
        {o.initiativeWatches.length === 0 ? (
          <p className="text-xs text-muted-foreground">Watch a whole Initiative with one switch, including members that join later.</p>
        ) : (
          <ul className="space-y-1">
            {o.initiativeWatches.map((i) => (
              <InitiativeRow key={i.id} i={i} />
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Watched threads</h2>
          <Button size="sm" variant="outline" aria-label="Watch a thread" onClick={() => setPicking(true)}>
            <Icon name="Plus" className="size-4" />
            Watch
          </Button>
        </div>
        {o.watches.length === 0 ? (
          <Empty>No thread is watched. Watching is off until you pick a thread.</Empty>
        ) : (
          <ul className="space-y-1">
            {o.watches.map((w) => (
              <li key={w.id}>
                <button
                  onClick={() => select(w.id)}
                  aria-current={w.id === route}
                  className={cn("flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover", w.id === route && "bg-state-active")}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", w.enabled && w.pause.length === 0 ? "bg-foreground" : "bg-muted-foreground/40")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{w.title ?? w.threadId}</span>
                  {w.initiative ? (
                    <span className="shrink-0 text-xs text-muted-foreground" title={`${w.initiative.name} · ${w.initiative.state}`}>
                      {w.initiative.label}
                    </span>
                  ) : null}
                  {w.unacknowledged > 0 ? <span className="rounded-full bg-foreground px-1.5 text-[11px] text-background">{w.unacknowledged}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <p>{o.initiativeContext}</p>
          {o.deferred.map((d) => (
            <p key={d.id}>
              {d.label}: {d.status}
            </p>
          ))}
        </div>
      </aside>
      <main className={cn("min-h-0 flex-1 overflow-y-auto p-4 md:p-5", listing && "hidden md:block")}>
        <div className="mx-auto h-full w-full max-w-3xl">
          {discuss ? (
            <DiscussView key={discuss} occurrenceId={discuss} onBack={() => select(null)} />
          ) : watch ? (
            <>
              <Button size="sm" variant="ghost" className="mb-2" onClick={() => select(null)}>
                <Icon name="ChevronLeft" className="size-4" />
                Findings
              </Button>
              <WatchView key={watch.id} watchId={watch.id} threshold={o.severityThreshold} onRemoved={() => select(null)} />
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" className="mb-3 md:hidden" onClick={() => select("watches")}>
                Watches and Initiatives ({o.watches.length})
              </Button>
              <FeedView onOpenWatch={(id) => select(id)} onDiscuss={(id) => select(`discuss/${id}`)} />
            </>
          )}
        </div>
      </main>
      <InitiativePicker
        open={pickingInitiative}
        onClose={() => {
          setPickingInitiative(false);
          refetch();
        }}
      />
      <ThreadPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPicked={() => {
          setPicking(false);
          refetch();
        }}
      />
    </div>
  );
}
