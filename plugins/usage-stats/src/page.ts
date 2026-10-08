import { bucketEnd, bucketStarts } from "./calendar";
import type { Directory, Membership, ThreadInfo } from "./directory";
import type { Label, Metrics, OkPage, Page, PageInput, Row } from "./model";
import { addMetrics, amount, emptyMetrics, OTHER_ID, type FilterDimension, type Measure } from "./shared";
import type { Pooler, PoolerDimension, PoolerStatsInput, PoolerStatsRow } from "./pooler";

// Builds the Usage page from the Account Pooler's sums and BB's names. Every number comes from
// one usage.stats call over the filtered slice; a second, unfiltered call lists what the filters
// can choose from. Projects and Initiatives are not in the ledger: they come from each thread, so
// their breakdowns are sums of thread rows, and their filters become thread filters.

const TOP_THREADS = 30;
const TOP_SERIES = 6;
const QUOTA_POINTS = 300;
const RESET_JITTER_MS = 10 * 60_000;

export interface PageDeps {
  pooler: Pooler;
  directory: Directory;
  now: () => number;
}

type LedgerDimension = Extract<FilterDimension, "provider" | "model" | "account" | "role">;
const LEDGER_DIMENSIONS: LedgerDimension[] = ["provider", "model", "account", "role"];

export async function buildPage(input: PageInput, deps: PageDeps): Promise<Page> {
  let status;
  try {
    status = await deps.pooler.status();
  } catch (error) {
    return {
      status: "unavailable",
      reason: `The Account Pooler (account-pool-local) did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const range = { from: input.from, to: input.to };
  // The page's series and the Pooler's buckets share these boundaries.
  const starts = bucketStarts(input);
  const bucket = { starts };
  const splitDimension = input.split === "type" ? null : input.split;
  const groups: PoolerDimension[][] = [
    [],
    ["bucket"],
    ["provider"],
    ["model"],
    ["account"],
    ["role"],
    ["thread"],
    ...(splitDimension === null ? [] : [["bucket", splitDimension] as PoolerDimension[]]),
  ];

  // What every filter can take in range: the unfiltered slice, the page itself when unfiltered.
  const filtered = Object.keys(input.filter).length > 0;
  const unfiltered = await deps.pooler.stats({
    ...range,
    bucket: filtered ? null : bucket,
    filter: {},
    groups: filtered ? [["provider"], ["model"], ["account"], ["role"], ["thread"]] : groups,
  });
  const [optionProviders, optionModels, optionAccounts, optionRoles, optionThreads] = filtered
    ? unfiltered.results
    : unfiltered.results.slice(2);
  const threadIds = (optionThreads ?? []).flatMap((row) => (row.key.thread ? [row.key.thread] : []));
  const [threads, projects, memberships] = await Promise.all([
    deps.directory.threads(threadIds),
    deps.directory.projects().catch(() => new Map<string, string>()),
    deps.directory.memberships().catch(() => new Map<string, Membership>()),
  ]);
  const names = namer(status.accounts, threads, projects, memberships);

  const filter: PoolerStatsInput["filter"] = {};
  for (const dimension of LEDGER_DIMENSIONS) {
    const value = input.filter[dimension];
    if (value !== undefined) filter[dimension] = [value === "" ? null : value];
  }
  const project = input.filter.project;
  const initiative = input.filter.initiative;
  if (project !== undefined || initiative !== undefined) {
    // "" keeps the requests outside any thread with the threads outside any project.
    const keep = [null, ...threadIds].filter(
      (thread) =>
        (project === undefined || names.projectOf(thread) === project) &&
        (initiative === undefined || names.initiativeOf(thread) === initiative),
    );
    filter.thread = keep;
  }

  const stats = filtered ? await deps.pooler.stats({ ...range, bucket, filter, groups }) : unfiltered;
  const [totalRows, bucketRows, providers, models, accounts, roles, threadRows, splitRows] =
    stats.results;
  const totals = totalRows?.[0]?.metrics ?? emptyMetrics();

  const byThread = threadRows ?? [];
  const sumBy = (key: (thread: string | null) => string) => {
    const sums = new Map<string, Metrics>();
    for (const row of byThread) {
      const id = key(row.key.thread ?? null);
      sums.set(id, addMetrics(sums.get(id) ?? emptyMetrics(), row.metrics));
    }
    return [...sums.entries()].map(([id, metrics]) => ({ id, metrics }));
  };
  const rows = (dimension: FilterDimension | "thread", list: Array<{ id: string; metrics: Metrics }>): Row[] =>
    list
      .map(({ id, metrics }) => ({ ...names.label(dimension, id), metrics }))
      .sort((left, right) => amount(right.metrics, input.measure) - amount(left.metrics, input.measure));
  const ledgerRows = (dimension: LedgerDimension | "thread", list: PoolerStatsRow[] | undefined) =>
    rows(
      dimension,
      (list ?? []).map((row) => ({ id: row.key[dimension] ?? "", metrics: row.metrics })),
    );
  const options = (dimension: LedgerDimension, list: PoolerStatsRow[] | undefined) =>
    ledgerRows(dimension, list).map(({ id, label, detail }) => ({ id, label, detail }));
  const unfilteredThreads = (optionThreads ?? []).map((row) => row.key.thread ?? null);
  const derivedOptions = (key: (thread: string | null) => string, dimension: FilterDimension) =>
    [...new Set(unfilteredThreads.map(key))]
      .map((id) => names.label(dimension, id))
      .sort((left, right) => left.label.localeCompare(right.label));

  const threadBreakdown = ledgerRows("thread", byThread);
  return {
    status: "ok",
    input: { ...range, bucket: input.bucket, measure: input.measure, split: input.split },
    weights: stats.weights,
    retentionDays: stats.retentionDays,
    oldestHour: stats.oldestHour,
    pendingRows: stats.pendingRows,
    totals,
    series: {
      ...series(starts, bucketRows ?? [], splitDimension, splitRows ?? [], names, input.measure),
      end: bucketEnd(starts.at(-1)!, input.bucket, input.timeZone),
    },
    breakdowns: {
      provider: ledgerRows("provider", providers),
      model: ledgerRows("model", models),
      account: ledgerRows("account", accounts),
      role: ledgerRows("role", roles),
      project: rows("project", sumBy(names.projectOf)),
      initiative: rows("initiative", sumBy(names.initiativeOf)),
      thread: threadBreakdown.slice(0, TOP_THREADS),
      threadCount: threadBreakdown.length,
    },
    options: {
      provider: options("provider", optionProviders),
      model: options("model", optionModels),
      account: options("account", optionAccounts),
      role: options("role", optionRoles),
      project: derivedOptions(names.projectOf, "project"),
      initiative: derivedOptions(names.initiativeOf, "initiative"),
    },
    quota: await quota(input, deps, status.accounts, names),
  };
}

function series(
  starts: number[],
  bucketRows: PoolerStatsRow[],
  dimension: Exclude<PageInput["split"], "type"> | null,
  splitRows: PoolerStatsRow[],
  names: Namer,
  measure: Measure,
): Omit<OkPage["series"], "end"> {
  const index = new Map(starts.map((at, position) => [at, position]));
  const buckets = starts.map((at) => ({ at, metrics: emptyMetrics() }));
  for (const row of bucketRows) {
    const position = index.get(row.key.bucket ?? -1);
    if (position !== undefined) buckets[position]!.metrics = row.metrics;
  }
  if (dimension === null) return { buckets, keys: [], amounts: [], requests: [] };
  // The top values in the measure keep their own series; the rest is "Other".
  const totals = new Map<string, number>();
  for (const row of splitRows) {
    const id = row.key[dimension] ?? "";
    totals.set(id, (totals.get(id) ?? 0) + amount(row.metrics, measure));
  }
  const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
  const top = ranked.length <= TOP_SERIES ? ranked : ranked.slice(0, TOP_SERIES - 1);
  const keys = [...top, ...(ranked.length > top.length ? [OTHER_ID] : [])];
  const amounts = keys.map(() => starts.map(() => 0));
  const requests = keys.map(() => starts.map(() => 0));
  for (const row of splitRows) {
    const position = index.get(row.key.bucket ?? -1);
    if (position === undefined) continue;
    const id = row.key[dimension] ?? "";
    const key = top.includes(id) ? keys.indexOf(id) : keys.length - 1;
    amounts[key]![position]! += amount(row.metrics, measure);
    requests[key]![position]! += row.metrics.requests;
  }
  return {
    buckets,
    keys: keys.map((id) => (id === OTHER_ID ? { id: OTHER_ID, label: "Other", detail: null } : names.label(dimension, id))),
    amounts,
    requests,
  };
}

async function quota(
  input: PageInput,
  deps: PageDeps,
  accounts: Awaited<ReturnType<Pooler["status"]>>["accounts"],
  names: Namer,
): Promise<OkPage["quota"]> {
  let history;
  try {
    history = await deps.pooler.quota({ from: input.from, to: input.to });
  } catch {
    return [];
  }
  const now = deps.now();
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const result = history.accounts.map(({ accountId, points }) => {
    const windows = new Map<string, { points: Array<[number, number]>; resets: number[]; resetAt: number | null }>();
    for (const point of points) {
      for (const [name, window] of Object.entries(point.windows)) {
        // A window without a length (a Codex slot) carries no limit.
        if (!/^\d+[mhd]\b/u.test(name)) continue;
        let entry = windows.get(name);
        if (entry === undefined) {
          entry = { points: [], resets: [], resetAt: null };
          windows.set(name, entry);
        }
        entry.points.push([Math.max(point.at, input.from), window.utilization]);
        // The window rolled over when its reset time moved on; reads of one window differ by seconds.
        const previous = entry.resetAt;
        if (window.resetAt !== null && previous !== null && window.resetAt - previous > RESET_JITTER_MS && previous >= input.from && previous <= Math.min(now, input.to))
          entry.resets.push(previous);
        if (window.resetAt !== null) entry.resetAt = window.resetAt;
      }
    }
    const account = byId.get(accountId);
    return {
      accountId,
      label: names.label("account", accountId).label,
      status: account?.status ?? null,
      active: account?.active ?? false,
      windows: [...windows.entries()]
        .sort(([left], [right]) => windowOrder(left) - windowOrder(right) || left.localeCompare(right))
        .map(([name, entry]) => ({
          name,
          points: downsample(entry.points, input.from, input.to),
          resets: entry.resets,
        })),
    };
  });
  // Current accounts first, in the Pooler's order; removed ones after, when seen in range. The
  // account and provider filters apply; a removed account has no known provider.
  const seen = new Set(history.accounts.filter(({ points }) => points.some((point) => point.at >= input.from)).map(({ accountId }) => accountId));
  const { account: onlyAccount, provider: onlyProvider } = input.filter;
  const order = (id: string) => {
    const position = accounts.findIndex((account) => account.id === id);
    return position === -1 ? accounts.length : position;
  };
  return result
    .filter((account) => byId.has(account.accountId) || seen.has(account.accountId))
    .filter((account) => onlyAccount === undefined || account.accountId === onlyAccount)
    .filter((account) => onlyProvider === undefined || byId.get(account.accountId)?.provider === onlyProvider)
    .sort((left, right) => order(left.accountId) - order(right.accountId));
}

function windowOrder(name: string): number {
  if (name === "5h") return 0;
  if (name === "7d") return 1;
  return 2;
}

/** At most QUOTA_POINTS points: the highest utilization in each slot of the range. */
export function downsample(points: Array<[number, number]>, from: number, to: number): Array<[number, number]> {
  if (points.length <= QUOTA_POINTS) return points;
  const width = (to - from) / QUOTA_POINTS;
  const slots = new Map<number, [number, number]>();
  for (const point of points) {
    const slot = Math.min(QUOTA_POINTS - 1, Math.floor((point[0] - from) / width));
    const kept = slots.get(slot);
    if (kept === undefined || point[1] > kept[1]) slots.set(slot, point);
  }
  return [...slots.values()].sort((left, right) => left[0] - right[0]);
}

// --- Names ---

type Namer = ReturnType<typeof namer>;

const PROVIDERS: Record<string, string> = { claude: "Claude", codex: "Codex" };
const ROLES: Record<string, string> = {
  coordinator: "Coordinator",
  work: "Worker",
  review: "Reviewer",
  adhoc: "Ad hoc",
  standalone: "Standalone",
};

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5", "gpt-6.1-sol" → "GPT-6.1 Sol". */
export function modelName(model: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u.exec(model);
  if (claude !== null) {
    const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1);
    return `${family} ${claude[2]}${claude[3] === undefined ? "" : `.${claude[3]}`}`;
  }
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/u.exec(model);
  if (gpt !== null) {
    const variant = gpt[2]?.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    return `GPT-${gpt[1]}${variant === undefined ? "" : ` ${variant}`}`;
  }
  return model;
}

function namer(
  accounts: Awaited<ReturnType<Pooler["status"]>>["accounts"],
  threads: Map<string, ThreadInfo>,
  projects: Map<string, string>,
  memberships: Map<string, Membership>,
) {
  const accountNames = new Map(accounts.map((account) => [account.id, account.email ?? account.label]));
  const projectOf = (thread: string | null) => (thread === null ? "" : (threads.get(thread)?.projectId ?? ""));
  const initiativeOf = (thread: string | null) => (thread === null ? "" : (memberships.get(thread)?.initiativeId ?? ""));
  const initiativeNames = new Map([...memberships.values()].map((member) => [member.initiativeId, member.initiativeName]));
  const label = (dimension: FilterDimension | "thread", id: string): Label => {
    switch (dimension) {
      case "provider":
        return { id, label: PROVIDERS[id] ?? (id || "Unknown"), detail: null };
      case "model":
        return id === "" ? { id, label: "Unknown model", detail: null } : { id, label: modelName(id), detail: id };
      case "account":
        return accountNames.has(id)
          ? { id, label: accountNames.get(id)!, detail: null }
          : { id, label: `Removed account ${id.slice(0, 8)}`, detail: id };
      case "role":
        return { id, label: id === "" ? "Not linked" : (ROLES[id] ?? id), detail: null };
      case "project":
        return { id, label: id === "" ? "Unattributed" : (projects.get(id) ?? `Project ${id}`), detail: null };
      case "initiative":
        return { id, label: id === "" ? "No Initiative" : (initiativeNames.get(id) ?? id), detail: null };
      case "thread": {
        if (id === "") return { id, label: "Not linked to a thread", detail: "Helpers, titles and sessions the Pooler could not link" };
        const thread = threads.get(id);
        const member = memberships.get(id);
        const project = thread?.projectId == null ? null : (projects.get(thread.projectId) ?? null);
        // The Initiative's name only when it differs from the project's.
        const initiative =
          member === undefined ? null : member.initiativeName.toLowerCase() === project?.toLowerCase() ? member.member : `${member.initiativeName} · ${member.member}`;
        const detail = [project, initiative]
          .filter((part) => part !== null)
          .join(" · ");
        return { id, label: thread?.title ?? id, detail: detail === "" ? null : detail };
      }
    }
  };
  return { label, projectOf, initiativeOf };
}
