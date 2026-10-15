// The PR map (D437): stacks derived from GitHub branches, what the user can
// review now, and the grouped, filtered views of the merge queue. Pure; the
// server links stacks once per read, the dashboard groups and lays out.
import type { MergeQueue, PrStack, QueuedPullRequest, StageDefinition } from "./merge-queue";
import type { PrNote } from "./pr-notes";
import { UNCATEGORIZED } from "./pr-stages";

export { UNCATEGORIZED };

const READY = "ready-for-erwin";
const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}\0${branch}`;
const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/**
 * Link stacked PRs and mark the available ones. A PR whose base branch is
 * another open PR's head branch in the same repository is stacked on it; a
 * base that is no open PR's head (the default branch, a release branch, a
 * merged PR's leftover branch) is the bottom of a stack.
 *
 * Available: ready for the user, and so is every PR beneath it, so a stack
 * whose PRs are all ready can be reviewed bottom-up in one sitting, while a
 * ready PR on a base still being worked on waits. A PR on a cycle of branches,
 * or above one, is never available: it has no bottom to review first.
 */
export function linkStacks(pullRequests: readonly QueuedPullRequest[]): QueuedPullRequest[] {
  const byHead = new Map<string, QueuedPullRequest>();
  for (const pr of pullRequests) if (pr.head && !byHead.has(branchKey(pr.repo, pr.head))) byHead.set(branchKey(pr.repo, pr.head), pr);
  const parent = new Map<QueuedPullRequest, QueuedPullRequest>();
  for (const pr of pullRequests) {
    const below = pr.base ? byHead.get(branchKey(pr.repo, pr.base)) : undefined;
    if (below && below !== pr) parent.set(pr, below);
  }
  // Before any cycle is broken: breaking one for drawing must not make its members ready.
  const ready = new Map<QueuedPullRequest, boolean>();
  for (const pr of pullRequests) {
    const seen = new Set<QueuedPullRequest>();
    let node: QueuedPullRequest | undefined = pr;
    while (node && !seen.has(node) && node.stage === READY) {
      seen.add(node);
      node = parent.get(node);
    }
    ready.set(pr, node === undefined);
  }
  // Open PRs can't form a cycle of branches in practice; break one for drawing if they do.
  for (const pr of pullRequests) {
    const seen = new Set([pr]);
    for (let node = pr; parent.has(node); ) {
      const up = parent.get(node)!;
      if (seen.has(up)) {
        parent.delete(node);
        break;
      }
      seen.add(up);
      node = up;
    }
  }
  const children = new Map<QueuedPullRequest, QueuedPullRequest[]>();
  for (const [pr, up] of parent) children.set(up, [...(children.get(up) ?? []), pr]);

  const stacks = new Map<QueuedPullRequest, PrStack>();
  for (const root of pullRequests) {
    if (parent.has(root) || !children.has(root)) continue;
    const members: [QueuedPullRequest, number][] = [];
    const visit = (pr: QueuedPullRequest, level: number) => {
      members.push([pr, level]);
      for (const child of children.get(pr) ?? []) visit(child, level + 1);
    };
    visit(root, 1);
    const levels = Math.max(...members.map(([, level]) => level));
    for (const [pr, level] of members)
      stacks.set(pr, { root: root.number, on: parent.get(pr)?.number ?? null, level, levels, size: members.length, rootCreatedAt: root.createdAt });
  }
  return pullRequests.map((pr) => ({ ...pr, stack: stacks.get(pr) ?? null, available: ready.get(pr)! }));
}

/**
 * Review order: stacks and single PRs by when their bottom PR opened, oldest
 * first, and a stack bottom-up. `all` holds the stack roots `prs` may omit.
 */
export function stackOrder(all: readonly QueuedPullRequest[]): (a: QueuedPullRequest, b: QueuedPullRequest) => number {
  const byNumber = new Map(all.map((pr) => [prKey(pr.repo, pr.number), pr]));
  // A root `all` leaves out (another Initiative's, R2) still orders its stack, by what the stack says of it.
  const root = (pr: QueuedPullRequest) => (pr.stack
    ? byNumber.get(prKey(pr.repo, pr.stack.root)) ?? { repo: pr.repo, number: pr.stack.root, createdAt: pr.stack.rootCreatedAt }
    : pr);
  return (a, b) => {
    const ra = root(a);
    const rb = root(b);
    return (
      ra.createdAt - rb.createdAt ||
      ra.repo.localeCompare(rb.repo) ||
      ra.number - rb.number ||
      (a.stack?.level ?? 1) - (b.stack?.level ?? 1) ||
      a.createdAt - b.createdAt ||
      a.number - b.number
    );
  };
}

/** What to review next: the available PRs, in review order. */
export function nextUp(pullRequests: readonly QueuedPullRequest[]): QueuedPullRequest[] {
  return pullRequests.filter((pr) => pr.available).sort(stackOrder(pullRequests));
}

/** One part of where a PR stands, as a list row or hover card shows it. */
export interface StateItem {
  kind: "waiting" | "question" | "changes" | "decision";
  text: string;
  /** Where a decision was made: a URL, a BB thread id or a ref like D437. */
  link?: string | null;
}

/** Who wrote a note, for the user reading it: "coordinator", "W12", "you". */
export const noteAuthor = (author: string) => (author === "user" ? "you" : author);

/** "waiting on W188: move the lock to resume", "coordinator asks: Redis TTL?", … in that order. */
export function stateItems(pr: Pick<QueuedPullRequest, "waitingOn" | "notes" | "changes" | "decision">): StateItem[] {
  return [
    ...(pr.waitingOn ? [{ kind: "waiting" as const, text: `waiting on ${pr.waitingOn}` }] : []),
    ...pr.notes.open.map((q) => ({ kind: "question" as const, text: `${noteAuthor(q.author)} asks: ${q.text}` })),
    ...(pr.changes.length ? [{ kind: "changes" as const, text: `${pr.changes.length === 1 ? "change" : `${pr.changes.length} changes`} requested: ${pr.changes.join("; ")}` }] : []),
    ...(pr.decision ? [{ kind: "decision" as const, text: `decided: ${pr.decision.text}`, link: pr.decision.link }] : []),
  ];
}

/** 1.2k for 1234: a count that fits a node. */
export const compactCount = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`);

/** "48 files · 5 commits". */
export const sizeDetail = (size: NonNullable<QueuedPullRequest["size"]>) =>
  `${size.files} file${size.files === 1 ? "" : "s"} · ${size.commits} commit${size.commits === 1 ? "" : "s"}`;

/** "W188 · A382 (review)". */
export function workerLabel(worker: NonNullable<QueuedPullRequest["worker"]>): string {
  return `${worker.ref}${worker.assignment ? ` · ${worker.assignment}` : ""}${worker.role && worker.role !== "work" ? ` (${worker.role})` : ""}`;
}

/** "2 of 4 · on #2172": its level in the stack, the stack's height and the PR beneath. */
export function stackLabel(stack: PrStack): string {
  return `${stack.level} of ${stack.levels}${stack.on === null ? "" : ` · on #${stack.on}`}`;
}

export interface PrFilter {
  /** One category; null for the uncategorized PRs; undefined for every category. */
  category?: string | null;
  /** The stages to show; empty for every stage. */
  stages: readonly string[];
  availableOnly: boolean;
}

export function filterPrs(pullRequests: readonly QueuedPullRequest[], filter: PrFilter): QueuedPullRequest[] {
  return pullRequests.filter(
    (pr) =>
      (filter.category === undefined || pr.category === filter.category) &&
      (!filter.stages.length || filter.stages.includes(pr.stage)) &&
      (!filter.availableOnly || pr.available),
  );
}

/** The categories in display order, alphabetical with the uncategorized PRs last, and their counts. */
export function categoriesOf(pullRequests: readonly QueuedPullRequest[]): { category: string | null; label: string; count: number }[] {
  const counts = new Map<string | null, number>();
  for (const pr of pullRequests) counts.set(pr.category, (counts.get(pr.category) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([category, count]) => ({ category, label: category ?? UNCATEGORIZED, count }));
}

export type GroupBy = "category" | "stage";

export interface PrGroup {
  /** The category (null when uncategorized) or the stage id. */
  key: string | null;
  label: string;
  count: number;
  /** The other dimension within it, in order, each in review order. */
  groups: { key: string | null; label: string; pullRequests: QueuedPullRequest[] }[];
}

/**
 * Two-level grouping: by category then stage, or by stage then category.
 * Empty groups drop out. `all` gives review order its stack roots.
 */
export function groupPrs(
  pullRequests: readonly QueuedPullRequest[],
  by: GroupBy,
  stages: readonly StageDefinition[],
  all: readonly QueuedPullRequest[] = pullRequests,
): PrGroup[] {
  const order = stackOrder(all);
  const byCategory = categoriesOf(pullRequests).map(({ category, label }) => ({
    key: category,
    label,
    test: (pr: QueuedPullRequest) => pr.category === category,
  }));
  const byStage = stages.map((stage) => ({ key: stage.id, label: stage.label, test: (pr: QueuedPullRequest) => pr.stage === stage.id }));
  const [outer, inner] = by === "category" ? [byCategory, byStage] : [byStage, byCategory];
  return outer.flatMap((group) => {
    const members = pullRequests.filter(group.test);
    if (!members.length) return [];
    const groups = inner.flatMap((sub) => {
      const prs = members.filter(sub.test).sort(order);
      return prs.length ? [{ key: sub.key, label: sub.label, pullRequests: prs }] : [];
    });
    return [{ key: group.key, label: group.label, count: members.length, groups }];
  });
}

/** One row of a stack drawn as a tree: indented only where the stack branches. */
export interface StackRow {
  pr: QueuedPullRequest;
  /** Indent column. */
  col: number;
  /** The row of the PR it sits on, within this drawing; null for the drawing's bottom. */
  parentRow: number | null;
}

export interface StackDrawing {
  /** The PR the bottom one sits on when that PR is not drawn here (another category, filtered out). */
  on: number | null;
  rows: StackRow[];
}

/**
 * A graph lane: the stacked PRs of one category as trees, the unstacked ones
 * apart. A stack split across categories or filters is drawn per visible
 * piece, each saying what it sits on.
 */
export function laneLayout(
  pullRequests: readonly QueuedPullRequest[],
  all: readonly QueuedPullRequest[] = pullRequests,
): { stacks: StackDrawing[]; singles: QueuedPullRequest[] } {
  const order = stackOrder(all);
  const sorted = [...pullRequests].sort(order);
  const shown = new Map(sorted.map((pr) => [prKey(pr.repo, pr.number), pr]));
  const below = (pr: QueuedPullRequest) => (pr.stack?.on == null ? undefined : shown.get(prKey(pr.repo, pr.stack.on)));
  const children = new Map<QueuedPullRequest, QueuedPullRequest[]>();
  for (const pr of sorted) {
    const up = below(pr);
    if (up) children.set(up, [...(children.get(up) ?? []), pr]);
  }
  const stacks = sorted
    .filter((pr) => pr.stack && !below(pr))
    .map((bottom) => {
      const rows: StackRow[] = [];
      const visit = (pr: QueuedPullRequest, col: number, parentRow: number | null) => {
        const row = rows.length;
        rows.push({ pr, col, parentRow });
        const next = children.get(pr) ?? [];
        for (const child of next) visit(child, next.length > 1 ? col + 1 : col, row);
      };
      visit(bottom, 0, null);
      return { on: bottom.stack!.on, rows };
    });
  return { stacks, singles: sorted.filter((pr) => !pr.stack) };
}

/** A slice of the queue and one page of it, for initiative_read {view:"prs"}. */
export interface PrRead {
  /** A category's name, case-insensitive; "Uncategorized" for the PRs without one. */
  category?: string;
  /** A stage id, exactly as PR_STAGE_IDS spells it. */
  stage?: string;
  /** R2: the unassigned PRs instead of the Initiative's own. */
  unassigned?: boolean;
  offset: number;
  limit: number;
}

/** The longest initiative_read {view:"prs"} answer, in characters: it must fit an agent's tool output. */
export const PRS_READ_CHARS = 20_000;
/**
 * What a page leaves an answer's lists (repositories, byCategory, stacks, …) at
 * least; they get whatever more it leaves. The rest of an answer is short by
 * construction, so a compact PR always fits.
 */
const LISTS_CHARS = 8_000;
/** How many "review next" PRs a read lists; the rest are counted. */
const NEXT_SHOWN = 10;
/** Per compact PR: the questions and changes listed, and each line's length. */
const STATE_ITEMS = 3;
const STATE_LINE = 160;

/** Someone has to act: an open question, requested changes, or a wait on someone. */
const needsAction = (pr: QueuedPullRequest) => !!pr.waitingOn || pr.notes.open.length > 0 || pr.changes.length > 0;

/**
 * initiative_read {view:"prs"}: what the user can review next and where the
 * PRs stand, bounded so the coordinator reads it without the dashboard. Without
 * a filter, `state` lists only the PRs needing action and counts the others; a
 * category or stage lists every PR in it. `state` pages with offset/limit and
 * its lines are clipped; prsByRef reads whole PRs. The answer fits
 * PRS_READ_CHARS and says what it left out. Like the dashboard (R2), it is
 * about the Initiative's own PRs; the unassigned ones in the slice are only
 * listed, by ref and title, in unassignedPrs, as far as they fit. `unassigned`
 * reads them instead, as a slice: `state` lists and pages every one.
 */
export function prSummary(queue: MergeQueue, read: PrRead = { offset: 0, limit: 20 }) {
  const all = queue.pullRequests;
  const prs = all.filter((pr) => !pr.unassigned === !read.unassigned);
  const ref = prRef(all);
  const order = stackOrder(all);
  const filtered = read.category !== undefined || read.stage !== undefined || !!read.unassigned;
  const category = read.category?.toLowerCase();
  const inSlice = (pr: QueuedPullRequest) => (category === undefined || (pr.category ?? UNCATEGORIZED).toLowerCase() === category) && (read.stage === undefined || pr.stage === read.stage);
  const slice = prs.filter(inSlice);
  const unassigned = read.unassigned ? [] : all.filter((pr) => pr.unassigned && inSlice(pr)).sort(order).map((pr) => `${ref(pr)} ${clip(pr.title, 70)}`);
  const listed = (filtered ? slice : slice.filter(needsAction)).sort(order);
  const sliced = new Set(slice);
  const next = nextUp(prs).filter((pr) => sliced.has(pr));
  const brief = (pr: QueuedPullRequest) => `${ref(pr)}${pr.stack ? ` (${stackLabel(pr.stack)})` : ""}`;
  const stackTree = (pr: QueuedPullRequest): string => {
    const up = prs.filter((p) => p.repo === pr.repo && p.stack?.on === pr.number).sort(order);
    return up.length === 0 ? ref(pr) : up.length === 1 ? `${ref(pr)} → ${stackTree(up[0]!)}` : `${ref(pr)} → (${up.map(stackTree).join(" | ")})`;
  };

  const categories = filtered && !slice.length ? categoriesOf(prs).map((c) => c.label) : [];
  const groups = groupPrs(slice, "category", queue.stages, all);
  const named = groups.map((group) => [group.label, Object.fromEntries(group.groups.map((g) => [g.key!, g.pullRequests.map(brief)]))] as const);
  const counted = groups.map((group) => [group.label, Object.fromEntries(group.groups.map((g) => [g.key!, g.pullRequests.length]))] as const);
  // Each stack from its lowest PR here: its root, or (R2) the first above a PR another Initiative owns.
  const here = new Set(prs.map((pr) => `${pr.repo}#${pr.number}`));
  const roots = prs.filter((root) => root.stack && (root.stack.on === null || !here.has(`${root.repo}#${root.stack.on}`))
    && (!filtered || slice.some((pr) => pr.repo === root.repo && pr.stack?.root === root.stack!.root)));
  const trees = roots.sort(order).map((root) => `${root.stack!.on === null ? "" : `(on #${root.stack!.on}) `}${stackTree(root)}`);

  return fitPage(listed, read, (pr) => [ref(pr), prState(pr, false)], (state, page, cut, lists) => {
    // The lists take their share in this order.
    const head = queueHead(queue, lists);
    const shownCategories = lists.take(categories, "category names");
    const byNames = fitting(named, lists.left).n === named.length;
    if (!byNames) lists.cuts.push("byCategory counts the PRs");
    // fromEntries: free-form category names ("__proto__") become plain keys.
    const byCategory = Object.fromEntries(lists.take<readonly [string, Record<string, string[] | number>]>(byNames ? named : counted, "categories"));
    const stacks = lists.take(trees, "stacks");
    const unassignedPrs = lists.take(unassigned, "unassigned PRs");
    const cuts = [...lists.cuts, ...(cut ? ["state ends at page.nextOffset, read on with offset"] : [])];
    return {
      ...head,
      ...(filtered ? { matching: slice.length } : {}),
      ...(filtered && !slice.length ? { categories: shownCategories } : {}),
      next: next.slice(0, NEXT_SHOWN).map((pr) => ({
        pr: ref(pr),
        title: clip(pr.title, 90),
        ...(pr.category ? { category: pr.category } : {}),
        ...(pr.stack ? { stack: stackLabel(pr.stack) } : {}),
      })),
      ...(next.length > NEXT_SHOWN ? { moreNext: next.length - NEXT_SHOWN } : {}),
      byCategory,
      stacks,
      state,
      page,
      ...(filtered ? {} : { noAction: slice.length - listed.length }),
      ...(unassigned.length ? { unassignedPrs, owners: UNASSIGNED_NOTE } : {}),
      ...(prs.some((pr) => pr.stageSource === "github") ? { note: "Stages without a coordinator record are guessed from GitHub." } : {}),
      ...(cuts.length ? { truncated: `Cut to fit ${PRS_READ_CHARS} characters: ${cuts.join("; ")}. Narrow with category, stage or refs.` } : {}),
      reads: filtered
        ? 'state lists every PR in this slice; refs read whole PRs: initiative_read {view:"prs",refs:["#12"]}'
        : 'state lists the PRs needing action (a question, changes, a wait); refs read whole PRs, category or stage lists a slice: initiative_read {view:"prs",category:"CI",stage:"in-review"}',
    };
  });
}

/**
 * The PRs that initiative_read view prs names in refs, whole and in review
 * order, paged by offset/limit like state. A PR too long to read whole is
 * listed compact, as state lists it, and marked clipped.
 */
export function prsByRef(queue: MergeQueue, refs: readonly string[], read: { offset: number; limit: number } = { offset: 0, limit: 20 }) {
  const prs = queue.pullRequests;
  const ref = prRef(prs);
  const matches = refs.map((text) => {
    const named = matchesRef(text);
    return [text, named ? prs.filter(named) : []] as const;
  });
  const found = [...new Set(matches.flatMap(([, m]) => m))].sort(stackOrder(prs));
  const missing = matches.filter(([, m]) => !m.length).map(([text]) => text);
  return fitPage(found, read, (pr, whole) => [ref(pr), prDetail(pr, whole)], (detail, page, cut, lists) => {
    const missingRefs = lists.take(missing, "unmatched refs");
    const head = queueHead(queue, lists);
    const cuts = [...lists.cuts, ...(cut ? ["prs ends at page.nextOffset, read on with the same refs and offset; a PR marked clipped is too long to read whole"] : [])];
    return {
      ...head,
      prs: detail,
      // Present whenever a ref matched nothing, even if none fit: the empty answer measured carries it.
      ...(missing.length ? { missingRefs } : {}),
      page,
      ...(cuts.length ? { truncated: `Cut to fit ${PRS_READ_CHARS} characters: ${cuts.join("; ")}.` } : {}),
    };
  });
}

const UNASSIGNED_NOTE = 'Unassigned PRs show in every Adventure listing their repository; initiative_read {"view":"prs","unassigned":true} lists them all with their state, paged. Give one an owner with initiative_pr {"prs":[{"url":"<the PR URL>","initiative":"<Adventure name>"}]} (initiative null unassigns).';

/** The repositories, whether the first read still runs, and how many open PRs are the Initiative's and unassigned (R2). */
function queueHead(queue: MergeQueue, lists: Budget) {
  const loading = queue.repos.filter((r) => r.fetchedAt === null && r.fetching).map((r) => r.repo);
  const repos = queue.repos.map((r) => ({ repo: r.repo, fetchedAt: r.fetchedAt, ...(r.fetching ? { fetching: true } : {}), ...(r.error ? { error: clip(r.error, STATE_LINE) } : {}) }));
  const unassigned = queue.pullRequests.filter((pr) => pr.unassigned).length;
  return {
    repos: lists.take(repos, "repositories"),
    ...(loading.length ? { loading: `The first read of ${clip(loading.join(", "), STATE_LINE)} from GitHub is running; read again in a few seconds.` } : {}),
    open: queue.pullRequests.length - unassigned,
    ...(unassigned ? { unassigned } : {}),
  };
}

/** How many of `items`, in order, fit in `chars` of JSON, and the characters they take. Each is serialized once. */
function fitting(items: readonly unknown[], chars: number) {
  let n = 0;
  let used = 0;
  for (const item of items) {
    // An object entry [key, value] costs two characters more as an array than as "key":value: an upper bound.
    const cost = JSON.stringify(item).length + 1;
    if (used + cost > chars) break;
    used += cost;
    n++;
  }
  return { n, used };
}

type Budget = ReturnType<typeof budget>;
/** Characters shared by lists: each takes its first items that fit, and `cuts` counts what it left out. */
function budget(chars: number) {
  const cuts: string[] = [];
  let used = 0;
  return {
    cuts,
    get left() {
      return chars - used;
    },
    get used() {
      return used;
    },
    take<T>(items: readonly T[], what: string): T[] {
      const fit = fitting(items, chars - used);
      used += fit.used;
      if (fit.n < items.length) cuts.push(`${items.length - fit.n} ${what} left out`);
      return items.slice(0, fit.n);
    },
  };
}

interface Page {
  total: number;
  offset: number;
  nextOffset: number | null;
}

/**
 * `answer(entries, page, cut, lists)` with the entries of `items` from
 * read.offset that fit PRS_READ_CHARS: whole ones while they fit, and at least
 * the first, compact, so reading on from nextOffset always advances. The page
 * leaves the lists up to LISTS_CHARS, and they get whatever more it leaves.
 * Entries are serialized once and list items a few times, so a read is linear
 * in the queue. Every key `answer` writes must be present in the empty answer
 * too: only entries and list items are counted on top of it.
 */
function fitPage<T, V, A>(
  items: readonly T[],
  read: { offset: number; limit: number },
  entry: (item: T, whole: boolean) => readonly [string, V],
  answer: (entries: Record<string, V>, page: Page, cut: boolean, lists: Budget) => A,
): A {
  const page = items.slice(read.offset, read.offset + read.limit);
  const at = (n: number): Page => ({ total: items.length, offset: read.offset, nextOffset: read.offset + n < items.length ? read.offset + n : null });
  // At its longest without entries or lists: cut, every list cut, and nextOffset whichever of null and a number is longer.
  const longest = { ...at(0), nextOffset: String(items.length).length > 4 ? items.length : null };
  const room = PRS_READ_CHARS - JSON.stringify(answer({}, longest, true, budget(0))).length;
  const lists = budget(Infinity);
  answer({}, longest, true, lists);
  const whole = page.map((item) => entry(item, true));
  const fit = fitting(whole, room - Math.min(lists.used, LISTS_CHARS));
  const shown = fit.n || !page.length ? whole.slice(0, fit.n) : [entry(page[0]!, false)];
  const spent = fit.n ? fit.used : fitting(shown, Infinity).used;
  return answer(Object.fromEntries(shown), at(shown.length), shown.length < page.length || fit.n < shown.length, budget(room - spent));
}

/** "#12" in one repository; "infra#12" across several, with the owner only when two names clash. */
function prRef(prs: readonly QueuedPullRequest[]) {
  const repos = [...new Set(prs.map((pr) => pr.repo.toLowerCase()))];
  const names = repos.map((repo) => repo.split("/")[1]);
  const prefix = repos.length < 2 ? () => "" : new Set(names).size === names.length ? (pr: QueuedPullRequest) => pr.repo.split("/")[1] : (pr: QueuedPullRequest) => pr.repo;
  return (pr: QueuedPullRequest) => `${prefix(pr)}#${pr.number}`;
}

/**
 * The PRs a ref names: "#12" or "12" (every repository's #12), "infra#12"
 * (every owner's infra#12), "equisafe/infra#12" or the PR's URL; null when
 * `text` is no ref.
 */
export function matchesRef(text: string): ((pr: Pick<QueuedPullRequest, "repo" | "number">) => boolean) | null {
  const parts = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(text) ?? /^\s*(?:([\w.\/-]+)?#)?(\d+)\s*$/.exec(text);
  if (!parts) return null;
  const repo = parts[1]?.toLowerCase();
  return (pr) => pr.number === Number(parts[2]) && (!repo || pr.repo.toLowerCase() === repo || pr.repo.toLowerCase().endsWith(`/${repo}`));
}

/** Where a PR stands. Unless `whole`: lines clipped, the first few questions and changes. */
function prState(pr: QueuedPullRequest, whole: boolean) {
  const line = (text: string) => (whole ? text : clip(text, STATE_LINE));
  const lines = (texts: string[]) =>
    whole || texts.length <= STATE_ITEMS ? texts.map(line) : [...texts.slice(0, STATE_ITEMS).map(line), `+${texts.length - STATE_ITEMS} more`];
  return {
    stage: pr.stage,
    ...(pr.worker ? { worker: workerLabel(pr.worker) } : {}),
    ...(pr.waitingOn ? { waitingOn: line(pr.waitingOn) } : {}),
    ...(pr.notes.open.length ? { questions: lines(pr.notes.open.map((q) => `n${q.n} ${q.author}: ${q.text}`)) } : {}),
    ...(pr.changes.length ? { changes: lines(pr.changes) } : {}),
    ...(pr.notes.count
      ? whole ? { notes: pr.notes.count, recentNotes: pr.notes.recent.map(noteLine) } : { notes: pr.notes.count, latestNote: line(noteLine(pr.notes.recent.at(-1)!)) }
      : {}),
    ...(pr.decision ? { decision: line(pr.decision.link ? `${pr.decision.text} (${pr.decision.link})` : pr.decision.text) } : {}),
  };
}

/** A PR read by ref: its GitHub facts and its state; unless `whole`, compact like state and marked clipped. */
function prDetail(pr: QueuedPullRequest, whole: boolean) {
  const line = (text: string) => (whole ? text : clip(text, STATE_LINE));
  return {
    ...(whole ? {} : { clipped: true }),
    title: line(pr.title),
    url: pr.url,
    ...(pr.unassigned ? { unassigned: true } : {}),
    ...(pr.category ? { category: pr.category } : {}),
    ...(pr.stack ? { stack: stackLabel(pr.stack) } : {}),
    ...(pr.available ? { available: true } : {}),
    ...(pr.stageNote ? { stageNote: line(pr.stageNote) } : {}),
    ...(pr.reasons.length ? { github: pr.reasons.join(", ") } : {}),
    ...(pr.size ? { size: sizeDetail(pr.size) } : {}),
    ...prState(pr, whole),
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** "W12 (A301): Two findings; needs attention". */
const noteLine = (note: PrNote) =>
  `${note.author}${note.link && /^A\d+$/.test(note.link) ? ` (${note.link})` : ""}${note.kind === "note" ? "" : ` ${note.kind}`}: ${note.text}`;
