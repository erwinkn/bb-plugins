// One watched thread: findings, evidence, coverage, requirements and reviews.

import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { CardView, WatchDetail as Detail } from "../src/views";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FindingsList } from "./findings";
import { Chip, Empty, HintButton, Section, Tabs, ago, errorText } from "./ui";

type Tab = "findings" | "evidence" | "coverage" | "requirements" | "reviews";

export function useWatchDetail(watchId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (!watchId) return;
    rpc.call("watchDetail", { watchId }).then(
      (d) => {
        setDetail(d);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, [rpc, watchId]);
  useEffect(() => {
    setDetail(null);
    refetch();
  }, [refetch]);
  useRealtime("advisor.changed", refetch);
  return { detail, error, refetch };
}

export function WatchView({ watchId, threshold, onRemoved, compact = false }: { watchId: string; threshold: string; onRemoved?: () => void; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const { detail, error, refetch } = useWatchDetail(watchId);
  const [tab, setTab] = useState<Tab>("findings");
  const [busy, setBusy] = useState(false);
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!detail) return <Empty>Loading…</Empty>;
  const s = detail.summary;
  const act = async (p: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await p();
      if (done) toast.success(done);
      refetch();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const paused = s.pause.filter((r) => r === "manual" || r === "failure" || r === "interrupted");
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-medium">{s.title ?? s.threadId}</h2>
          {!compact ? (
            <Button size="sm" variant="ghost" onClick={() => nav.toThread(s.threadId)}>
              <Icon name="ArrowUpRight" className="size-4" />
              Open thread
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          <Chip tone={s.enabled ? "strong" : "neutral"}>{s.enabled ? "observing" : "disabled"}</Chip>
          {s.pause.map((p) => (
            <Chip key={p} tone="danger">
              paused: {p}
            </Chip>
          ))}
          <Chip title="Events read so far, and the newest event seen">
            #{s.cursor ?? "–"} of #{s.tip ?? "–"} {s.atTip ? "· at tip" : "· behind"}
          </Chip>
          <Chip title="Evidence not yet judged">{s.backlog} unreviewed</Chip>
          {s.inflight ? <Chip tone="strong">review in flight</Chip> : null}
          {s.hold ? <Chip tone="muted" title="Why no review would start now">{s.hold}</Chip> : null}
        </div>
        {s.lastError ? <p className="text-xs text-destructive">{s.lastError}</p> : null}
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => rpc.call("watchSetEnabled", { watchId, enabled: !s.enabled }))}>
            {s.enabled ? "Disable" : "Enable"}
          </Button>
          {paused.length > 0 ? (
            <HintButton size="sm" variant="outline" disabled={busy} onClick={() => act(() => rpc.call("watchResume", { watchId }), "Resumed (caller unverified)")} hint="Clears manual, failure and interrupt pauses only">
              Resume
            </HintButton>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => rpc.call("watchPause", { watchId }), "Paused")}>
              Pause reviews
            </Button>
          )}
          <HintButton
            size="sm"
            variant="outline"
            disabled={busy}
            hint="Builds the packet for the selected route and sends it to the fake reviewer. No request, no spend, frontier unchanged."
            onClick={() =>
              act(async () => {
                const r = await rpc.call("previewReview", { watchId });
                toast(r.state === "current" ? "Preview stored (fake reviewer)" : `Preview: ${r.state}${r.why ? ` (${r.why})` : ""}`);
              })
            }
          >
            Preview (fake)
          </HintButton>
          {!compact ? (
            <>
              <HintButton size="sm" variant="ghost" disabled={busy || s.backlog === 0} onClick={() => act(() => rpc.call("watchSkipToTip", { watchId }), "Skipped; recorded as not judged")} hint="Marks every unreviewed card as not judged. Recorded as a gap.">
                Skip to tip
              </HintButton>
              <HintButton size="sm" variant="ghost" disabled={busy} onClick={() => act(async () => (await rpc.call("watchRemove", { watchId }), onRemoved?.()))} hint="Stops watching and deletes this thread's evidence and findings. The spend ledger keeps its rows.">
                Remove
              </HintButton>
            </>
          ) : null}
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { id: "findings", label: "Findings", count: s.unacknowledged },
          { id: "evidence", label: "Evidence" },
          { id: "coverage", label: "Coverage", count: detail.gaps.length },
          { id: "requirements", label: "Requirements", count: detail.requirements.length },
          { id: "reviews", label: "Reviews" },
        ]}
      />
      {tab === "findings" ? <FindingsList watchId={watchId} findings={detail.findings} threshold={threshold} onChanged={refetch} /> : null}
      {tab === "evidence" ? <EvidenceTimeline watchId={watchId} /> : null}
      {tab === "coverage" ? <Coverage d={detail} /> : null}
      {tab === "requirements" ? <Requirements d={detail} /> : null}
      {tab === "reviews" ? <Reviews d={detail} /> : null}
    </div>
  );
}

function EvidenceTimeline({ watchId }: { watchId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [cards, setCards] = useState<CardView[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = useCallback(
    (before?: number) =>
      rpc.call("watchEvidence", { watchId, limit: 30, ...(before !== undefined ? { beforeSeq: before } : {}) }).then(
        (r) => {
          setCards((prev) => (before === undefined ? r.cards : [...(prev ?? []), ...r.cards]));
          setNext(r.nextBeforeSeq);
        },
        (e) => toast.error(errorText(e)),
      ),
    [rpc, watchId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("advisor.changed", () => void load());
  if (!cards) return <Empty>Loading evidence…</Empty>;
  if (cards.length === 0) return <Empty>No evidence yet. Cards appear as the watched thread completes items and turns.</Empty>;
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {cards.map((c) => (
          <li key={c.id} className="rounded-lg border border-border bg-card px-3 py-2">
            <button className="flex w-full cursor-pointer items-center gap-2 text-left" onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))} aria-expanded={!!open[c.id]}>
              <span className="font-mono text-xs text-muted-foreground">#{c.seq}</span>
              <span className="text-xs font-medium">{c.kind}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.path ?? c.text.split("\n")[0]}</span>
              {c.reviewed ? <Chip tone="muted">reviewed</Chip> : c.judge ? <Chip>unreviewed</Chip> : null}
              {c.badges.map((b) => (
                <Chip key={b} tone={b.startsWith("no edit event") || b.startsWith("exit") ? "danger" : "neutral"}>
                  {b}
                </Chip>
              ))}
            </button>
            {open[c.id] ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{c.text}</pre> : null}
          </li>
        ))}
      </ul>
      {next !== null ? (
        <Button size="sm" variant="ghost" onClick={() => void load(next)}>
          Load older
        </Button>
      ) : null}
    </div>
  );
}

function Coverage({ d }: { d: Detail }) {
  const s = d.summary;
  const layers = ["observation", "evidence", "requirements", "judgment"] as const;
  return (
    <div className="space-y-4">
      <Section title="What the Advisor could see">
        <ul className="space-y-1 text-sm">
          <li>
            Observed from #{s.startSeq ?? "?"}; read through #{s.cursor ?? "–"} of #{s.tip ?? "–"} ({s.atTip ? "at the tip" : "behind"}), last read {ago(s.lastDrainAt)}.
          </li>
          <li>
            Requirement coverage: <strong>{d.requestCoverage}</strong>
            {d.requestCoverage === "partial" ? " — missed-requirement findings are disabled and findings carry a partial-context badge." : ""}
          </li>
          {d.pending.length > 0 ? <li>Instructions awaiting a receipt (hold review): {d.pending.join(", ")}</li> : null}
          {d.requestGaps.map((g) => (
            <li key={g} className="text-muted-foreground">
              Request record gap: {g}
            </li>
          ))}
          {d.requestNotes.map((g) => (
            <li key={g} className="text-muted-foreground">
              Provenance note: {g}
            </li>
          ))}
        </ul>
      </Section>
      {layers.map((layer) => {
        const gaps = d.gaps.filter((g) => g.layer === layer);
        if (gaps.length === 0) return null;
        return (
          <Section key={layer} title={`${layer[0]!.toUpperCase()}${layer.slice(1)} gaps`}>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
              {gaps.map((g) => (
                <li key={g.id} className="flex flex-wrap gap-2 px-3 py-1.5">
                  <span className="font-mono text-xs">{g.reason}</span>
                  {g.fromSeq !== null ? (
                    <span className="text-xs text-muted-foreground">
                      #{g.fromSeq}
                      {g.toSeq !== null && g.toSeq !== g.fromSeq ? `–#${g.toSeq}` : ""}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">{g.detail}</span>
                </li>
              ))}
            </ul>
          </Section>
        );
      })}
    </div>
  );
}

function Requirements({ d }: { d: Detail }) {
  return (
    <div className="space-y-4">
      <Section title="Sent to the reviewer">
        {d.requirements.length === 0 ? (
          <Empty>No accepted instructions with current or historic authority.</Empty>
        ) : (
          <ul className="space-y-2">
            {d.requirements.map((r) => (
              <li key={r.ref} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <div className="mb-1 flex flex-wrap gap-1">
                  <span className="font-mono text-xs">{r.ref}</span>
                  <Chip tone={r.historic ? "muted" : "strong"}>{r.label}</Chip>
                  {r.historic ? <Chip tone="muted">context only</Chip> : null}
                </div>
                <p className="whitespace-pre-wrap break-words">{r.text.length > 1200 ? `${r.text.slice(0, 1200)}…` : r.text}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {d.panelOnly.length > 0 ? (
        <Section title="Shown here only (authority not proven)">
          <ul className="text-sm text-muted-foreground">
            {d.panelOnly.map((p) => (
              <li key={p.ref}>
                {p.ref} from {p.sender ?? "no sender"} ({p.class})
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <p className="text-xs text-muted-foreground">No label says “user”: a request without a sender thread is “UNATTRIBUTED: user or plugin”.</p>
    </div>
  );
}

function Reviews({ d }: { d: Detail }) {
  if (d.reviews.length === 0) return <Empty>No reviews yet.</Empty>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
      {d.reviews.map((r) => (
        <li key={r.id} className="space-y-0.5 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{r.id}</span>
            <Chip tone={r.state === "current" ? "strong" : r.state === "failed" ? "danger" : "neutral"}>{r.state}</Chip>
            <span className="text-xs text-muted-foreground">{r.route}</span>
            {r.preview ? <Chip tone="danger">preview</Chip> : null}
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground">{ago(r.createdAt)}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {r.cards} cards{r.outcome ? ` · outcome ${r.outcome}` : ""}
            {r.accepted !== null ? ` · ${r.accepted} stored` : ""}
            {r.dropped ? ` · ${r.dropped} dropped by validation` : ""}
            {r.resolvedDropped ? ` · ${r.resolvedDropped} resolved notes without proof` : ""}
            {r.heldAt !== null && r.state === "held" ? ` · held ${ago(r.heldAt)}, rechecked from the paid result${r.checkedAt ? ` (last ${ago(r.checkedAt)})` : ""}` : ""}
            {r.error ? ` · ${r.error}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}
