import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { projectsContract } from "./lib/contract";
import type { PrWatchView } from "./lib/pr-watch";
import { adventuresQueryClient } from "./lib/query";
import { prWatchQuery, queryKeys, useQuerySync } from "./lib/queries";
import { compactAge } from "./control-room";

const STATES: Record<PrWatchView["wakes"][number]["state"], string> = {
  pending: "waiting to send", sending: "sending", sent: "sent", stale: "skipped", muted: "skipped: muted",
  failed: "not sent", uncertain: "may not have arrived",
};

/** W548, W554: one PR's watch in its detail panel: who watches it, and the latest wakes. Agents watch with initiative_pr_watch. */
export function PrWatch({ projectId, url }: { projectId: string; url: string }) {
  return (
    <QueryClientProvider client={adventuresQueryClient()}>
      <WatchSection projectId={projectId} url={url} />
    </QueryClientProvider>
  );
}

function WatchSection({ projectId, url }: { projectId: string; url: string }) {
  useQuerySync();
  const api = useRpc<typeof projectsContract>();
  const client = useQueryClient();
  const watch = useQuery(prWatchQuery(api, projectId, url));
  // The PR travels with the mutation: the panel may show another PR by the time it answers.
  const unwatch = useMutation({
    mutationFn: (input: { projectId: string; url: string }) => api.call("prUnwatch", input),
    onSuccess: (view, input) => client.setQueryData(queryKeys.prWatch(input.projectId, input.url), view),
  });
  const mine = unwatch.variables?.url === url && unwatch.variables.projectId === projectId;
  const view = watch.data;
  const who = view?.watcher ? `${view.watcher.label}${view.watcher.projectId === projectId ? "" : ` (${view.watcher.adventure})`}` : null;
  const status = !view
    ? watch.error ? `Couldn't read the watch: ${watch.error.message}` : "Loading…"
    : view.ended ? `${view.ended === "MERGED" ? "Merged" : "Closed"}: the watch ended.`
    : !who ? "Not watched. An agent watches a PR with initiative_pr_watch; changes on GitHub then wake it."
    : view.commentWakes >= view.commentCap ? `Watched by ${who}. Comments stopped waking it after ${view.commentCap} comment-only wakes in a row; news about checks, a conflict or a push wakes it again.`
    : `Watched by ${who}: failing or passing checks, new comments and reviews, conflicts and missing checks wake it.`;
  return (
    <section className="cr-pd-section cr-pd-watch" aria-label="Watch" aria-busy={watch.isFetching || (mine && unwatch.isPending)}>
      <h4>
        Watch
        {who && !view?.ended ? (
          <button type="button" className="cr-pm-more cr-pd-watch-toggle" disabled={mine && unwatch.isPending}
            title={`Stop waking ${who} on GitHub changes`}
            onClick={() => unwatch.mutate({ projectId, url })}>
            Unwatch
          </button>
        ) : null}
      </h4>
      <p className="cr-pd-watch-status" data-off={!who || !!view?.ended || undefined}>{status}</p>
      {mine && unwatch.error ? <p className="cr-mq-note" role="status">Couldn't unwatch: {unwatch.error.message}</p> : null}
      {view?.wakes.length ? (
        <ul>
          {view.wakes.map((wake) => (
            <li key={`${wake.at}-${wake.head}`} className="cr-pd-item">
              <span className="cr-pd-line">
                <span className="cr-pd-name">{wake.changes.join(" ")}</span>
                <span className="cr-pd-when"><time dateTime={new Date(wake.at).toISOString()} title={new Date(wake.at).toLocaleString()}>{compactAge(wake.at)}</time></span>
              </span>
              <span className="cr-pd-line">
                <span className="cr-pd-status" data-status={wake.state === "sent" ? "succeeded" : wake.state === "failed" ? "failed" : undefined}>{STATES[wake.state]}</span>
                {wake.routed ? <span className="cr-pd-via">{wake.routed}</span> : null}
                <code className="cr-pd-via">{wake.head.slice(0, 7)}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
