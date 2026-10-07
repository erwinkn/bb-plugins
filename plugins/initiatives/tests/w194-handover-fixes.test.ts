import { describe, expect, it, vi } from "vitest";
import { projectFixture } from "./fake-native";
import { clearCatalogCache } from "../lib/bb";
import { captureHandoverSnapshot, handoverFingerprint, readHandoverState } from "../lib/handover-snapshot";
import { fallbackBody, handoverPacket } from "../lib/handover-packet";
import { redactCredentials } from "../lib/redact";
import { loadCase, replayDestination, replaySdk, replayStore } from "./handover-replay";

// W194's review of the W188 handover batch: each probe, turned into the behaviour it asked for.
type Fx = Awaited<ReturnType<typeof projectFixture>>["f"];
let seq = 90_000;
function luna(f: Fx) {
  f.execution.set("catalog-probe", { model: "gpt-6-luna", reasoningLevel: "high" });
  clearCatalogCache();
}
function turn(f: Fx, threadId: string, input: string, reply: string, initiator = "user") {
  const request = `creq_${++seq}`, at = Date.now();
  f.history.push({ threadId, type: "client/turn/requested", seq: ++seq, createdAt: at, data: { requestId: request, initiator, input: [{ type: "text", text: input }] } });
  f.history.push({ threadId, type: "turn/started", seq: ++seq, createdAt: at });
  f.history.push({ threadId, type: "turn/input/accepted", seq: ++seq, createdAt: at, data: { clientRequestId: request } });
  f.history.push({ threadId, type: "item/completed", seq: ++seq, createdAt: at, data: { item: { type: "agentMessage", id: `m${seq}`, text: reply } } });
  f.history.push({ threadId, type: "turn/completed", seq: ++seq, createdAt: at + 1, data: { status: "completed" } });
}
const writers = (f: Fx) => f.spawn.mock.calls.filter(([args]: any) => args.pluginMetadata?.role === "handover-writer").map(([args]: any) => args);
const coordinators = (f: Fx) => f.spawn.mock.calls.filter(([args]: any) => args.pluginMetadata?.role === "coordinator").map(([args]: any) => args);
async function finishWriter(f: Fx, projectId: string, text: string) {
  const writer = f.store.handoverDraft(projectId)!.threadId!;
  turn(f, writer, "Write the handover", text, "agent");
  await f.runtime.onThreadIdle(f.idle(writer));
}
const destination = (f: Fx, projectId: string) => (f.service as any).handoverDestination(projectId);

describe("W194 #1: recovery from a missing coordinator converges", () => {
  it("a 404 on the coordinator's history is a stable 'absent', so one Luna draft starts the replacement", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.threads.delete("coordinator");
    let tick = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => ++tick);
    try {
      f.intercept((path, args, call) => {
        if (path === "threads.events.list" && args.threadId === "coordinator") throw Object.assign(new Error("Thread not found"), { status: 404 });
        return call();
      });
      await f.service.replaceCoordinator(project.id, { reason: "Recover missing incumbent" });
      expect(JSON.parse(f.store.handoverDraft(project.id)!.fingerprint!).coordinator).toMatchObject({ user: "absent", activity: "absent", status: "absent" });
      await finishWriter(f, project.id, "Continue the current work; the outgoing coordinator is gone.");
      expect(writers(f)).toHaveLength(1);
      expect(coordinators(f)).toHaveLength(1);
      expect(coordinators(f)[0].prompt).toContain("Continue the current work; the outgoing coordinator is gone.");
    } finally {
      now.mockRestore();
    }
  });
});

describe("W194 #2: everything the packet shows is in the fingerprint", () => {
  const fixture = () => {
    const fx = loadCase("marbre-craie");
    return { fx, store: replayStore(fx), sdk: replaySdk(fx), print: () => handoverFingerprint(replaySdk(fx), replayStore(fx), fx.projectId, { destination: replayDestination(fx) }) };
  };
  it("a native worker's status", async () => {
    const { fx, print } = fixture();
    const before = await print();
    const w50 = replayStore(fx).workers(fx.projectId).find(w => w.ref === "W50")!;
    fx.threads[w50.threadId!] = { status: "error", title: null, parentThreadId: fx.oldCoordinator, createdAt: null, archivedAt: null, queued: 0, background: 0 };
    expect(await print()).not.toBe(before);
  });
  it("an unregistered native child", async () => {
    const { fx, print } = fixture();
    const before = await print();
    fx.threads.thr_newchild = { status: "active", title: "New unregistered implementation", parentThreadId: fx.oldCoordinator, createdAt: fx.replacementAt, archivedAt: null, queued: 0, background: 0 };
    expect(await print()).not.toBe(before);
  });
  it("the destination checkout", async () => {
    const fx = loadCase("red-metal");
    const print = () => handoverFingerprint(replaySdk(fx), replayStore(fx), fx.projectId, { destination: replayDestination(fx) });
    const before = await print();
    fx.checkout!.behind += 1;
    expect(await print()).not.toBe(before);
  });
  it("and a failed read is stable, never a fresh timestamp", async () => {
    const { fx, store, sdk } = fixture();
    const read = () => readHandoverState(sdk, store, fx.projectId, { destination: async () => { throw new Error("no environment"); } });
    expect(await read()).toEqual(await read());
    expect((await read()).checkout).toBe("unavailable");
  });
});

describe("W194 #3: the draft is checked again at the spawn boundary", () => {
  it("a coordinator turn that lands during the last lookups sends the replacement back to Luna", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.idle("coordinator");
    await f.service.startHandoverDraft(project.id);
    await finishWriter(f, project.id, "Old: waiting for approval.");
    let inserted = false;
    f.intercept((path, args, call) => {
      if (path === "threads.defaultExecutionOptions" && args.threadId === "coordinator" && !inserted) {
        inserted = true;
        turn(f, "coordinator", "yes go ahead now", "Approved; transfer now.");
      }
      return call();
    });
    const result = await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    expect(inserted).toBe(true);
    expect(result).toMatchObject({ state: "writing-handover" });
    expect(coordinators(f)).toHaveLength(0);
    expect(writers(f).at(-1)!.prompt).toContain("yes go ahead now");
    await finishWriter(f, project.id, "Erwin approved; the transfer is on.");
    expect(coordinators(f).at(-1)!.prompt).toContain("Erwin approved; the transfer is on.");
    expect(coordinators(f).at(-1)!.prompt).not.toContain("waiting for approval");
  });

  it("a rewritten replacement draft is final: coordinator chatter alone cannot hold it back again", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    // A worker notice wakes the coordinator while Luna writes: written again, once.
    turn(f, "coordinator", "W3 finished part 2.", "Noted.", "system");
    await finishWriter(f, project.id, "First draft.");
    expect(writers(f)).toHaveLength(2);
    expect(f.store.handoverDraft(project.id)).toMatchObject({ purpose: "final" });
    turn(f, "coordinator", "W3 finished part 3.", "Noted again.", "system");
    await finishWriter(f, project.id, "Final draft.");
    expect(writers(f)).toHaveLength(2);
    expect(coordinators(f).at(-1)!.prompt).toContain("Final draft.");
  });
});

describe("W194 #5: the destination is where the replacement will run", () => {
  it("the primary member's default source checkout, not the incumbent's environment, next to the outgoing one", async () => {
    const { f, project } = await projectFixture();
    f.envs.set("env_old", { ...f.envs.get("env_a")!, id: "env_old", path: "/home/exedev/repo", hostId: "host_vm" });
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, environmentId: "env_old" });
    f.idle("coordinator");
    const read: string[] = [];
    f.harness.sdk.stub("environments.status", async ({ environmentId }: { environmentId: string }) => {
      read.push(environmentId);
      return { outcome: "available", workspace: { branch: { currentBranch: "main", defaultBranch: "main" }, checkout: { kind: "branch", branchName: "main", headSha: "abc123" }, mergeBase: { aheadCount: 0, behindCount: 542, baseRef: "origin/main", commits: [], deletions: 0, files: [], hasCommittedUnmergedChanges: false, insertions: 0, lineStatsComplete: true, mergeBaseBranch: "main" }, workingTree: { files: [], deletions: 0, insertions: 0, hasUncommittedChanges: false, lineStatsComplete: true, state: "clean" } } };
    });
    const snapshot = await captureHandoverSnapshot(f.service.sdk, f.store, project.id, { now: Date.now(), destination: destination(f, project.id) });
    expect(read).toEqual(["env_a"]);
    const p = handoverPacket(f.store, project.id, snapshot, null);
    expect(p).toContain("The outgoing coordinator ran in /home/exedev/repo on host host_vm. The new coordinator runs in a different checkout:\n/code/repo on host host_a (environment env_a).");
    expect(p).toContain("0 ahead, 542 behind");
  });

  it("an explicit reuse is the destination", async () => {
    const { f, project } = await projectFixture();
    expect(await (f.service as any).handoverDestination(project.id, { type: "reuse", environmentId: "env_reuse" })()).toBe("env_reuse");
  });
});

describe("W194 #6: credentials never reach the writer or the fallback", () => {
  it("redacts a console URL token, bearer tokens, keys and env-style secrets in both packets", async () => {
    const fx = loadCase("ai-config");
    const store = replayStore(fx);
    const snapshot = await captureHandoverSnapshot(replaySdk(fx), store, fx.projectId, { now: fx.replacementAt, destination: replayDestination(fx) });
    if (!snapshot.conversation.ok) throw new Error("conversation missing");
    const secrets = ["synthetic_console_secret_123456789", "Abc123Def456Ghi789Jkl012", "sk-ant-abcdefghijklmnop123456", "ghp_abcdefghijklmnopqrstuvwxyz0123", "s3cretValue12345678"];
    snapshot.conversation.value.messages.push({ id: "synthetic", seq: 999_999, at: fx.replacementAt, from: "user", sender: null,
      text: `Review app: https://example.test/console?token=${secrets[0]} · curl -H "Authorization: Bearer ${secrets[1]}" · key ${secrets[2]} · ${secrets[3]} · DB_PASSWORD=${secrets[4]}` });
    for (const packet of [handoverPacket(store, fx.projectId, snapshot, null), fallbackBody(store, fx.projectId, snapshot, null)]) {
      expect(packet).toContain("Review app: https://example.test/console?token=[redacted]");
      for (const secret of secrets) expect(packet).not.toContain(secret);
    }
  });
  it("leaves BB ids, commit hashes and ordinary prose alone", () => {
    const text = "W12 on thr_cecvm3dtbf merged 671ff0d (sha 5f92edc1da6d0b4dc02f87832eb9c462c68d4da0); the token budget is 300 words.";
    expect(redactCredentials(text)).toBe(text);
  });
});

describe("W194 #7: worker tails page past tool calls", () => {
  it("finds progress behind a full page of tool events, and says when a scan stopped early", async () => {
    const fx = loadCase("ai-config");
    const store = replayStore(fx);
    const w = store.workers(fx.projectId).find(w => w.threadId)!;
    const sdk = replaySdk(fx);
    const progress = "Built the review app: 277 items in three phases; the server runs and the link is gated behind the login.";
    const tool = (s: number) => ({ seq: s, type: "item/completed", data: { item: { type: "commandExecution", command: "ls" } } });
    const rows = [...Array.from({ length: 150 }, (_, i) => tool(10_000 - i)), { seq: 9_800, type: "item/completed", createdAt: fx.replacementAt, data: { item: { id: "p", type: "agentMessage", text: progress } } }];
    const original = sdk.threads.events.list.bind(sdk.threads.events);
    (sdk.threads.events as any).list = async (args: any) => args.threadId === w.threadId
      ? rows.filter(r => args.beforeSeq === undefined || r.seq < Number(args.beforeSeq)).sort((a, b) => b.seq - a.seq).slice(0, 100)
      : original(args);
    const snapshot = await captureHandoverSnapshot(sdk, store, fx.projectId, { now: fx.replacementAt, destination: replayDestination(fx) });
    expect(snapshot.workers[w.ref]!.tail).toEqual({ ok: true, value: { messages: [expect.objectContaining({ text: progress })], complete: true } });
    // Only tool calls for longer than the bound: "none" is never claimed.
    (sdk.threads.events as any).list = async (args: any) => args.threadId === w.threadId
      ? Array.from({ length: 100 }, (_, i) => tool(Number(args.beforeSeq ?? 100_000) - i - 1))
      : original(args);
    const busy = await captureHandoverSnapshot(sdk, store, fx.projectId, { now: fx.replacementAt, destination: replayDestination(fx) });
    expect(busy.workers[w.ref]!.tail).toEqual({ ok: true, value: { messages: [], complete: false } });
    expect(handoverPacket(store, fx.projectId, busy, null)).toContain("Its latest messages: none in its latest events scanned");
  });
});

// ---- W194 re-review ------------------------------------------------------------------------

/** The SDK calls a scenario makes before it spawns the replacement coordinator. */
async function callsBeforeSpawn(run: (f: Fx, project: { id: string }) => Promise<void>, setup: (f: Fx, project: { id: string }) => Promise<void>) {
  const { f, project } = await projectFixture();
  await setup(f, project);
  const calls: string[] = [];
  f.intercept((path, args, call) => {
    if (!(path === "threads.spawn" && (args as any).pluginMetadata?.role === "coordinator")) calls.push(path);
    else calls.push("SPAWN");
    return call();
  });
  await run(f, project);
  f.intercept();
  return calls.slice(0, calls.indexOf("SPAWN"));
}

describe("W194 re-review #1: nothing that arrives during the last await before the start slips through", () => {
  const setup = async (f: Fx, project: { id: string }) => {
    luna(f);
    f.idle("coordinator");
    await f.service.startHandoverDraft(project.id);
    await finishWriter(f, project.id, "Old: continue implementation.");
  };
  const run = async (f: Fx, project: { id: string }) => { await f.service.replaceCoordinator(project.id, { reason: "Fresh context" }); };

  it("direct path: a 'stop' from the user during the final read starts nothing; the replacement waits for the coordinator", async () => {
    const baseline = await callsBeforeSpawn(run, setup);
    expect(baseline.length).toBeGreaterThan(3);
    const { f, project } = await projectFixture();
    await setup(f, project);
    let n = 0;
    f.intercept((path, _args, call) => {
      if (++n === baseline.length) {
        // The very last read before the start would be recorded.
        f.history.push({ threadId: "coordinator", type: "client/turn/requested", seq: ++seq, createdAt: Date.now(), data: { requestId: `stop${seq}`, initiator: "user", input: [{ type: "text", text: "Stop. Do not replace." }] } });
        f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
      }
      return call();
    });
    await run(f, project);
    expect(coordinators(f)).toHaveLength(0);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
    // The handover is written again, with the stop in it; the busy coordinator is not replaced.
    expect(writers(f).at(-1)!.prompt).toContain("Stop. Do not replace.");
    await finishWriter(f, project.id, "Erwin said stop; keep the current coordinator.");
    expect(coordinators(f)).toHaveLength(0);
    expect(f.store.pendingHandover(project.id)).not.toBeNull();
  });

  it("queued path: a cancel during the final read starts nothing", async () => {
    const queuedSetup = async (f: Fx, project: { id: string }) => {
      luna(f);
      f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
      await f.service.replaceCoordinator(project.id, { reason: "Queued replacement" });
      turn(f, "coordinator", "Finish current work", "Current work finished.");
      f.idle("coordinator");
      await f.service.drainHandover(project.id);
      expect(f.store.handoverDraft(project.id)!.state).toBe("generating");
    };
    const queuedRun = async (f: Fx, project: { id: string }) => { await finishWriter(f, project.id, "Queued handover."); };
    const baseline = await callsBeforeSpawn(queuedRun, queuedSetup);
    const { f, project } = await projectFixture();
    await queuedSetup(f, project);
    let n = 0;
    f.intercept((_path, _args, call) => {
      if (++n === baseline.length) f.service.cancelHandover(project.id, "user");
      return call();
    });
    await queuedRun(f, project);
    expect(coordinators(f)).toHaveLength(0);
    expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
  });
});

describe("W194 re-review #2: unreadable input holds instead of counting as unchanged", () => {
  it("fingerprintHolds says unknown for an unavailable input read, and a proven 404 stays stable", async () => {
    const { fingerprintHolds } = await import("../lib/handover-snapshot");
    const fx = loadCase("ai-config"), store = replayStore(fx), destination = replayDestination(fx);
    const sdk = replaySdk(fx);
    const before = await readHandoverState(sdk, store, fx.projectId, { destination });
    const broken = replaySdk(fx);
    const original = broken.threads.events.list.bind(broken.threads.events);
    (broken.threads.events as any).list = (args: any) => args.types?.includes("client/turn/requested") ? Promise.reject(Object.assign(new Error("read unavailable"), { status: 503 })) : original(args);
    const now = await readHandoverState(broken, store, fx.projectId, { destination });
    expect(now.coordinator.user).toBe("unavailable");
    for (const purpose of ["preview", "replacement", "final"] as const) expect(fingerprintHolds(JSON.stringify(before), now, purpose)).toBe("unknown");
    const gone = { ...before, coordinator: { ...before.coordinator, user: "absent", activity: "absent" } };
    expect(fingerprintHolds(JSON.stringify(gone), gone, "final")).toBe("holds");
  });

  it("a replacement whose coordinator input can't be read is queued, not started", async () => {
    const { f, project } = await projectFixture();
    luna(f);
    f.idle("coordinator");
    await f.service.replaceCoordinator(project.id, { reason: "Fresh context" });
    await finishWriter(f, project.id, "Written.");
    // The writer finished, but reading the coordinator's input fails until BB answers again.
    expect(coordinators(f)).toHaveLength(1);
    const { f: g, project: q } = await projectFixture();
    luna(g);
    g.idle("coordinator");
    await g.service.startHandoverDraft(q.id);
    await finishWriter(g, q.id, "Preview.");
    g.intercept((path, args, call) => path === "threads.events.list" && (args as any).threadId === "coordinator" && (args as any).types?.includes("client/turn/requested")
      ? Promise.reject(Object.assign(new Error("read unavailable"), { status: 503 })) : call());
    await g.service.replaceCoordinator(q.id, { reason: "Fresh context" });
    expect(coordinators(g)).toHaveLength(0);
    expect(g.store.pendingHandover(q.id)).not.toBeNull();
    g.intercept();
    await g.service.drainHandover(q.id);
    expect(coordinators(g)).toHaveLength(1);
  });
});

describe("W194 re-review #3–5: redaction by specific shapes, before budgeting", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  it("catches JSON keys, positional secret commands and the earlier escapes", () => {
    for (const text of [`{"token":"${secret}"}`, `{"apiKey": "${secret}"}`, `bb secret set app-login ${secret}`, `gh secret set DEPLOY_KEY --body ${secret}`, `CLIENT_SECRET=${secret}`])
      expect(redactCredentials(text), text).not.toContain(secret);
  });
  it("leaves commit SHAs, thread ids, op markers, paths and variable names alone", () => {
    for (const text of [
      "The token fix landed in `5f92edc1da6d0b4dc02f87832eb9c462c68d4da0`.",
      "The credential issue is in `thr_cecvm3dtbf`.",
      "The token operation is `[initiatives:op_73485d2cfd96]`.",
      "Read credentials from `/home/erwin/.config/coffre/env`.",
      "Remove token `DOPPLER_TOKEN`.",
      "\"inputTokens\": 12345678 and max_tokens=4096 tokens used.",
      "export TMPDIR=$(mktemp -d)",
    ]) expect(redactCredentials(text), text).toBe(text);
  });
  it("never lists a secret-setting command as an action, and stays within both limits", async () => {
    const { PACKET_MAX, FALLBACK_MAX } = await import("../lib/handover-packet");
    const fx = loadCase("ai-config"), store = replayStore(fx);
    const snap = await captureHandoverSnapshot(replaySdk(fx), store, fx.projectId, { now: fx.replacementAt, destination: replayDestination(fx) });
    if (!snap.conversation.ok) throw new Error("conversation missing");
    snap.conversation.value.actions = [{ seq: 999_999, at: fx.replacementAt, command: `bb secret set app-login ${secret}`, exitCode: 0 }];
    snap.conversation.value.messages = Array.from({ length: 40 }, (_, i) => ({ id: `synthetic-${i}`, seq: i, at: fx.replacementAt, from: "user" as const, sender: null, text: `token=${secret} `.repeat(120) }));
    const packet = handoverPacket(store, fx.projectId, snap, null), fallback = fallbackBody(store, fx.projectId, snap, null);
    for (const p of [packet, fallback]) expect(p).not.toContain(secret);
    expect(packet.length).toBeLessThanOrEqual(PACKET_MAX);
    expect(fallback.length).toBeLessThanOrEqual(FALLBACK_MAX);
    const { toAction } = await import("../lib/handover-snapshot");
    expect(toAction({ seq: 1, type: "item/completed", data: { item: { type: "commandExecution", command: `bb secret set app-login ${secret}`, exitCode: 0 } } })).toBeNull();
    expect(toAction({ seq: 1, type: "item/completed", data: { item: { type: "commandExecution", command: "export API=x && gh pr merge 3", exitCode: 0 } } })).toBeNull();
  });
});

describe("W194 re-review #6: exit 0 is not proof", () => {
  it("labels a piped command as ran, not succeeded, and the prompt says commands are evidence, not proof", async () => {
    const { handoverPrompt } = await import("../lib/handover-packet");
    const fx = loadCase("ai-config"), store = replayStore(fx);
    const snap = await captureHandoverSnapshot(replaySdk(fx), store, fx.projectId, { now: fx.replacementAt, destination: replayDestination(fx) });
    if (!snap.conversation.ok) throw new Error("conversation missing");
    snap.conversation.value.actions = [{ seq: 999_999, at: fx.replacementAt, command: "bb automation update auto_example --enabled true 2>&1 | head -20", exitCode: 0 }];
    const p = handoverPacket(store, fx.projectId, snap, null);
    expect(p).toContain("bb automation update auto_example --enabled true 2>&1 | head -20 (ran, exit 0, not verified)");
    expect(p).not.toContain("(succeeded)");
    const prompt = handoverPrompt("AI config", p);
    expect(prompt).toContain("a command is not proof that something succeeded");
    expect(prompt).not.toMatch(/means that step is done/);
  });
});

describe("W194 re-review: a token named in prose", () => {
  it("redacts Solera's console-token shape a few words after a credential word", () => {
    for (const [text, secret] of [
      ["Sign in to getbb.app first, then use the console token `F000AK0fake-0EfaF0kAKEefaFke0fa0`.", "F000AK0fake-0EfaF0kAKEefaFke0fa0"],
      ["- **New token:** `_faFkefaA0kefKakefaEFAKkEFefAK0a`. The old token no longer works.", "_faFkefaA0kefKakefaEFAKkEFefAK0a"],
      ['The API key for staging is "AbCdEf1234567890xyz".', "AbCdEf1234567890xyz"],
      ["Its secret, as set yesterday: 'Qw3rtyUiop9AsdfGhjk'", "Qw3rtyUiop9AsdfGhjk"],
    ]) {
      expect(redactCredentials(text), text).not.toContain(secret);
      expect(redactCredentials(text)).toContain("[redacted]");
    }
  });
  it("still leaves W194's false positives, and names and far-away words, alone", () => {
    for (const text of [
      "The token fix landed in `5f92edc1da6d0b4dc02f87832eb9c462c68d4da0`.",
      "The credential issue is in `thr_cecvm3dtbf`.",
      "The token operation is `[initiatives:op_73485d2cfd96]`.",
      "Read credentials from `/home/erwin/.config/coffre/env`.",
      "Remove token `DOPPLER_TOKEN`.",
      "The key change moved the base image to `Ubuntu-resolute-latest-amd64-base`.",
      "We rotated the token yesterday and then, much later in this long sentence, merged `Fix2ParserEdgeCaseNow`.",
    ]) expect(redactCredentials(text), text).toBe(text);
  });
});

describe("W194 round 3 #1: a successful cancel at any await before the start means nothing spawns", () => {
  const queuedSetup = async (f: Fx, project: { id: string }) => {
    luna(f);
    f.threads.set("coordinator", { ...f.threads.get("coordinator")!, status: "active" });
    await f.service.replaceCoordinator(project.id, { reason: "Queued replacement" });
    turn(f, "coordinator", "Finish current work", "Current work finished.");
    f.idle("coordinator");
    await f.service.drainHandover(project.id);
  };
  const queuedRun = async (f: Fx, project: { id: string }) => { await finishWriter(f, project.id, "Queued handover."); };

  it("enumerates every SDK call before the spawn and cancels there: now, a tick later, and several ticks later", async () => {
    const baseline = await callsBeforeSpawn(queuedRun, queuedSetup);
    expect(baseline.length).toBeGreaterThan(5);
    const ticks = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    let cancels = 0;
    for (let k = 1; k <= baseline.length; k++)
      for (const delay of [0, 1, 6]) {
        const { f, project } = await projectFixture();
        await queuedSetup(f, project);
        let outcome: string | null = null;
        let n = 0;
        f.intercept((_path, _args, call) => {
          if (++n === k) {
            const cancel = () => { try { outcome = f.service.cancelHandover(project.id, "user").state; } catch { outcome = "none"; } };
            if (delay === 0) cancel();
            else void ticks(delay).then(cancel);
          }
          return call();
        });
        await queuedRun(f, project);
        await ticks(10);
        if (outcome === "cancelled") {
          cancels++;
          expect(coordinators(f), `cancel at call ${k} (${baseline[k - 1]}), ${delay} ticks later`).toHaveLength(0);
          expect(f.store.project(project.id)!.coordinatorThreadId).toBe("coordinator");
        }
      }
    // Most points do cancel successfully; the test is not vacuous.
    expect(cancels).toBeGreaterThan(baseline.length);
  }, 60_000);
});

describe("W194 round 3 #2–3: every value of a secret-named key, whole secret commands, in linear time", () => {
  it("redacts numeric and punctuation-led values of secret-named keys", () => {
    for (const [text, secret] of [
      ['{"password": 12345678}', "12345678"],
      ["DB_PASSWORD=12345678", "12345678"],
      ["ADMIN_PASSWORD=!sup3r$ecret", "!sup3r$ecret"],
      ['{"client_secret": "#hash-led value"}', "#hash-led value"],
      ["auth_token: 42424242", "42424242"],
    ]) expect(redactCredentials(text), text).not.toContain(secret);
  });
  it("drops a multi-line secret command with its continuation lines, and keeps the next line", () => {
    const text = "Then I ran:\nbb secret set app-login \\\n  0123456789abcdef0123 \\\n  --project solera\nThe app restarted.";
    expect(redactCredentials(text)).toBe("Then I ran:\n[a command setting a secret, not shown]\nThe app restarted.");
  });
  it("redacts a 200,000-character line in under 50 ms, whatever it holds", () => {
    for (const [name, line] of [
      ["ordinary words", "ordinary words on a very long line ".repeat(6000)],
      ["one long word", "a".repeat(200_000)],
      ["secret-named keys", "token=x ".repeat(25_000)],
      ["credential words and quotes", "token `".repeat(28_000)],
      ["command-like words", "bb secrets ".repeat(18_000)],
      ["urls", "https://a:b".repeat(18_000)],
    ] as const) {
      const started = performance.now();
      redactCredentials(line);
      expect(performance.now() - started, name).toBeLessThan(50);
    }
  });
});

describe("W194 round 4: multi-line values and file references", () => {
  it("redacts a secret-named key whose value is on the next non-empty line (JSON, YAML, block marker)", () => {
    expect(redactCredentials('{\n  "password":\n    "hunter2-long-secret",\n  "user": "erwin"\n}')).toBe('{\n  "password":\n    [redacted],\n  "user": "erwin"\n}');
    expect(redactCredentials("db:\n  password:\n\n    s3cr3t-value\n  host: x")).toBe("db:\n  password:\n\n    [redacted]\n  host: x");
    expect(redactCredentials("api_key: |\n  multi-line-secret-value\nnext: kept")).toBe("api_key: |\n  [redacted]\nnext: kept");
  });
  it("drops a secret command's heredoc through its terminator, or to the end without one", () => {
    expect(redactCredentials("Ran:\ngh secret set DEPLOY_KEY <<'EOF'\nline1-secret\nline2-secret\nEOF\nThe deploy passed.")).toBe("Ran:\n[a command setting a secret, not shown]\nThe deploy passed.");
    expect(redactCredentials("bb secret set X \\\n  <<-END\n\tsecretA\n\tEND\nkept")).toBe("[a command setting a secret, not shown]\nkept");
    expect(redactCredentials("gh secret set Y <<EOF\nnever closed\nstill secret")).toBe("[a command setting a secret, not shown]");
    // Bounded: a terminator further than 200 lines away is not looked for; the rest goes.
    const far = `gh secret set Z <<EOF\n${"x\n".repeat(250)}EOF\nafter`;
    expect(redactCredentials(far)).toBe("[a command setting a secret, not shown]");
  });
  it("leaves file references to secret-named modules intact", () => {
    for (const text of [
      "Read /repo/lib/secret.ts:123 for the parser.",
      "See [token.ts](/repo/lib/token.ts:42).",
      "Password handling lives in lib/password.ts:55.",
      "password.ts:55 and [x](token.ts:42) and C:\\\\repo\\\\secret.ts:7",
    ]) expect(redactCredentials(text), text).toBe(text);
    // A dotted config key is still a key.
    expect(redactCredentials("db.password=abcdef12")).toBe("db.password=[redacted]");
  });
  it("stays linear with the new state", () => {
    const started = performance.now();
    redactCredentials("password:\n".repeat(20_000) + "gh secret set A <<EOF\n".repeat(2_000));
    expect(performance.now() - started).toBeLessThan(100);
  });
});
