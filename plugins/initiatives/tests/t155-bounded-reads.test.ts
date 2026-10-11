import { describe, expect, it } from "vitest";
import { projectFixture } from "./fake-native";
import { parsePullRequests, type MergeQueue, type QueuedPullRequest } from "../lib/merge-queue";
import { PR_STAGES, prToolSchema, type PrStage } from "../lib/pr-stages";
import { agentReadSchema, readOptionsSchema } from "../lib/read";
import type { PrNote } from "../lib/pr-notes";
import { linkStacks, prSummary, prsByRef, PRS_READ_CHARS } from "../lib/pr-map";

const REPOS = ["equisafe/equisafe-market", "equisafe/infra"];
const STAGES: PrStage[] = ["ready-for-erwin", "in-review", "ready-for-review", "working", "experiment"];
const CATEGORIES = [null, "CI", "Security", "Payments"];
const note = (n: number, kind: PrNote["kind"], text: string): PrNote => ({ n, at: n, author: "coordinator", kind, text, link: null, answered: null });

/**
 * PR i of a queue like Equisafe's: two repositories, a stack every 10 PRs, a long
 * title, every third PR waiting on someone, every seventh with questions and changes,
 * and every 25th with a history of huge questions.
 */
function pr(i: number): QueuedPullRequest {
  const repo = REPOS[i % 7 === 0 ? 1 : 0]!;
  const number = 1000 + i;
  const [parsed] = parsePullRequests(repo, JSON.stringify([{
    number, url: `https://github.com/${repo}/pull/${number}`, title: `Fix the ${i}th thing `.repeat(12),
    headRefName: `b${i}`, baseRefName: i % 10 === 1 ? `b${i - 1}` : "main", createdAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
  }]));
  const questions = i % 25 === 0 ? Array.from({ length: 12 }, (_, q) => note(q + 1, "question", `Q${q}: ${"why ".repeat(400)}`))
    : i % 7 === 0 ? [note(1, "question", "Keep the 5m TTL?")] : [];
  const recent = [...questions.slice(-2), note(questions.length + 1, "note", `Rebased; ${"details ".repeat(150)}`)];
  return {
    ...parsed!, stage: STAGES[i % STAGES.length]!, stageSource: "coordinator", category: CATEGORIES[i % CATEGORIES.length]!,
    waitingOn: i % 3 === 0 ? `W${i}: ${"rebase onto dev ".repeat(20)}` : null,
    changes: i % 7 === 0 || i % 25 === 0 ? Array.from({ length: i % 25 === 0 ? 9 : 1 }, (_, c) => `change ${c}: ${"rename ".repeat(60)}`) : [],
    decision: i % 5 === 0 ? { text: `Keep it: ${"because ".repeat(80)}`, link: "D12", at: 1 } : null,
    notes: { count: recent.length + 40, recent, open: questions },
  };
}
const queue = (pullRequests: QueuedPullRequest[], error: string | null = null): MergeQueue => ({
  projectId: "p", login: "erwinkn", skipped: [], stages: PR_STAGES.map((s) => ({ ...s })), pullRequests,
  repos: [...new Set(pullRequests.map((p) => p.repo))].map((repo) => ({ repo, fetchedAt: 1, error, fetching: false, detailsFetchedAt: 1, detailsError: null })),
});
/** PR `number` of `repo` with nothing recorded but `fields`. */
const plain = (repo: string, number: number, fields: Partial<QueuedPullRequest> = {}): QueuedPullRequest => ({
  ...parsePullRequests(repo, JSON.stringify([{ number, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, headRefName: `h${number}`, baseRefName: "main", createdAt: new Date(Date.UTC(2026, 8, 1) + number * 60_000).toISOString() }]))[0]!,
  stage: "working", stageSource: "coordinator", ...fields,
});
const prs = linkStacks(Array.from({ length: 180 }, (_, i) => pr(i + 1)));
const big = queue(prs);
const needsAction = prs.filter((p) => p.waitingOn || p.notes.open.length || p.changes.length);
const size = (value: unknown) => JSON.stringify(value).length;
/** Reads refs page by page as an agent would, each continuation checked against the tool's schema; the PRs read. */
function walkRefs(q: MergeQueue, refs: string[]) {
  const seen: string[] = [];
  for (let offset: number | null = 0; offset !== null; ) {
    const input = agentReadSchema.parse({ view: "prs", refs, offset, limit: 30 });
    const page = prsByRef(q, input.refs!, { offset: input.offset!, limit: input.limit! });
    expect(size(page)).toBeLessThanOrEqual(PRS_READ_CHARS);
    if (page.page.total > offset) expect(Object.keys(page.prs).length).toBeGreaterThan(0);
    seen.push(...Object.keys(page.prs));
    offset = page.page.nextOffset;
  }
  return seen;
}

describe("T155 initiative_read {view:prs} is bounded", () => {
  it("answers a 180-PR queue with long histories under the cap by default: ten next, a page of the PRs needing action", () => {
    const read = prSummary(big);
    expect(size(read)).toBeLessThanOrEqual(PRS_READ_CHARS);
    expect(read.open).toBe(180);
    const available = prs.filter((p) => p.available).length;
    expect(read.next).toHaveLength(10);
    expect(read.moreNext).toBe(available - 10);
    expect(read.next[0]).toMatchObject({ pr: expect.stringMatching(/^(equisafe-market|infra)#\d+$/), title: expect.stringMatching(/…$/) });
    expect(read.noAction).toBe(180 - needsAction.length);
    expect(read.page.total).toBe(needsAction.length);
    // Every listed PR needs action, and the page says where the next one starts.
    const listed = Object.keys(read.state);
    expect(listed.length).toBeGreaterThan(0);
    expect(read.page.nextOffset).toBe(listed.length);
    expect(read.truncated === undefined).toBe(listed.length === 20);
    for (const entry of Object.values(read.state) as Record<string, string | string[] | undefined>[]) {
      expect("waitingOn" in entry || "questions" in entry || "changes" in entry).toBe(true);
      for (const line of [entry.waitingOn, entry.latestNote, entry.decision, ...(entry.questions ?? []), ...(entry.changes ?? [])].flat()) expect((line ?? "").length).toBeLessThanOrEqual(160);
    }
    // The PR with twelve huge questions lists three and counts the rest.
    const heavy = prSummary(big, { category: "CI", offset: 0, limit: 30 }).state["equisafe-market#1025"]!;
    expect(heavy.questions).toHaveLength(4);
    expect(heavy.questions!.at(-1)).toBe("+9 more");
    expect(heavy.changes!.at(-1)).toBe("+6 more");
  });

  it("cuts a page that would not fit, says so, and continues from where it stopped", () => {
    const read = prSummary(big, { offset: 0, limit: 30 });
    expect(size(read)).toBeLessThanOrEqual(PRS_READ_CHARS);
    const n = Object.keys(read.state).length;
    expect(n).toBeLessThan(30);
    expect(read.page.nextOffset).toBe(n);
    expect(read.truncated).toMatch(/state ends at page.nextOffset, read on with offset.*Narrow with category, stage or refs/);
    const after = prSummary(big, { offset: n, limit: 5 });
    expect(Object.keys(after.state)).not.toContain(Object.keys(read.state).at(-1));
    // Pages never overlap and, read to the end, cover every PR needing action once.
    const seen: string[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page = prSummary(big, { offset, limit: 30 });
      seen.push(...Object.keys(page.state));
      offset = page.page.nextOffset;
    }
    expect(seen).toHaveLength(needsAction.length);
    expect(new Set(seen).size).toBe(needsAction.length);
  });

  it("lists every PR of a category (any case) or stage (its exact id), and pages it", () => {
    const security = prs.filter((p) => p.category === "Security");
    const read = prSummary(big, { category: "security", offset: 0, limit: 5 });
    expect(read.matching).toBe(security.length);
    expect(read.noAction).toBeUndefined();
    expect(Object.keys(read.byCategory)).toEqual(["Security"]);
    expect(read.page).toEqual({ total: security.length, offset: 0, nextOffset: 5 });
    expect(Object.keys(read.state)).toHaveLength(5);
    expect(read.next.every((n) => n.category === "Security")).toBe(true);
    // A stack shows when any of its PRs is in the slice.
    expect(read.stacks!.length).toBeGreaterThan(0);

    const uncategorized = prSummary(big, { category: "Uncategorized", stage: "working", offset: 0, limit: 30 });
    expect(uncategorized.matching).toBe(prs.filter((p) => p.category === null && p.stage === "working").length);
    expect(Object.values(uncategorized.state).every((s) => s.stage === "working")).toBe(true);

    const none = prSummary(big, { category: "Nope", offset: 0, limit: 20 });
    expect(none).toMatchObject({ matching: 0, state: {}, categories: ["CI", "Payments", "Security", "Uncategorized"] });
  });

  it("reads whole PRs by ref: number, repo#number or URL, nothing clipped", () => {
    // #1007 and #1014 are in infra only; #1001 in equisafe-market only.
    const read = prsByRef(big, ["#1007", "equisafe-market#1001", "https://github.com/equisafe/infra/pull/1014", "infra#1001", "W12"]);
    expect(Object.keys(read.prs)).toEqual(["equisafe-market#1001", "infra#1007", "infra#1014"]);
    expect(read.missingRefs).toEqual(["infra#1001", "W12"]);
    const whole = read.prs["infra#1014"] as Record<string, unknown> & { questions?: string[]; changes?: string[]; recentNotes?: string[] };
    expect(whole).toMatchObject({ title: expect.not.stringMatching(/…$/), url: "https://github.com/equisafe/infra/pull/1014", stage: "experiment", category: "Security" });
    expect(whole.questions).toEqual(["n1 coordinator: Keep the 5m TTL?"]);
    expect(whole.changes![0]!.length).toBeGreaterThan(400);
    expect(whole.recentNotes).toHaveLength(2);
    expect(whole.recentNotes!.at(-1)!.length).toBeGreaterThan(1000);
    expect(read.truncated).toBeUndefined();
    expect(read.page).toEqual({ total: 3, offset: 0, nextOffset: null });
    // "#1001" with the same number in both repositories reads both.
    const both = queue(linkStacks([pr(1), { ...pr(1), repo: "equisafe/infra", url: "https://github.com/equisafe/infra/pull/1001" }]));
    expect(Object.keys(prsByRef(both, ["1001"]).prs)).toEqual(["equisafe-market#1001", "infra#1001"]);
  });

  it("pages a refs read that would not fit, with a continuation the tool accepts, and clips a PR too long alone", () => {
    const heavy = prs.filter((p) => p.notes.open.length > 1);
    const refs = heavy.map((p) => p.url);
    const read = prsByRef(big, refs);
    expect(size(read)).toBeLessThanOrEqual(PRS_READ_CHARS);
    // equisafe-market#1025 alone is longer than the cap: listed compact, and the page still advances.
    expect(Object.keys(read.prs)).toEqual(["equisafe-market#1025"]);
    expect(read.prs["equisafe-market#1025"]).toMatchObject({ clipped: true, questions: expect.arrayContaining(["+9 more"]) });
    expect(read.page).toEqual({ total: heavy.length, offset: 0, nextOffset: 1 });
    expect(read.truncated).toMatch(/prs ends at page.nextOffset, read on with the same refs and offset; a PR marked clipped/);
    expect(walkRefs(big, refs)).toEqual(heavy.map((p) => `${p.repo.split("/")[1]}#${p.number}`));
    // Two PRs of moderate size: both whole.
    expect(Object.keys(prsByRef(big, ["#1007", "#1014"]).prs)).toHaveLength(2);
  });

  it("counts byCategory when the PR numbers would not fit, and lists the stacks that fit", () => {
    const huge = queue(linkStacks(Array.from({ length: 2000 }, (_, i) => ({ ...pr(i + 1), waitingOn: null, changes: [], notes: { count: 0, recent: [], open: [] } }))));
    const read = prSummary(huge);
    expect(size(read)).toBeLessThanOrEqual(PRS_READ_CHARS);
    expect(read.byCategory.CI).toMatchObject({ working: expect.any(Number) });
    expect(read.stacks).toHaveLength(huge.pullRequests.filter((p) => p.stack?.level === 1).length);
    expect(read.truncated).toMatch(/^Cut to fit 20000 characters: byCategory counts the PRs\. /);
    // 1,500 stacks of two PRs in long-named repositories: the first ones, and a count of the rest.
    const repos = ["equisafe/a-repository-with-a-rather-long-name", "equisafe/another-repository-with-a-long-name"];
    const stacked = queue(linkStacks(Array.from({ length: 3000 }, (_, i) => plain(repos[i % 2]!, 1 + Math.floor(i / 2), { base: i % 4 < 2 ? "main" : `h${Math.floor(i / 2)}` }))));
    const cut = prSummary(stacked);
    expect(size(cut)).toBeLessThanOrEqual(PRS_READ_CHARS);
    expect(cut.stacks.length).toBeGreaterThan(0);
    expect(cut.truncated).toMatch(new RegExp(`byCategory counts the PRs; ${1500 - cut.stacks.length} stacks left out`));
  });

  it("W352 #4: thirty refs matching sixty long PRs page through them all with schema-valid continuations", () => {
    const questions = Array.from({ length: 10 }, (_, q) => note(q + 1, "question", "why ".repeat(125)));
    const many = queue(linkStacks(["equisafe/a", "equisafe/b"].flatMap((repo) =>
      Array.from({ length: 30 }, (_, i) => plain(repo, i + 1, { waitingOn: "W1", notes: { count: 10, recent: questions.slice(-3), open: questions } })))));
    const refs = Array.from({ length: 30 }, (_, i) => `#${i + 1}`);
    const first = prsByRef(many, refs);
    expect(Object.keys(first.prs).length).toBeLessThan(60);
    expect(first.page.total).toBe(60);
    const seen = walkRefs(many, refs);
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });

  it("W352 #1: an actionable 2,000-PR queue pages through every PR needing action, each page advancing", () => {
    const repos = Array.from({ length: 10 }, (_, r) => `equisafe/repo-${r}`);
    const huge = queue(linkStacks(Array.from({ length: 2000 }, (_, i) =>
      plain(repos[i % 10]!, 1 + Math.floor(i / 10), { category: ["CI", "Security", "Payments", "Ops"][i % 4]!, waitingOn: `W${i}` }))));
    const first = prSummary(huge);
    expect(first.byCategory.CI).toMatchObject({ working: 500 });
    expect(first.truncated).toMatch(/byCategory counts the PRs/);
    const seen: string[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page = prSummary(huge, { offset, limit: 30 });
      expect(size(page)).toBeLessThanOrEqual(PRS_READ_CHARS);
      expect(Object.keys(page.state).length).toBeGreaterThan(0);
      seen.push(...Object.keys(page.state));
      offset = page.page.nextOffset;
    }
    expect(seen).toHaveLength(2000);
    expect(new Set(seen).size).toBe(2000);
  });

  it("W352 #2: the cap holds with many repositories, long repository errors, thousands of categories, and a refs read matching 2,000 PRs", () => {
    const repos = Array.from({ length: 67 }, (_, r) => `equisafe-organization/repository-number-${r}`);
    const wide = linkStacks(Array.from({ length: 2000 }, (_, i) => plain(repos[i % 67]!, 1 + Math.floor(i / 67), { category: `Category ${i}`, waitingOn: `W${i}` })));
    const refs = Array.from({ length: 30 }, (_, i) => `#${i + 1}`);
    const broken = queue(wide, "gh: ".repeat(5500));
    const reads = [prSummary(broken), prSummary(broken, { category: "Nope", offset: 0, limit: 30 }), prSummary(broken, { stage: "working", offset: 0, limit: 30 }), prsByRef(broken, refs, { offset: 0, limit: 30 })];
    for (const read of reads) {
      expect(size(read)).toBeLessThanOrEqual(PRS_READ_CHARS);
      expect(read.repos[0]!.error!.length).toBeLessThanOrEqual(160);
      // The repositories take what the page leaves; those left out are counted.
      if (read.repos.length < 67) expect(read.truncated).toMatch(new RegExp(`\\b${67 - read.repos.length} repositories left out`));
    }
    expect(reads.some((read) => read.repos.length < 67)).toBe(true);
    expect(prSummary(broken).truncated).toMatch(/byCategory counts the PRs; \d+ categories left out/);
    expect(prSummary(broken, { category: "Nope", offset: 0, limit: 30 }).truncated).toMatch(/\d+ category names left out/);
    const byRef = prsByRef(broken, refs, { offset: 0, limit: 30 });
    expect(byRef.page.total).toBe(2000);
    expect(Object.keys(byRef.prs).length).toBeGreaterThan(0);
  });

  it("holds the cap and advances with every field at its longest: names, titles, notes, refs", () => {
    const long = (text: string, n: number) => text.repeat(Math.ceil(n / text.length)).slice(0, n);
    const notes = (n: number) => Array.from({ length: n }, (_, k) => note(k + 1, "question", long("why ", 1000)));
    const worst = linkStacks(Array.from({ length: 300 }, (_, i) => plain(`${String.fromCharCode(97 + (i % 26)).repeat(39)}/${"r".repeat(100)}`, 1_000_000_000 + i, {
      title: long("Title ", 256), category: `${long("c", 38)}${i % 50}`, stageNote: long("note ", 200), available: true,
      waitingOn: long("wait ", 160), changes: Array.from({ length: 10 }, () => long("change ", 200)),
      decision: { text: long("decided ", 300), link: long("https://example.com/", 300), at: 1 },
      worker: { ref: "W123456", assignment: "A123456", role: "review" } as QueuedPullRequest["worker"],
      notes: { count: 99, recent: notes(3), open: notes(10) },
    })));
    const longest = queue(worst, long("gh: failed ", 22_000));
    const missing = Array.from({ length: 30 }, (_, i) => `https://github.com/${"z".repeat(39)}/${long("x", 230)}/pull/${i}`.slice(0, 300));
    expect(walkRefs(longest, [...missing.slice(0, 20), ...worst.slice(0, 10).map((p) => p.url)])).toHaveLength(10);
    expect(size(prsByRef(longest, missing))).toBeLessThanOrEqual(PRS_READ_CHARS);
    for (const read of [{ offset: 0, limit: 30 }, { category: "nope", offset: 0, limit: 30 }, { stage: "working", offset: 0, limit: 30 }]) {
      for (let offset: number | null = 0; offset !== null; ) {
        const page = prSummary(longest, { ...read, offset });
        expect(size(page)).toBeLessThanOrEqual(PRS_READ_CHARS);
        if (page.page.total) expect(Object.keys(page.state).length).toBeGreaterThan(0);
        offset = page.page.nextOffset;
      }
    }
  });

  it("W352 #3: a refs read matching 2,000 PRs with long notes takes milliseconds", () => {
    const repos = Array.from({ length: 67 }, (_, r) => `equisafe/repository-${r}`);
    const recent = Array.from({ length: 3 }, (_, n) => note(n + 1, "note", "x".repeat(1000)));
    const matched = queue(linkStacks(Array.from({ length: 2000 }, (_, i) => plain(repos[i % 67]!, 1 + Math.floor(i / 67), { notes: { count: 3, recent, open: [] } }))));
    const refs = Array.from({ length: 30 }, (_, i) => `#${i + 1}`);
    prsByRef(matched, refs);
    const started = performance.now();
    const read = prsByRef(matched, refs, { offset: 0, limit: 30 });
    const took = performance.now() - started;
    expect(read.page.total).toBe(2000);
    expect(size(read)).toBeLessThanOrEqual(PRS_READ_CHARS);
    expect(took).toBeLessThan(250);
  });

  it("W352 #5: reads back every PR ref initiative_pr takes or a read names, up to GitHub's longest names", () => {
    const repo = "r".repeat(100);
    const both = queue(linkStacks([plain(`${"a".repeat(39)}/${repo}`, 2_147_483_647), plain(`${"b".repeat(39)}/${repo}`, 2_147_483_647)]));
    const emitted = Object.keys(prSummary(both, { stage: "working", offset: 0, limit: 30 }).state);
    expect(emitted[0]).toBe(`${"a".repeat(39)}/${repo}#2147483647`);
    const url = `https://github.com/${"a".repeat(39)}/${repo}/pull/2147483647/files?diff=split#discussion_r${"1".repeat(80)}`;
    expect(prToolSchema.safeParse({ prs: [{ url, stage: "working" }] }).success).toBe(true);
    for (const ref of [...emitted, url, both.pullRequests[1]!.url]) {
      expect(agentReadSchema.safeParse({ view: "prs", refs: [ref] }).success).toBe(true);
      expect(readOptionsSchema.safeParse({ refs: [ref] }).success).toBe(true);
      expect(Object.keys(prsByRef(both, [ref]).prs)).toHaveLength(1);
    }
    // A short alias names every owner's repository of that name.
    expect(Object.keys(prsByRef(both, [`${repo}#2147483647`]).prs)).toEqual(emitted);
  });

  it("goes through the tool: category and stage need view prs, refs read whole PRs", async () => {
    const { f } = await projectFixture();
    const call = async (input: unknown) => JSON.parse(await f.harness.callAgentTool("initiative_read", input, { threadId: "coordinator" }) as string);
    expect(await call({ view: "prs", stage: "in-review", limit: 5 })).toMatchObject({ matching: 0, page: { total: 0, offset: 0, nextOffset: null } });
    await expect(call({ view: "prs", stage: "nope" })).rejects.toThrow();
    await expect(call({ category: "CI" })).rejects.toThrow(/category and stage select a slice of view prs/);
    expect(await call({ view: "prs", refs: ["#1"], offset: 3, limit: 2 })).toMatchObject({ prs: {}, missingRefs: ["#1"], page: { total: 0, offset: 3, nextOffset: null } });
  });
});

describe("T155 initiative_read {view:workers} lists the live workers first, then the most recent", () => {
  it("puts retired workers last and pages consistently", async () => {
    const { f, project } = await projectFixture();
    for (let n = 1; n <= 40; n++) f.store.createWorker({ projectId: project.id, label: `Worker ${n}`, role: "work", area: "Fixture", bbProjectId: "proj_a" });
    for (let n = 1; n <= 40; n++) if (![3, 17, 38].includes(n)) f.store.updateWorker(project.id, n, { state: "retired" });
    const call = async (input: unknown) => JSON.parse(await f.harness.callAgentTool("initiative_read", input, { threadId: "coordinator" }) as string);
    const first = await call({ view: "workers", limit: 5 });
    expect(first.items.map((w: { ref: string }) => w.ref)).toEqual(["W38", "W17", "W3", "W40", "W39"]);
    expect(first).toMatchObject({ total: 40, nextOffset: 5 });
    const second = await call({ view: "workers", offset: 5, limit: 3 });
    expect(second.items.map((w: { ref: string }) => w.ref)).toEqual(["W37", "W36", "W35"]);
  });
});
