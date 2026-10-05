// Settings → Advisor: the effective state below the host-rendered form.
// Shows what each choice means now, every cross-field error, which secrets
// are set (never their values), route facts that are still unverified,
// stages that do not exist yet, and the settings change log.

import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { SettingsView } from "../src/rpc";
import { Chip, Empty, Section, ago, errorText } from "./ui";

export function SettingsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [v, setV] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("settingsView").then(setV, (e) => setError(errorText(e)));
  }, [rpc]);
  useEffect(() => refetch(), [refetch]);
  useRealtime("advisor.changed", refetch);
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!v) return <Empty>Loading…</Empty>;
  const e = v.effective as Record<string, any>;
  return (
    <div className="space-y-5">
      <Section title="Effective state">
        <div className="flex flex-wrap gap-1">
          <Chip tone={e.observationEnabled ? "strong" : "neutral"}>observation {e.observationEnabled ? "on" : "off"}</Chip>
          <Chip tone={e.reviewEnabled ? "strong" : "neutral"}>reviews {e.reviewEnabled ? "on" : "off"}</Chip>
          <Chip tone={e.providerRequestsEnabled ? "danger" : "neutral"}>provider requests {e.providerRequestsEnabled ? "allowed" : "off"}</Chip>
          <Chip>route {String(e.route)}</Chip>
          <Chip>budget day: {String(e.budgets?.timeZone)}</Chip>
        </div>
        {v.errors.review.length + v.errors.observation.length === 0 ? (
          <p className="text-xs text-muted-foreground">No configuration errors.</p>
        ) : (
          <ul className="space-y-1">
            {[...v.errors.review.map((x) => `Reviews: ${x}`), ...v.errors.observation.map((x) => `Observation: ${x}`)].map((x) => (
              <li key={x} role="alert" className="text-sm text-destructive">
                {x}
              </li>
            ))}
          </ul>
        )}
        {v.notes.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}
      </Section>
      <Section title="Routes">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-normal">Route</th>
                <th className="py-1 pr-2 font-normal">Model</th>
                <th className="py-1 pr-2 font-normal">Billing</th>
                <th className="py-1 font-normal">Needs / unverified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {v.routes.map((r) => (
                <tr key={r.id} className={r.id === e.route ? "font-medium" : undefined}>
                  <td className="py-1.5 pr-2 font-mono">{r.id}</td>
                  <td className="py-1.5 pr-2 font-mono">{r.model ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    {r.billing}
                    {r.price ? ` · ≤$${r.price.inMax}/$${r.price.out} per MTok (${r.price.version})` : ""}
                  </td>
                  <td className="py-1.5 text-muted-foreground">
                    {[r.secret ? `${r.secret} ${v.secrets[r.secret] ? "set" : "not set"}` : null, ...r.unverified, r.categories.length < 3 ? `judges ${r.categories.join(", ")} only` : null]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Account Pooler advisor routes: {v.pooler.detail}</p>
        <p className="text-xs text-muted-foreground">Every route sends at most one request per review, never retries and never falls back to another model, route or account.</p>
      </Section>
      <Section title="Not available yet">
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>{v.initiativeContext}</li>
          {v.deferred.map((d) => (
            <li key={d.id}>
              {d.label}: {d.status}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Change log">
        {v.settingsLog.length === 0 ? (
          <Empty>No changes recorded.</Empty>
        ) : (
          <ul className="divide-y divide-border text-xs">
            {v.settingsLog.map((l, i) => (
              <li key={i} className="flex gap-2 py-1">
                <span className="text-muted-foreground">{ago(l.at)}</span>
                <span className="text-muted-foreground">rev {l.settingsRev}</span>
                <span className="min-w-0 flex-1 break-words">{l.summary}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Tamper evidence, not prevention: BB does not authenticate who changed a setting.</p>
      </Section>
    </div>
  );
}
