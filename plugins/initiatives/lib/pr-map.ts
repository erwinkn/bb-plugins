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
      stacks.set(pr, { root: root.number, on: parent.get(pr)?.number ?? null, level, levels, size: members.length });
  }
  return pullRequests.map((pr) => ({ ...pr, stack: stacks.get(pr) ?? null, available: ready.get(pr)! }));
}

/**
 * Review order: stacks and single PRs by when their bottom PR opened, oldest
 * first, and a stack bottom-up. `all` holds the stack roots `prs` may omit.
 */
export function stackOrder(all: readonly QueuedPullRequest[]): (a: QueuedPullRequest, b: QueuedPullRequest) => number {
  const byNumber = new Map(all.map((pr) => [prKey(pr.repo, pr.number), pr]));
  const root = (pr: QueuedPullRequest) => (pr.stack ? byNumber.get(prKey(pr.repo, pr.stack.root)) ?? pr : pr);
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

/**
 * initiative_read {view:"prs"}: the queue in a few lines, so the coordinator
 * answers "what's next" without the dashboard. Titles only in `next`; `state`
 * has where each PR stands (worker, waiting on, questions, changes, decision).
 */
export function prSummary(queue: MergeQueue) {
  const multiRepo = new Set(queue.pullRequests.map((pr) => pr.repo.toLowerCase())).size > 1;
  const ref = (pr: QueuedPullRequest) => (multiRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`);
  const brief = (pr: QueuedPullRequest) => `${ref(pr)}${pr.stack ? ` (${stackLabel(pr.stack)})` : ""}`;
  // fromEntries: free-form category names ("__proto__") become plain keys.
  const byCategory = Object.fromEntries(groupPrs(queue.pullRequests, "category", queue.stages)
    .map((group) => [group.label, Object.fromEntries(group.groups.map((g) => [g.key!, g.pullRequests.map(brief)]))]));
  const prs = queue.pullRequests;
  const stackTree = (pr: QueuedPullRequest): string => {
    const up = prs.filter((p) => p.repo === pr.repo && p.stack?.on === pr.number).sort(stackOrder(prs));
    return up.length === 0 ? ref(pr) : up.length === 1 ? `${ref(pr)} → ${stackTree(up[0]!)}` : `${ref(pr)} → (${up.map(stackTree).join(" | ")})`;
  };
  const state: Record<string, Record<string, unknown>> = {};
  for (const pr of [...prs].sort(stackOrder(prs))) {
    const entry = {
      ...(pr.worker ? { worker: workerLabel(pr.worker) } : {}),
      ...(pr.waitingOn ? { waitingOn: pr.waitingOn } : {}),
      ...(pr.notes.open.length ? { questions: pr.notes.open.map((q) => `n${q.n} ${q.author}: ${clip(q.text, 200)}`) } : {}),
      ...(pr.notes.count ? { notes: pr.notes.count, latestNote: noteLine(pr.notes.recent.at(-1)!) } : {}),
      ...(pr.changes.length ? { changes: pr.changes } : {}),
      ...(pr.decision ? { decision: pr.decision.link ? `${pr.decision.text} (${pr.decision.link})` : pr.decision.text } : {}),
      ...(pr.discussionThreadId ? { discussion: pr.discussionThreadId } : {}),
    };
    if (Object.keys(entry).length) state[ref(pr)] = entry;
  }
  const loading = queue.repos.filter((r) => r.fetchedAt === null && r.fetching).map((r) => r.repo);
  return {
    repos: queue.repos.map((r) => ({ repo: r.repo, fetchedAt: r.fetchedAt, ...(r.fetching ? { fetching: true } : {}), ...(r.error ? { error: r.error } : {}) })),
    ...(loading.length ? { loading: `The first read of ${loading.join(", ")} from GitHub is running; read again in a few seconds.` } : {}),
    open: prs.length,
    next: nextUp(prs).map((pr) => ({
      pr: ref(pr),
      title: pr.title.length > 90 ? `${pr.title.slice(0, 89)}…` : pr.title,
      ...(pr.category ? { category: pr.category } : {}),
      ...(pr.stack ? { stack: stackLabel(pr.stack) } : {}),
    })),
    byCategory,
    stacks: prs.filter((pr) => pr.stack?.level === 1).sort(stackOrder(prs)).map(stackTree),
    state,
    ...(prs.some((pr) => pr.stageSource === "github") ? { note: "Stages without a coordinator record are guessed from GitHub." } : {}),
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** "W12 (A301): Two findings; needs attention", clipped for initiative_read. */
const noteLine = (note: PrNote) =>
  `${note.author}${note.link && /^A\d+$/.test(note.link) ? ` (${note.link})` : ""}${note.kind === "note" ? "" : ` ${note.kind}`}: ${clip(note.text, 200)}`;
