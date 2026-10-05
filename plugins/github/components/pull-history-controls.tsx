import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { PageState } from "./use-pull-detail";
import { EXTERNAL_ATTRIBUTE } from "../lib/link-interception";
import { Button } from "./ui/button";

const externalLink = { [EXTERNAL_ATTRIBUTE]: "" } as const;

export function PullHistoryControls({ label, state, count, onLoad, url }: { label: string; state: PageState; count: number; onLoad: () => void; url: string }) {
  const noun = count === 1 ? label.toLowerCase().replace(/s$/, "") : label.toLowerCase();
  return <div className="flex flex-col gap-2 text-xs text-muted-foreground" aria-label={`${label} history`}>
    {state.loaded ? <p>{count} {noun} loaded{state.nextPage !== null ? ", more available" : state.limitation !== null ? ", GitHub limit reached" : ", no more pages reported"}.</p> : null}
    {state.error !== null ? <p role="alert">Could not load {label.toLowerCase()}: {state.error}{state.loaded ? " Previously loaded entries remain below." : ""}</p> : null}
    {state.limitation !== null ? <p>{state.limitation} <UrlLink href={url} className="underline" {...externalLink}>View on GitHub</UrlLink></p> : null}
    {state.nextPage !== null ? <Button size="sm" variant="outline" className="self-start" disabled={state.loading} onClick={onLoad}>{state.loading ? `Loading ${label.toLowerCase()}…` : state.error !== null ? `Retry ${label.toLowerCase()}` : state.loaded ? `Load more ${label.toLowerCase()}` : `Load ${label.toLowerCase()}`}</Button> : null}
  </div>;
}
