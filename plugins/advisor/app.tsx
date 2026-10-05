// BB Advisor frontend: the Advisor page, a thread side panel, the Settings
// section and a notification listener. Data comes from server.ts over RPC;
// realtime signals only prompt a refetch.

import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import type { WatchSummary } from "./src/views";
import { Button } from "@/components/ui/button";
import { AdvisorPage, PANEL_PATH, useOverview } from "./app/page";
import { SettingsPanel } from "./app/settings";
import { Empty, errorText } from "./app/ui";
import { WatchView } from "./app/watch";

function ThreadPanel({ threadId }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const { o } = useOverview();
  const [watch, setWatch] = useState<WatchSummary | null | undefined>(undefined);
  const refetch = useCallback(() => {
    rpc.call("threadStatus", { threadId }).then((r) => setWatch(r.watch), (e) => toast.error(errorText(e)));
  }, [rpc, threadId]);
  useEffect(() => refetch(), [refetch]);
  useRealtime("advisor.changed", refetch);
  if (watch === undefined) return <Empty>Loading…</Empty>;
  if (watch === null) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">This thread is not watched. Watching reads its events and environment to keep evidence; it never sends messages to the thread or changes its files. Reviews run only if they are turned on in Settings.</p>
        <Button size="sm" onClick={() => rpc.call("watchAdd", { threadId }).then(refetch, (e) => toast.error(errorText(e)))}>
          Watch this thread
        </Button>
      </div>
    );
  }
  return <WatchView watchId={watch.id} threshold={o?.severityThreshold ?? "concern"} compact />;
}

/** Toasts for new findings, only when the notification policy asks for them. */
function Notifier() {
  useRealtime("advisor.notify", (payload) => {
    const n = payload as { toast?: boolean; severity?: string; summary?: string; reason?: string };
    if (!n?.toast) return;
    const title = `Advisor · ${n.severity ?? "finding"}${n.reason && n.reason !== "new" ? ` (${n.reason})` : ""}`;
    toast(title, { description: String(n.summary ?? "").slice(0, 240) });
  });
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "advisor",
    title: "Advisor",
    icon: "SecurityCheck",
    path: PANEL_PATH,
    component: AdvisorPage,
    // The one Advisor entry is the Sidebar plugin's row above Initiatives, with the live count
    // (T106). This registration is what serves the page's URL: hide its host row with BB's
    // "Hide from sidebar"; the URL and the Sidebar row keep working.
  });
  app.slots.threadPanelAction({
    id: "advisor-thread",
    title: "Advisor",
    component: ThreadPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Advisor" });
    },
  });
  app.slots.settingsSection({
    id: "advisor-state",
    title: "Effective state",
    description: "What the settings above mean right now: errors, routes, budgets and what is not available yet.",
    component: SettingsPanel,
  });
  app.slots.experimental_appOverlay({ id: "advisor-notifier", component: Notifier });
});
