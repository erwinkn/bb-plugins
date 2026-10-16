import { describe, expect, it } from "vitest";
import { memoryStore, brief } from "./helpers";
import { parsePullRequests, type MergeQueue, type QueuedPullRequest } from "../lib/merge-queue";
import { PR_STAGES } from "../lib/pr-stages";
import { isPrRef, MAX_READ_BYTES, readOptionsSchema, readMixedRefs } from "../lib/read";

const pr = (repo: string, number: number): QueuedPullRequest => ({
  ...parsePullRequests(repo, [{ number, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, headRefName: `h${number}`, baseRefName: "main", createdAt: new Date(Date.UTC(2026, 8, 1)).toISOString() }])[0]!,
  stage: "working", stageSource: "coordinator",
});
const queue = (pullRequests: QueuedPullRequest[]): MergeQueue => ({
  projectId: "p", login: "erwinkn", skipped: [], stages: PR_STAGES.map((s) => ({ ...s })), pullRequests,
  repos: [...new Set(pullRequests.map((p) => p.repo))].map((repo) => ({ repo, fetchedAt: 1, error: null, fetching: false, detailsFetchedAt: 1, detailsError: null })),
});
const q = queue([pr("equisafe/equisafe-market", 2529), pr("equisafe/infra", 12)]);
const setup = () => {
  const { store } = memoryStore();
  store.createProject({ id: "p", name: "P", objective: "Review", memberProjectIds: [], coordinatorThreadId: null });
  store.createTask({ projectId: "p", title: "A task", summary: "s", brief: brief(), priority: 2, dependsOn: [], workKind: "implementation", profileOverride: null, profileSource: null });
  return store;
};
const read = (refs: string[]) => readMixedRefs(setup(), "p", readOptionsSchema.parse({ refs }), q) as any;

describe("T158 initiative_read takes PR refs without view prs", () => {
  it.each(["#2529", "equisafe-market#2529", "equisafe/equisafe-market#2529", "https://github.com/equisafe/equisafe-market/pull/2529", " #2529 "])("%s reads the PR", (ref) => {
    const out = read([ref]);
    expect(Object.keys(out.prs)).toEqual(["equisafe-market#2529"]);
    expect(out.missingRefs).toBeUndefined();
  });

  it("tells PR refs from durable and native ones", () => {
    expect(["#1", "infra#1", "a/b#1", "https://github.com/a/b/pull/1"].every(isPrRef)).toBe(true);
    expect(["T12", "W3", "D4", "12", "thr_abc", "#x", "#"].some(isPrRef)).toBe(false);
  });

  it("returns PRs and durable records together", () => {
    const out = read(["T1", "#2529", "infra#12"]);
    expect(out.items.map((i: any) => i.ref)).toEqual(["T1"]);
    expect(Object.keys(out.pullRequests.prs)).toEqual(["equisafe-market#2529", "infra#12"]);
    expect(out.missingRefs).toEqual([]);
  });

  it("lists unknown PR refs as missing, not an error", () => {
    expect(read(["#9999"])).toMatchObject({ prs: {}, missingRefs: ["#9999"] });
    const mixed = read(["T1", "T99", "#9999"]);
    expect(mixed.missingRefs).toEqual(["T99", "#9999"]);
    expect(mixed.pullRequests.prs).toEqual({});
  });

  it("keeps the whole response under the read cap", () => {
    const many = queue(Array.from({ length: 200 }, (_, i) => ({ ...pr("equisafe/infra", 1000 + i), title: "long title ".repeat(30) })));
    const { store } = memoryStore();
    store.createProject({ id: "p", name: "P", objective: "Review", memberProjectIds: [], coordinatorThreadId: null });
    for (let i = 0; i < 30; i++) store.createTask({ projectId: "p", title: `T${i}`.repeat(40), summary: "s".repeat(390), brief: brief(), priority: 2, dependsOn: [], workKind: "implementation", profileOverride: null, profileSource: null });
    const refs = [...Array.from({ length: 15 }, (_, i) => `T${i + 1}`), ...Array.from({ length: 15 }, (_, i) => `#${1000 + i}`)];
    const out = readMixedRefs(store, "p", readOptionsSchema.parse({ refs, limit: 30 }), many) as any;
    expect(JSON.stringify(out).length).toBeLessThan(MAX_READ_BYTES);
    expect(out.items.length).toBeGreaterThan(0);
  });
});
