# Usage stats

`usage-stats` adds a **Usage** page (`/plugins/usage-stats/usage`) with token
consumption, cost, cache hit rates, warming economics and quota history, from
the Account Pooler's request ledger.

## What the page shows

One row of controls scopes everything below it:

- **Range:** last 24 hours, 7 days, 30 days, or custom dates. **Resolution:**
  hourly or daily, on the browser's calendar: the browser sends its IANA time
  zone, and the server lays out local hours and days (23 or 25 hours across a
  DST change) and asks the Pooler for exactly those buckets.
- **Measure:** Tokens (the default) or Cost. It sets the headline figure, the
  chart and the breakdowns' main column, and what the breakdowns and the
  chart's top series rank by.
- **Filters:** provider, model, account, role, project, Initiative. Clicking a
  row in a breakdown table applies it as a filter; clicking a thread opens it.

Every control is remembered in the browser (localStorage), so returning to the
page restores the view: range, resolution, measure, filters and the chart's
split and measure-or-requests toggle. A relative range (24 hours, 7 days, 30
days) stays relative and ends at the time of the visit; a custom range keeps
its dates. "Clear filters" appears while any filter is set.

Then:

- **Totals:** tokens processed or cost (by the measure), requests (with warming
  refreshes), cache hit rate, cold rewrites, warming net savings, errors (429
  and 529 counts).
- **Tokens or cost over time:** stacked columns per hour or day, by token type, model,
  account, role or provider (top five, the rest as Other), switchable to
  requests. A cache hit-rate line sits under it on the same columns.
- **Breakdowns:** by model, account, role, project, Initiative, provider, and
  the top 30 threads with their project and Initiative member (W#). Each row
  has requests, tokens or cost and share, hit rate and cold rewrites.
- **Cache and warming:** resumes after a cache entry expired, split into cold
  rewrites, rewrites a refresh avoided and entries warm without one; refresh
  cost, savings and net.
- **Reliability:** failures, 429s, 529s, mean request time, requests without
  token counts.
- **Quota by account:** 5h, 7d and per-family weekly utilization over the
  range, one chart per account, with ticks where a window reset. The account
  and provider filters narrow it; quota is account-wide, so the other filters
  cannot, and the page says so when one is set.

**Tokens** (tokens processed) counts every token once: uncached input, cache reads,
cache writes and output, as a provider's token counter would. Cache reads
dominate it, so it runs several times larger than cost.

**Cost** is in input-equivalent tokens, the Pooler's weights at API price
ratios to uncached input: input 1×, cache read 0.1×, 5-minute cache write
1.25×, 1-hour cache write 2×, output 5×. It is the closest public proxy for
subscription quota, not a bill. The page states the weights it was given.

**Cache hit rate** is cache reads over all prompt tokens (uncached input, cache
reads and writes) of native Claude requests; warming refreshes are left out.

## Where the numbers come from

Everything comes from the Account Pooler (`account-pool-local`) over two
read-only RPCs, `usage.stats` and `usage.quota`, plus `status.get` for account
names. This plugin never opens the Pooler's database. The Pooler answers from
an hourly rollup of its ledger (see the Pooler README, "Usage statistics"),
so a 30-day page costs one index range scan.

Names come from BB: thread titles and projects (`threads.get`,
`projects.list`), and Initiatives and their members from the Initiatives
plugin's read-only context routes. Thread names are cached for ten minutes,
Initiative membership for one. A thread BB reports missing (404) is "Deleted
thread"; one BB could not answer for shows its id for that page and is asked
again on the next.

A page makes one `usage.stats` call when no filter is set, and two otherwise:
the second, unfiltered, lists what each filter can choose. A project or
Initiative filter becomes a thread filter, since the ledger has no projects.

### Limits

- **Hourly resolution.** The Pooler sums whole UTC hours. A range starts at
  the hour that holds its start, and in a zone with a half-hour offset each
  bucket gains the half hour before it and loses its last; totals and the
  chart still agree.
- **The last half hour is provisional.** Requests are final once no earlier
  request can still complete (30 minutes, or longer while a request is still
  streaming); until then the Pooler classifies them afresh on every page load.
- **First build.** Right after the Pooler starts with a large ledger, its rollup
  can be more than 10,000 requests behind. The page then says it is still
  counting and asks again every 3 seconds until it is done. Refresh always asks
  again, even for an unchanged range.
- **Unlinked requests.** Requests the Pooler could not link to a thread (Claude
  Code helpers without a session, and sessions recorded before the Pooler linked
  every session, 7 Oct) show as "Not linked to a thread" and "Unattributed".
  `bb pool-local usage relink` links the old sessions BB can attribute.
- **Codex tokens.** The Pooler recorded Codex requests without token counts
  before 8 Oct 2026, so those count as requests and add no tokens or cost.
- **Start of data.** The ledger starts when the Pooler began logging; a range
  that reaches further back has no data before then, and the footer says so.
- **Retention.** The ledger keeps 30 days by default
  (`bb pool-local usage retention`).

## Install

```sh
cd plugins/usage-stats
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/usage-stats --yes
```

It needs the Account Pooler with the `usage.stats` and `usage.quota` RPCs;
without it, the page says so. Initiatives is optional.

## Charts

The two charts (`app/charts.tsx`) are plain SVG, about 350 lines, with no
charting library. Series colors are the dataviz reference categorical palette
in its validated order (`app.css`), checked against BB's light and dark
canvases. In light mode, aqua, yellow and magenta are under 3:1 contrast, so
every chart has a legend with values and the tables carry the same numbers.
