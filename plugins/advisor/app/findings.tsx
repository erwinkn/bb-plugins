// Findings with their exact citations and honest actions.
//
// "Mark seen" is a local mark (caller unverified), not a review or sign-off.
// "Mute" on a verified subject suppresses recurrences; on an unverified one it
// covers only the occurrences already recorded. "Dismiss" reopens on any new
// occurrence. Nothing here closes an issue because tests pass.

import { useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { FindingView } from "../src/views";
import type { OpenedEvidence } from "../src/rpc";
import { Button } from "@/components/ui/button";
import { Chip, Empty, Excerpt, HintButton, Severity, ago, errorText } from "./ui";

const RANK: Record<string, number> = { note: 0, unrated: 1, concern: 1, critical: 2 };

export function FindingsList({ watchId, findings, threshold, onChanged }: { watchId: string; findings: FindingView[]; threshold: string; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [showBelow, setShowBelow] = useState(false);
  const [showCleared, setShowCleared] = useState(false);
  const visible = findings.filter((f) => (showBelow || (RANK[f.severity] ?? 0) >= (RANK[threshold] ?? 0)) && (showCleared || !f.cleared));
  const hiddenBelow = findings.filter((f) => (RANK[f.severity] ?? 0) < (RANK[threshold] ?? 0)).length;
  const seen = findings.filter((f) => f.acknowledgedAt !== null && !f.cleared).length;
  const act = (p: Promise<unknown>) => p.then(onChanged, (e) => toast.error(errorText(e)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={showBelow} onChange={(e) => setShowBelow(e.target.checked)} />
          Show below “{threshold}” ({hiddenBelow})
        </label>
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={showCleared} onChange={(e) => setShowCleared(e.target.checked)} />
          Show cleared
        </label>
        <span className="flex-1" />
        <HintButton size="sm" variant="ghost" disabled={seen === 0} onClick={() => act(rpc.call("findingsClearAcknowledged", { watchId }))} hint="Hides findings marked seen from this list. They stay stored, and a recurrence still alerts.">
          Clear seen ({seen})
        </HintButton>
      </div>
      {visible.length === 0 ? (
        <Empty>No findings to show. No finding is not a verdict: check Coverage for what was not judged.</Empty>
      ) : (
        <ul className="space-y-3">
          {visible.map((f) => (
            <FindingCard key={f.id} f={f} watchId={watchId} act={act} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One finding. The feed adds its thread (`context`) and Discuss (`extra`); the watch view needs neither. */
export function FindingCard({ f, watchId, act, context, extra }: { f: FindingView; watchId: string; act: (p: Promise<unknown>) => void; context?: ReactNode; extra?: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [opened, setOpened] = useState<OpenedEvidence | null>(null);
  const c = f.citation;
  const muted = f.issueState === "muted";
  return (
    <li className="space-y-2 rounded-lg border border-border bg-card p-3">
      {context}
      <div className="flex flex-wrap items-center gap-2">
        <Severity severity={f.severity} />
        <span className="text-xs text-muted-foreground">{f.category}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.locator}>
          {f.subject}
        </span>
        <Chip tone={f.subjectStatus === "verified" ? "strong" : "neutral"} title="Whether the test subject is proven from the hunk itself">
          {f.subjectStatus === "verified" ? "subject verified" : f.subjectStatus}
        </Chip>
        {f.issueState && f.issueState !== "open" ? <Chip>{f.issueState === "model-reported-resolved" ? "model reported resolved (not proof)" : f.issueState}</Chip> : null}
        {f.acknowledgedAt === null ? <Chip tone="strong">new</Chip> : <Chip tone="muted">seen {ago(f.acknowledgedAt)}</Chip>}
      </div>
      {f.claimedSubject ? <p className="text-xs text-muted-foreground">Claimed subject (unverified): {f.claimedSubject}</p> : null}
      {c.requirement ? (
        <p className="text-xs">
          <span className="text-muted-foreground">Requirement {c.requirement.ref}{c.requirement.status ? ` (${c.requirement.status})` : ""}: </span>“{c.requirement.quote}”
        </p>
      ) : null}
      <div className="grid gap-2 md:grid-cols-2">
        {c.before ? <Excerpt label={`Before · ${c.before.path ?? ""}`} lines={c.before.lines} text={c.before.text} mark="-" /> : null}
        {c.after ? <Excerpt label={`After · ${c.after.path ?? ""}`} lines={c.after.lines} text={c.after.text} mark="+" /> : null}
        {c.claim ? <Excerpt label="Claim" text={c.claim} mark=" " /> : null}
        {c.command ? <Excerpt label="Command evidence" text={c.command} mark=" " /> : null}
      </div>
      <p className="text-sm">{f.summary}</p>
      <div className="flex flex-wrap gap-1">
        {f.badges.map((b) => (
          <Chip key={b} tone={b.startsWith("fake") || b.startsWith("preview") ? "danger" : "neutral"}>
            {b}
          </Chip>
        ))}
        {f.score !== null ? <Chip title="Jev's probability for one yes/no question; not a confidence">score {f.score.toFixed(2)}</Chip> : null}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {f.route}
        {f.model ? ` · ${f.model}` : ""} · review {f.reviewId} · as of #{f.asOfSeq ?? "?"} · {ago(f.createdAt)}
      </div>
      <div className="flex flex-wrap gap-1">
        {f.acknowledgedAt === null ? (
          <HintButton size="sm" variant="outline" onClick={() => act(rpc.call("findingAcknowledge", { occurrenceId: f.id }))} hint="A local mark in this panel. Not a review, not sign-off; the caller is not verified.">
            Mark seen
          </HintButton>
        ) : null}
        {/* A preview has no issue: muting or dismissing it would change the real issue at that locator. */}
        {f.preview ? null : (
        <HintButton
          size="sm"
          variant="ghost"
          onClick={() => act(rpc.call("issueSetState", { watchId, category: f.category, locator: f.locator, state: muted ? "open" : "muted" }))}
          hint={f.subjectStatus === "verified" ? "Suppress alerts for this verified test" : "Unverified subject: the mute covers only occurrences already recorded"}
        >
          {muted ? "Unmute" : f.subjectStatus === "verified" ? "Mute test" : "Mute these occurrences"}
        </HintButton>
        )}
        {!f.preview && f.issueState !== "dismissed-unverified" ? (
          <HintButton size="sm" variant="ghost" onClick={() => act(rpc.call("issueSetState", { watchId, category: f.category, locator: f.locator, state: "dismissed-unverified" }))} hint="Display only. A new occurrence reopens it and alerts.">
            Dismiss
          </HintButton>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (opened) setOpened(null);
            else rpc.call("findingOpen", { occurrenceId: f.id }).then(setOpened, (e) => toast.error(errorText(e)));
          }}
        >
          {opened ? "Hide evidence" : "Open evidence"}
        </Button>
        {extra}
      </div>
      {opened ? (
        <div className="space-y-1">
          {opened.label ? <p className="text-xs text-muted-foreground">{opened.label}</p> : null}
          {opened.card ? <Excerpt label={`Card ${opened.card.id}${opened.card.path ? ` · ${opened.card.path}` : ""}`} text={opened.card.text} mark=" " /> : <pre className="overflow-auto font-mono text-xs">{JSON.stringify(opened.retained, null, 1).slice(0, 4000)}</pre>}
        </div>
      ) : null}
    </li>
  );
}
