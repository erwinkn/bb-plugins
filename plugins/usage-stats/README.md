# Usage stats

`usage-stats` adds a **Usage** page (`/plugins/usage-stats/usage`) with token
consumption, fixed weighted comparisons, API-price dollar equivalents, cache hit rates, warming economics and quota history, from
the Account Pooler's request ledger.

## What the page shows

One row of controls scopes everything below it:

- **Range:** last 24 hours, 7 days, 30 days, or custom dates. **Resolution:**
  hourly or daily, on the browser's calendar: the browser sends its IANA time
  zone, and the server lays out local hours and days (23 or 25 hours across a
  DST change) and asks the Pooler for exactly those buckets.
- **Measure:** Tokens (the default), Input-equivalent or API price. It sets the
  headline figure, the chart, the breakdowns' main column and share, what the
  breakdowns and the chart's top series rank by, and (for API price) the
  warming figures.
- **Filters:** provider, model, account, role, project, Initiative. Clicking a
  row in a breakdown table applies it as a filter; clicking a thread opens it.

Every control is remembered in the browser (localStorage), so returning to the
page restores the view: range, resolution, measure, filters and the chart's
split and measure-or-requests toggle. A relative range (24 hours, 7 days, 30
days) stays relative and ends at the time of the visit; a custom range keeps
its dates. "Clear filters" appears while any filter is set.

Then:

- **Totals:** tokens processed, input-equivalents or API-price dollars (by the
  measure), requests (with warming refreshes), cache hit rate, cold rewrites,
  warming net savings, errors (429 and 529 counts).
- **Usage over time (tokens, input-equivalents or API dollars):** stacked
  columns per hour or day, by token type, model, account, role or provider
  (top five, the rest as Other), switchable to requests. A cache hit-rate line sits under it on the same columns.
- **Breakdowns:** by model, account, role, project, Initiative, provider, and
  the top 30 threads with their project and Initiative member (W#). Each row
  has requests, tokens, input-equivalents or API dollars and share, hit rate and cold rewrites.
- **Cache and warming:** resumes after a cache entry expired, split into cold
  rewrites, rewrites a refresh avoided and entries warm without one; refresh
  cost, savings and net, in dollars on the API price measure and in
  input-equivalents otherwise.
- **Reliability:** failures, 429s, 529s, mean request time, requests without
  token counts.
- **Quota by account:** utilization of each account's windows over the range
  (Claude: 7d and per-family weekly; Codex: 5h and weekly), one chart per
  account, with ticks where a window reset. The account and provider filters
  narrow it; quota is account-wide, so the other filters cannot, and the page
  says so when one is set.

**Tokens** (tokens processed) counts every token once: uncached input, cache reads,
cache writes and output, as a provider's token counter would. Cache reads
dominate it, so it runs several times larger than the weighted comparison.

**Input-equivalent** uses the Pooler's fixed, model-agnostic token weights:
input 1×, cache read 0.1×, 5m cache write 1.25×, 1h cache write 2×,
output 5×. The weights stay fixed for historical comparisons; they measure
neither current per-model API prices nor subscription debit. The page states
the weights it was given. The stored measure identifier remains `cost` for
compatibility.

**API price** is what the same usage would cost at each provider's public API
list prices, per model and token type: an equivalent, not the subscription
bill. Unpriced usage is never shown as $0: the headline reads
"$123.40 + 2.1M tokens unpriced (codex-auto-review)", and a breakdown row shows
"–" when none of its usage has a price, or a "+" after its dollars when only
part has. A warming refresh costs its own tokens at its model's prices. A
rewrite it avoided saves the write the resume would have paid minus the read
it paid. The Pooler reports that saving in its fixed weights only. Its 5m and 1h
write weights differ, so the server can recover how many of the avoided tokens
were 1h writes, then price them.

The prices live in one table, `src/prices.ts`: USD per million tokens, standard
tier, global routing, each entry with its source and the date checked
(2026-11-12):

| Models | Input | Cache read | 5m / 1h write | Output | Source |
| --- | --- | --- | --- | --- | --- |
| Fable 5.2 | 8 | 0.20 | 10 / 16 | 40 | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| Fable 5.1 | 10 | 0.25 | 12.50 / 20 | 50 | Anthropic |
| Fable 5 | 10 | 1 | 12.50 / 20 | 50 | Anthropic |
| Opus 5.5 | 4 | 0.20 | 5 / 8 | 20 | Anthropic |
| Opus 5, 4.8, 4.7, 4.6 | 5 | 0.50 | 6.25 / 10 | 25 | Anthropic |
| Sonnet 5.5 | 2 | 0.10 | 2.50 / 4 | 10 | Anthropic |
| Sonnet 5 | 2 | 0.20 | 2.50 / 4 | 10 | Anthropic |
| Sonnet 4.6 | 3 | 0.30 | 3.75 / 6 | 15 | Anthropic |
| Haiku 5.5 (prompts to 100K) | 0.10 | 0.01 | 0.125 / 0.20 | 0.50 | Anthropic |
| Haiku 4.5 | 1 | 0.10 | 1.25 / 2 | 5 | Anthropic |
| GPT-6 Astra | 10 | 1 | – | 50 | [OpenAI](https://developers.openai.com/api/docs/pricing) |
| GPT-6.1 Sol | 2 | 0.10 | – | 10 | OpenAI |
| GPT-6.1 Terra | 1 | 0.05 | – | 5 | OpenAI |
| GPT-6 Sol | 2 | 0.20 | – | 10 | OpenAI |
| GPT-6 Luna | 0.10 | 0.01 | – | 0.50 | OpenAI |
| GPT-5.6 Terra | 2 | 0.20 | – | 12 | OpenAI |
| GPT-5.6 Luna | 0.20 | 0.02 | – | 1.20 | OpenAI |

OpenAI's prices are its short-context ones (prompts up to 272K tokens). Its
30m and 12h cache writes need no price: Codex reports its writes as uncached
input, and the Pooler records them so. Models missing from the table, such as
`codex-auto-review` and Codex requests the Pooler recorded without a model,
count as unpriced. To add or update a price, edit the table from the
provider's pricing page and change `PRICES_CHECKED`.

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
plugin's read-only context routes. Both take seconds (BB answers thread reads
one at a time, about 4,000 of them for 30 days; Initiative membership is about
10,000 members), so they are cached in memory and a page only waits for names
it has never had. Thread names are read again after ten minutes, Initiative
membership after one, in the background: the page that finds them stale still
gets the cached ones. A thread BB reports missing (404) is "Deleted thread";
one BB could not answer for shows its id for that page and is asked again on
the next. A failed membership read keeps the last one.

The Pooler's three reads (`status.get`, `usage.stats`, `usage.quota`) start
together.

A page makes one `usage.stats` call when no filter is set, and two otherwise:
the second, unfiltered, lists what each filter can choose. A project or
Initiative filter becomes a thread filter, since the ledger has no projects.
Every group is also read by model, so each row can be priced at its model's
prices, and the total by kind too, so a refresh's cost can be told apart (the
Pooler allows 3 dimensions per group). The server folds the rows back to the
group's own key, so the page receives sums with their dollars; the refresh cost
is known on the total only.

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
  before 8 Oct 2026, so those count as requests and add no tokens or input-equivalents.
- **Tiered prices.** Haiku 5.5 prompts over 100K tokens cost 5× its base
  price, and OpenAI prompts over 272K tokens cost 2× on input and 1.5× on output. The ledger's hourly
  sums do not keep each request's prompt length, so the page prices all of it
  at the base price: those dollars are a floor. For Haiku 5.5 the floor can sit
  far below the real figure: on this ledger in November 2026, 85% of its tokens
  came in prompts over 100K, and priced request by request its 30 days cost
  about $527 against the $133 shown. Codex is off by about 1%. Pricing it
  exactly needs the Pooler to sum long-context requests apart. Fast mode (Claude) and
  priority or fast tiers (OpenAI) are not recorded either, so standard prices
  apply throughout.
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
