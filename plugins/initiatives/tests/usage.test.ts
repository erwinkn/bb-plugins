import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, Store, zeroTotals, type TokenTotals, type UsageRecord } from "../lib/store";
import { buildUsage, summarizeTurns } from "../lib/usage";
import { buildOverview } from "../lib/overview";
import { memoryStore } from "./helpers";
import { projectFixture } from "./fake-native";

const totals = (total: number): TokenTotals => ({ input: total, cachedInput: 0, output: 0, reasoningOutput: 0, total });
function saved(threadId: string, workerNum: number, amount: TokenTotals | null): Omit<UsageRecord, "updatedAt"> {
  return {
    threadId, projectId: "p", workerNum, lastSeq: 2, providerThreadId: "session",
    sessionTotals: amount, closedTotals: zeroTotals(), resets: 0,
    lastReportAt: amount ? 200 : null,
    contextUsed: null, contextWindow: null, model: null,
  };
}
function storeFixture() {
  const f = memoryStore();
  f.store.createProject({ id: "p", name: "Usage", objective: "Observe", memberProjectIds: ["repo"], coordinatorThreadId: "c1" });
  return f;
}
const event = (type: string, seq: number, at: number, turnId: string | null, data: object = {}) => ({
  id: String(seq), threadId: "coordinator", type, seq, createdAt: at,
  scope: turnId ? { kind: "turn", turnId } : { kind: "thread" }, data,
});
const nativeTotals = (t: TokenTotals) => ({
  totalTokens: t.total, inputTokens: t.input, cachedInputTokens: t.cachedInput,
  outputTokens: t.output, reasoningOutputTokens: t.reasoningOutput,
});
const token = (seq: number, t: TokenTotals, providerThreadId = "session") =>
  event("thread/tokenUsage/updated", seq, seq * 100, null, {
    providerThreadId, tokenUsage: { total: nativeTotals(t), last: nativeTotals(t) },
  });

describe("observed Initiative usage", () => {
  it("counts distinct threads across assignments, generations, forks, ownership and retained history", () => {
    const { store } = storeFixture();
    const w = store.createWorker({ projectId: "p", role: "work", label: "Builder", area: "api", bbProjectId: "repo" });
    store.updateWorker("p", w.num, { threadId: "w2", generation: 2, state: "retired" });
    store.openGeneration("p", w.num, 1, "w1");
    store.closeGeneration("p", w.num, "superseded");
    store.openGeneration("p", w.num, 2, "w2");
    for (let index = 0; index < 3; index++) store.createAssignment({
      projectId: "p", workerNum: w.num, taskNums: [], route: "continue", role: "work",
      workKind: "implementation", threadId: "w2", generation: 2,
      profile: { providerId: "codex", model: "test", reasoningLevel: "high" },
      bbProjectId: "repo", environmentId: "env", state: "accepted",
      opId: `op${index}`, opState: "done", briefText: "b", reviewOf: null, rationale: null,
    });
    const fork = store.createWorker({ projectId: "p", role: "work", label: "Fork", area: "api", bbProjectId: "repo", forkedFrom: w.num });
    store.updateWorker("p", fork.num, { threadId: "fork", generation: 1 });
    store.openGeneration("p", fork.num, 1, "fork");
    store.setCoordinator("p", "c2", "replacement");
    store.associateProjectThread({ projectId: "p", opId: "user", threadId: "user", label: "My conversation", bbProjectId: "repo" });
    store.associateNestedThread({ projectId: "p", threadId: "nested", label: "Nested conversation", bbProjectId: "repo" });
    // A retained observation with no surviving current worker row still counts.
    for (const [id, num, count] of [["c1",0,10],["c2",0,20],["w1",w.num,30],["w2",w.num,40],["fork",fork.num,50],["user",-1,60],["nested",-1,70],["retained",9,80]] as const) {
      store.saveUsage(saved(id, num, totals(count)));
    }
    const usage = buildUsage(store, "p", new Map([["c2", { status: "active", archived: false, title: "Coordinator" }]]));
    expect(usage.recordedThreads).toBe(8);
    expect(usage.reportingThreads).toBe(8);
    expect(usage.totals?.total).toBe(360);
    expect(usage.coordinator.generations).toHaveLength(2);
    expect(usage.coordinator.totals?.total).toBe(30);
    expect(usage.workers[0]).toMatchObject({ recordedThreads: 2, totals: { total: 70 }, state: "retired" });
    expect(usage.workers).toHaveLength(3);
    expect(usage.workers[2]).toMatchObject({ ref: "W9", totals: { total: 80 } });
    expect(usage.workers[1]).toMatchObject({ forkedFrom: "W1", totals: { total: 50 } });
    expect(usage.conversations).toMatchObject({ recordedThreads: 2, totals: { total: 130 } });
    expect(usage.activeStaleThreads).toBe(1);
    expect(usage.threads.find(row => row.threadId === "w1")?.retained).toBe(true);
    expect(usage.threads.find(row => row.threadId === "user")?.ownership).toBe("user");
    expect(store.membership("user")?.workerNum).toBe(-1);
    expect(usage.profileGroups).toHaveLength(1);
  });

  it("leaves no-observation tokens, context, provider/model and turn coverage unknown", () => {
    const { store } = storeFixture();
    const usage = buildUsage(store, "p", new Map());
    expect(usage.totals).toBeNull();
    expect(usage.reportingThreads).toBe(0);
    expect(usage.threads[0]).toMatchObject({
      profile: null, firstObservedAt: null, lastObservedAt: null,
      totals: null, context: { used: null, window: null, estimated: null },
      turns: { observedCompletions: null, elapsedMs: null, paired: null },
    });
  });

  it("preserves old SQLite counters and legacy unknown provenance through additive migrations", () => {
    const db = new Database(":memory:");
    const firstNew = MIGRATIONS.findIndex(statement => statement.includes("ADD COLUMN context_observed_at"));
    for (const statement of MIGRATIONS.slice(0, firstNew)) db.exec(statement);
    db.prepare(`INSERT INTO usage (thread_id,project_id,worker_num,last_seq,provider_thread_id,session_totals,closed_totals,resets,last_report_at,model,updated_at)
      VALUES ('legacy','p',0,20,'old',?,?,2,100,'old-latest-model',200)`)
      .run(JSON.stringify(totals(500)), JSON.stringify(totals(100)));
    for (const statement of MIGRATIONS.slice(firstNew)) db.exec(statement);
    const store = new Store(db, () => 300);
    const old = store.usage("legacy")!;
    expect(old).toMatchObject({
      lastSeq: 20, sessionTotals: { total: 500 }, closedTotals: { total: 100 }, resets: 2,
      model: "old-latest-model", firstObservedAt: null, lastObservedAt: null, profileObservation: null,
    });
    store.saveUsage(old);
    expect(store.usage("legacy")).toMatchObject({ sessionTotals: { total: 500 }, profileObservation: null });
    db.close();
  });

  it("groups source-observed provider/model profiles, and keeps changed historical profiles mixed", () => {
    const { store } = storeFixture();
    const record = saved("c1",0,totals(400));
    record.model = "legacy-is-not-proof";
    store.saveUsage(record);
    expect(buildUsage(store,"p",new Map()).profileGroups[0]).toMatchObject({ providerId: null, model: null, historicalAttribution: "unknown" });
    record.profileObservation = {
      first: { providerId: "codex", model: "a", at: 100 },
      last: { providerId: "codex", model: "b", at: 200 }, mixed: true,
    };
    store.saveUsage(record);
    const group = buildUsage(store,"p",new Map()).profileGroups[0]!;
    expect(group).toMatchObject({ providerId: null, model: null, historicalAttribution: "mixed", totals: { total: 400 } });
    expect(group.threads[0]?.profile?.last.model).toBe("b");
  });
});

describe("bounded idle observations", () => {
  async function sampled(rows: ReturnType<typeof event>[], providerId: string, model: string | null) {
    const { f, project } = await projectFixture();
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, providerId });
    if (model) f.execution.set("coordinator", { model, reasoningLevel: "high" });
    else f.harness.sdk.stub("threads.defaultExecutionOptions", async () => null as any);
    const calls: any[] = [];
    f.harness.sdk.stub("threads.events.list", async (args: any) => {
      calls.push(args);
      const filtered = rows.filter(row => row.seq > Number(args.afterSeq ?? 0) && args.types.includes(row.type));
      return [...filtered].sort((a,b) => args.order === "desc" ? b.seq-a.seq : a.seq-b.seq).slice(0, Number(args.limit) * args.types.length) as any;
    });
    await f.runtime.sampleUsage(f.store.membership("coordinator")!, "coordinator");
    return { f, project, calls };
  }

  it.each([
    ["claude-code","claude-test", { input: 102, cachedInput: 8456748, output: 86131, reasoningOutput: 0, total: 8542981 }],
    ["codex","gpt-test", { input: 2500508, cachedInput: 2375552, output: 13416, reasoningOutput: 5205, total: 2513924 }],
  ] as const)("preserves %s native totals and components without deriving total", async (providerId, model, amount) => {
    const { f, project, calls } = await sampled([token(2, amount)], providerId, model);
    const usage = buildOverview(f.store, project.id, new Map(), f.store.now()).usage;
    expect(usage.totals?.total).toEqual(amount.total);
    expect(usage.threads[0]?.totals).toEqual(amount);
    expect(usage.profileGroups[0]).toMatchObject({ providerId, model, historicalAttribution: "unknown" });
    expect(usage.threads[0]?.profile?.first.at).toBeLessThanOrEqual(f.store.now());
    expect(usage.threads[0]?.firstObservedAt).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls.every(args => Number(args.limit) * args.types.length <= 100)).toBe(true);
    expect(calls[1].types).toEqual(["turn/started","turn/completed"]);
    await f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator");
    expect(f.store.usage("coordinator")?.sessionTotals).toEqual(amount);
    expect(f.store.usage("coordinator")?.resets).toBe(0);
  });

  it("leaves Devin tokens unavailable while retaining context and completed-turn observations", async () => {
    const rows = [
      event("turn/started",1,1000,"t"),
      event("thread/contextWindowUsage/updated",2,2000,null,{ contextWindowUsage: { usedTokens:126722, modelContextWindow:262000, estimated:false } }),
      event("turn/completed",3,4000,"t",{status:"completed"}),
    ];
    const { f, project } = await sampled(rows,"acp-devin","devin-native");
    const usage = buildUsage(f.store,project.id,new Map());
    expect(usage.totals).toBeNull();
    expect(usage.reportingThreads).toBe(0);
    expect(usage.threads[0]).toMatchObject({
      context: { used:126722, window:262000, estimated:false, at:2000 },
      turns: { observedCompletions:1, completed:1, paired:1, elapsedMs:3000 },
    });
  });

  it("keeps absent token fields unavailable, including across reset epochs", async () => {
    const incomplete: TokenTotals = { input:100, cachedInput:null, output:2, reasoningOutput:null, total:102 };
    const { f } = await sampled([token(1,incomplete),token(2,totals(20),"new-session")],"codex",null);
    const row = f.store.usage("coordinator")!;
    expect(row.closedTotals).toEqual(incomplete);
    expect(row.sessionTotals?.total).toBe(20);
    expect(row.resets).toBe(1);
    expect(row.profileObservation?.last.model).toBeNull();
  });

  it("advances independent turn cursor, persists missing pairs and deduplicates duplicate events", async () => {
    const rows = [
      event("turn/started",1,1000,"a"),
      event("turn/completed",2,2000,"a",{ status:"completed" }),
      event("turn/completed",3,2500,"a",{ status:"failed" }),
      event("turn/completed",4,3000,"b",{ status:"interrupted" }),
      event("turn/completed",5,4000,null,{ status:"failed" }),
      event("turn/completed",6,5000,"c",{ status:"unknown-native" }),
    ];
    const { f } = await sampled(rows,"codex","test");
    const before = summarizeTurns(f.store.usageTurns("coordinator"),true);
    expect(before).toMatchObject({ observedCompletions:4, completed:1, failed:1, interrupted:1, unknownStatus:1, paired:1, elapsedMs:1000, unpaired:3 });
    expect(f.store.turnCursor("coordinator")).toMatchObject({ lastSeq:6, firstObservedAt:1000, lastObservedAt:5000 });
    await f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator");
    expect(summarizeTurns(f.store.usageTurns("coordinator"),true)).toEqual(before);
    expect(f.store.usage("coordinator")).toBeNull();
    expect(buildUsage(f.store, f.store.membership("coordinator")!.project.id, new Map()).lastObservedAt).toBe(5000);
  });

  it("records an observed model change without moving full totals into the latest model group", async () => {
    const rows = [token(1,totals(100))];
    const { f, project } = await sampled(rows,"codex","a");
    f.execution.set("coordinator",{model:"b",reasoningLevel:"high"});
    rows.push(event("thread/contextWindowUsage/updated",2,200,null,{contextWindowUsage:{usedTokens:10,modelContextWindow:100}}));
    await f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator");
    expect(f.store.usage("coordinator")?.profileObservation).toMatchObject({
      first:{model:"a"},last:{model:"b"},mixed:true,
    });
    expect(buildUsage(f.store,project.id,new Map()).profileGroups[0]).toMatchObject({
      providerId:null,model:null,historicalAttribution:"mixed",totals:{total:100},
    });
  });

  it("continues legacy sampling without inventing a first observation or duplicating old epochs", async () => {
    const rows = [token(3,totals(200),"new")];
    const { f, project } = await projectFixture();
    f.store.saveUsage({...saved("coordinator",0,totals(100)),projectId:project.id,firstObservedAt:null});
    f.harness.sdk.stub("threads.events.list",async(args:any) => rows.filter(row => args.types.includes(row.type)) as any);
    await f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator");
    const record = f.store.usage("coordinator")!;
    expect(record.firstObservedAt).toBeNull();
    expect(record.closedTotals.total).toBe(100);
    expect(record.sessionTotals?.total).toBe(200);
    expect(record.resets).toBe(1);
    await f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator");
    expect(f.store.usage("coordinator")?.resets).toBe(1);
  });

  it("preserves tokens and turn observations when provider/model lookups are unavailable", async () => {
    const { f, project } = await projectFixture();
    const rows = [token(1,totals(100)),event("turn/completed",2,500,null,{status:"failed"})];
    f.harness.sdk.stub("threads.events.list",async(args:any)=>rows.filter(row=>args.types.includes(row.type)) as any);
    f.harness.sdk.stub("threads.get",async()=>{throw new Error("503 unavailable")});
    f.harness.sdk.stub("threads.defaultExecutionOptions",async()=>{throw new Error("503 unavailable")});
    await f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator");
    const usage = buildUsage(f.store, project.id, new Map());
    expect(usage.totals?.total).toBe(100);
    expect(usage.profileGroups[0]).toMatchObject({providerId:null,model:null,historicalAttribution:"unknown"});
    expect(usage.threads[0]?.turns).toMatchObject({observedCompletions:1,failed:1,elapsedMs:null});
  });

  it("coalesces overlapping idle samples for the same thread", async () => {
    const { f } = await projectFixture();
    const calls: any[] = [];
    f.harness.sdk.stub("threads.events.list",async(args:any)=>{calls.push(args); await Promise.resolve(); return []});
    await Promise.all([
      f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator"),
      f.runtime.sampleUsage(f.store.membership("coordinator")!,"coordinator"),
    ]);
    expect(calls).toHaveLength(2);
  });

  it("samples a newly associated user child on its first idle without granting worker authority", async () => {
    const { f, project } = await projectFixture();
    const child = await f.spawn({ projectId:"proj_a",parentThreadId:"coordinator" });
    const row = token(1,totals(80));
    f.harness.sdk.stub("threads.events.list",async(args:any)=>args.threadId===child.id && args.types.includes(row.type) ? [row] as any : []);
    await f.runtime.onThreadIdle(child);
    // onThreadIdle deliberately starts the bounded sampler without delaying lifecycle settlement.
    await f.runtime.sampleUsage(f.store.membership(child.id)!,child.id);
    expect(f.store.membership(child.id)?.workerNum).toBe(-1);
    expect(buildUsage(f.store,project.id,new Map()).conversations.totals?.total).toBe(80);
  });
});
