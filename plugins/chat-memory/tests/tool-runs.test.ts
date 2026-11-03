import { describe, expect, it } from "vitest";
import { fixture } from "./fixture";
import { GROUP_BYTES, GROUP_USES, USES, eventEntries, splitEntry, stableEntries, turnEntries, type EventRow, type IngestState } from "../lib/log";

/** W571: a run of tool uses is logged as groups of uses, each call then → and its result; a group zooms to all of them in full. */
const facts = { spawnedByPlugin: false, sender: (id: string) => id };
const item = (it: Record<string, unknown>, seq: number): EventRow => ({ seq, type: "item/completed", createdAt: 1_000, data: { item: it } });
const bash = (command: string, seq: number, output = `out ${command}`) => item({ type: "commandExecution", command, exitCode: 0, aggregatedOutput: output }, seq);
const use = (command: string, output = `out ${command}`) => `Bash ${command}\n→ exit 0\n${output}`;
const done = (seq: number, status = "completed"): EventRow => ({ seq, type: "turn/completed", data: { status } });
const image = (data: string) => ({ content: [{ type: "text", text: "shot" }, { type: "image", data, mimeType: "image/png" }] });

/** A thread "w" attached to a fresh scope, with `rows` as its events. */
async function thread(rows: EventRow[] = []) {
  const f = fixture();
  const s = await f.attach("initiatives", "p", f.thread("w"));
  const push = (...more: EventRow[]) => more.forEach((row) => f.history.push({ threadId: "w", ...row }));
  push(...rows);
  return { f, s, push };
}
const request = (seq: number, id: string, text: string): EventRow[] => [
  { seq, type: "client/turn/requested", data: { requestId: id, input: [{ type: "text", text }] } },
  { seq: seq + 1, type: "turn/input/accepted", data: { clientRequestId: id } },
];

/** Zoom pages of message id, joined: the header of the first page, and the whole text. */
async function zoom(f: ReturnType<typeof fixture>, s: string, id: number) {
  let offset = 0;
  let text = "";
  let first = "";
  for (let pages = 1; ; pages++) {
    const result = await f.memory.evidence(s, id, 1, offset);
    if (typeof result === "string") throw Error("expected content");
    const part = result.content[0]!;
    if (part.type !== "text") throw Error("expected text");
    const [header, ...body] = part.text.split("\n");
    first ||= header!;
    text += body.join("\n").replace(/\nAttachments \(retrieve with attachment index\):\n[\s\S]*$/, "");
    const next = /next offset (\d+)/.exec(header!);
    if (!next) return { header: first, text, pages };
    offset = Number(next[1]);
  }
}

describe("W571 groups", () => {
  it(`logs a 20-command turn as 5 messages: groups of ${GROUP_USES} uses, in order`, async () => {
    const { f, s, push } = await thread(request(1000, "r", "check the repo"));
    for (let k = 0; k < 20; k++) push(bash(`git log -${k}`, 1002 + k));
    push(item({ type: "agentMessage", text: "Done." }, 1022), done(1023));
    await f.memory.ingest("w");
    const uses = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => use(`git log -${from + k}`)).join(USES);
    expect(f.log(s)).toEqual(["user: check the repo", `tool: ${uses(0, 8)}`, `tool: ${uses(8, 16)}`, `tool: ${uses(16, 20)}`, "agent: Done."]);
    expect(f.store.messages(s).map((m) => [m.seq, m.endSeq ?? null])).toEqual([[1000, null], [1002, 1009], [1010, 1017], [1018, 1021], [1022, null]]);
  });

  it(`closes a group before it passes ${GROUP_BYTES} bytes; a larger use is a group alone, split past 30,000 characters`, () => {
    const big = "b".repeat(6_000);
    const rows = [bash("a", 1, big), bash("b", 2, big), bash("c", 3, big), bash("huge", 4, "h".repeat(40_000)), bash("d", 5), done(6)];
    const logged = stableEntries(rows, { pending: [], modern: true }, "w", facts).entries;
    expect(logged.map((e) => [e.seq, e.endSeq, e.text.length])).toEqual([
      [1, 2, use("a", big).length * 2 + USES.length],
      [3, 3, use("c", big).length],
      // The huge result is clipped to 30,000 characters with its marker, then split.
      [4, 4, 30_000],
      [4, 4, expect.any(Number)],
      [5, 5, use("d").length],
    ]);
  });

  it("groups by run, not by batch: reasoning and subagent items stay inside, any other entry closes it", () => {
    const rows = [
      bash("a", 1),
      item({ type: "reasoning", text: "thinking" }, 2),
      item({ type: "commandExecution", command: "nested", parentToolCallId: "t", aggregatedOutput: "x" }, 3),
      bash("b", 4),
      item({ type: "agentMessage", text: "Halfway." }, 5),
      bash("c", 6),
      ...request(7, "q", "and the tests?"),
      bash("d", 9),
      done(10, "failed"),
      bash("e", 11),
      done(12, "interrupted"),
    ];
    const logged = stableEntries(rows, { pending: [], modern: true }, "w", facts).entries.map((e) => `${e.kind}: ${e.text}`);
    expect(logged).toEqual([
      `tool: ${use("a")}${USES}${use("b")}`,
      "agent: Halfway.",
      `tool: ${use("c")}`,
      "user: and the tests?",
      `tool: ${use("d")}`,
      `tool: ${use("e")}`,
      "work: [bb] (stopped) This turn was stopped before it finished.",
    ]);
  });

  it("parks the cursor before an open group and reads the run again once it closes, so no logged row ever grows", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go"]);
    // The read stopped mid-run: the cursor waits just before its first use, and nothing else is kept.
    expect(f.store.thread("w")?.cursor).toBe(1001);
    // Read again with no new event: the run is still open, so nothing moves.
    await f.memory.ingest("w");
    expect(f.store.thread("w")?.cursor).toBe(1001);
    push(bash("c", 1004), done(1005));
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go", `tool: ${[use("a"), use("b"), use("c")].join(USES)}`]);
    expect(f.store.messages(s)[1]).toMatchObject({ seq: 1002, endSeq: 1004 });
    expect(f.store.thread("w")?.cursor).toBe(1005);
  });

  it("re-reads a parked range purely: a request queued mid-run is pending once, and logged once at its acceptance", async () => {
    const queued: EventRow = { seq: 1003, type: "client/turn/requested", data: { requestId: "q", input: [{ type: "text", text: "and then?" }] } };
    const rows = [...request(1000, "r", "go"), bash("a", 1002), queued, bash("b", 1004)];
    const from: IngestState = { pending: [], modern: true };
    const read = stableEntries(rows, from, "w", facts);
    // The request is kept as read, and marked so: a second read of the range skips it.
    expect(read).toMatchObject({ parked: 1001, state: { pending: [{ seq: 1003 }], through: 1004 } });
    expect(from).toEqual({ pending: [], modern: true });
    expect(stableEntries([bash("a", 1002), queued, bash("b", 1004), done(1005)], read.state, "w", facts).state.pending.map((r) => r.seq)).toEqual([1003]);
    const { f, s, push } = await thread(rows);
    await f.memory.ingest("w");
    await f.memory.ingest("w");
    push(done(1005));
    await f.memory.ingest("w");
    expect(f.store.ingestion("w", s).pending.map((r) => r.data?.requestId)).toEqual(["q"]);
    push({ seq: 1006, type: "turn/input/accepted", data: { clientRequestId: "q" } }, bash("c", 1007), done(1008));
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`, "user: and then?", `tool: ${use("c")}`]);
  });

  it("logs a group as soon as it reaches a cap, with no entry after it (review r4 P2)", () => {
    const eight = Array.from({ length: GROUP_USES }, (_, k) => bash(`u${k}`, 1 + k));
    const capped = stableEntries(eight, { pending: [], modern: true }, "w", facts);
    expect(capped.entries.map((e) => [e.seq, e.endSeq])).toEqual([[1, GROUP_USES]]);
    expect(capped.parked).toBeNull();
    const huge = stableEntries([bash("huge", 1, "h".repeat(GROUP_BYTES))], { pending: [], modern: true }, "w", facts);
    expect(huge.entries.map((e) => e.seq)).toEqual([1]);
    expect(huge.parked).toBeNull();
  });

  it("closes a run at a read's end when the whole read is that run, so a long history always moves on", async () => {
    // Two uses 2,000 reasoning events apart: the read from the first use is all one open run.
    const rows = [...request(1000, "r", "go"), bash("a", 1002)];
    for (let k = 0; k < 2_000; k++) rows.push(item({ type: "reasoning", text: "…" }, 1003 + k));
    const { f, s } = await thread([...rows, bash("b", 3003), done(3004)]);
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.store.thread("w")?.cursor).toBe(1001);
    for (let k = 0; k < 3; k++) await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}`, `tool: ${use("b")}`]);
    expect(f.store.thread("w")?.cursor).toBe(3004);
  });

  it("logs the open group of a thread archived mid-turn as its final copy", async () => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go"]);
    // The archive's copy reads the parked run again, and logs it.
    f.memory.threadArchived("w", true);
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`]);
    expect(f.store.thread("w")?.cursor).toBe(1003);
  });

  it("logs a parked group at startup when the thread was archived while the plugin was down (review r1 P2)", async () => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    await f.reload();
    // Archived with no event after it, and no archive event seen: the startup walk finds it behind.
    f.threads.get("w")!.archived = true;
    await f.memory.sweep(false);
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`]);
  });

  it("logs a run to the thread's new scope when it moves mid-run (review r1 P1)", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    const moved = await f.attach("initiatives", "q", "w");
    push(bash("c", 1004), done(1005));
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.log(moved)).toEqual([`tool: ${[use("a"), use("b"), use("c")].join(USES)}`]);
    expect(f.store.messages(moved)[0]).toMatchObject({ seq: 1002, endSeq: 1004 });
  });

  it.each([
    ["moved", "archived", "archive"],
    ["moved", "archived while the plugin was down", "restart"],
    ["detached, then attached to another scope,", "archived", "archive"],
    ["detached, then attached to another scope,", "archived while the plugin was down", "restart"],
  ])("logs a parked run of a thread %s mid-run, then %s, to its new scope (review W571 r1 P1)", async (how, _when, end) => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    expect(f.store.thread("w")?.cursor).toBe(1001);
    if (how !== "moved") f.memory.attach("w", null);
    const moved = await f.attach("initiatives", "q", "w");
    // The thread's provider still sends acceptances: the run is read again, not buffered past.
    await f.memory.ingest("w");
    expect(f.store.thread("w")?.cursor).toBe(1001);
    if (end === "archive") await f.archived("w");
    else {
      f.threads.get("w")!.archived = true;
      await f.reload();
      await f.memory.sweep(false);
    }
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.log(moved)).toEqual([`tool: ${use("a")}${USES}${use("b")}`]);
  });

  it.each(["moved", "detached, then attached elsewhere,"])("keeps a request queued mid-run out of the new scope of a thread %s before its acceptance (review W571 r2 P1)", async (how) => {
    const queued: EventRow = { seq: 1003, type: "client/turn/requested", data: { requestId: "q", input: [{ type: "text", text: "and then?" }] } };
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002), queued, bash("b", 1004)]);
    await f.memory.ingest("w");
    expect(f.store.thread("w")?.cursor).toBe(1001);
    if (how !== "moved") f.memory.attach("w", null);
    const moved = await f.attach("initiatives", "q", "w");
    push(done(1005), { seq: 1006, type: "turn/input/accepted", data: { clientRequestId: "q" } }, bash("c", 1007), done(1008));
    await f.memory.ingest("w");
    await f.memory.settled();
    // As when the read had not parked: q was read in the old scope, so its acceptance logs it nowhere.
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.log(moved)).toEqual([`tool: ${use("a")}${USES}${use("b")}`, `tool: ${use("c")}`]);
  });

  it.each(["moved", "detached, then attached elsewhere,"])("keeps a request queued after the cursor parked, by a read that consumed nothing, out of the new scope of a thread %s (review W571 r3 P1)", async (how) => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002)]);
    await f.memory.ingest("w");
    expect(f.store.thread("w")?.cursor).toBe(1001);
    push({ seq: 1003, type: "client/turn/requested", data: { requestId: "q", input: [{ type: "text", text: "and then?" }] } }, bash("b", 1004));
    await f.memory.ingest("w");
    // The run is still open: the cursor stays, but q and the read's end are saved.
    expect(f.store.thread("w")?.cursor).toBe(1001);
    expect(f.store.ingestion("w", s)).toMatchObject({ pending: [{ seq: 1003 }], through: 1004 });
    if (how !== "moved") f.memory.attach("w", null);
    const moved = await f.attach("initiatives", "q", "w");
    push(done(1005), { seq: 1006, type: "turn/input/accepted", data: { clientRequestId: "q" } }, bash("c", 1007), done(1008));
    await f.memory.ingest("w");
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.log(moved)).toEqual([`tool: ${use("a")}${USES}${use("b")}`, `tool: ${use("c")}`]);
  });

  it("saves a parked read's state only over the state it began from", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002)]);
    await f.memory.ingest("w");
    push({ seq: 1003, type: "client/turn/requested", data: { requestId: "q", input: [{ type: "text", text: "and then?" }] } }, bash("b", 1004));
    // Hold the read between loading its state and saving it (its facts lookup).
    const memory = f.memory as unknown as { logFacts: (...args: never[]) => Promise<unknown> };
    const facts = memory.logFacts.bind(f.memory);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let loaded!: () => void;
    const started = new Promise<void>((resolve) => (loaded = resolve));
    memory.logFacts = async (...args) => { loaded(); await held; return facts(...args); };
    const stale = f.memory.ingest("w");
    await started;
    // Another read saved a newer state meanwhile: the stale one must not write its older one over it.
    const newer = { ...f.store.ingestion("w", s), through: 1010 };
    f.store.saveIngestion("w", s, newer);
    release();
    await stale;
    expect(f.store.ingestion("w", s)).toEqual(newer);
    expect(f.store.thread("w")?.cursor).toBe(1001);
  });

  it("saves nothing from a read a newer one overtook between its event fetch and its commit (review W571 r4 P1)", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002)]);
    await f.memory.ingest("w");
    // The older read fetches its events (through 1002), then waits.
    const deps = (f.memory as unknown as { deps: { list: (args: never) => Promise<unknown> } }).deps;
    const list = deps.list;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let fetched!: () => void;
    const answered = new Promise<void>((resolve) => (fetched = resolve));
    deps.list = async (args) => { const rows = await list(args); deps.list = list; fetched(); await held; return rows; };
    const stale = f.memory.ingest("w");
    await answered;
    // A newer read consumes a queued request and another use; the run stays open, the cursor parked.
    const queued: EventRow = { seq: 1003, type: "client/turn/requested", data: { requestId: "q", input: [{ type: "text", text: "and then?" }] } };
    push(queued, bash("b", 1004));
    await f.memory.ingest("w");
    const newer = f.store.ingestion("w", s);
    expect(newer).toMatchObject({ pending: [{ seq: 1003 }], through: 1004 });
    release();
    await stale;
    expect(f.store.ingestion("w", s)).toEqual(newer);
    // So the request read in the old scope stays out of the new one.
    const moved = await f.attach("initiatives", "q", "w");
    push(done(1005), { seq: 1006, type: "turn/input/accepted", data: { clientRequestId: "q" } }, bash("c", 1007), done(1008));
    await f.memory.ingest("w");
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.log(moved)).toEqual([`tool: ${use("a")}${USES}${use("b")}`, `tool: ${use("c")}`]);
  });

  it("logs the parked group of a thread detached, archived, then attached again (review W571 r4 P2)", async () => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    f.memory.attach("w", null);
    await f.archived("w");
    f.memory.attach("w", s);
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`]);
    // The recurring sweep skips archived threads: nothing was left for it.
    await f.memory.sweep(true);
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`]);
  });

  it("starts a moved thread's ingestion afresh but for its provider's acceptances: requests read in the old scope stay out", async () => {
    const { f, s, push } = await thread([{ seq: 1000, type: "client/turn/requested", data: { requestId: "q", input: [{ type: "text", text: "old" }] } }]);
    await f.memory.ingest("w");
    expect(f.store.ingestion("w", s)).toMatchObject({ pending: [{ seq: 1000 }] });
    const moved = await f.attach("initiatives", "q", "w");
    expect(f.store.ingestion("w", moved)).toEqual({ pending: [], modern: false });
    push(...request(1001, "r", "go"));
    await f.memory.ingest("w");
    expect(f.store.ingestion("w", moved)).toMatchObject({ pending: [], modern: true });
    const back = await f.attach("initiatives", "p2", "w");
    expect(f.store.ingestion("w", back)).toEqual({ pending: [], modern: true });
  });

  /** Holds every event read of thread w until `release`; `started` resolves at the first. */
  function gate(f: ReturnType<typeof fixture>) {
    const deps = (f.memory as unknown as { deps: { list: (args: never) => Promise<unknown> } }).deps;
    const list = deps.list;
    let open!: () => void;
    const released = new Promise<void>((resolve) => (open = resolve));
    let reading!: () => void;
    const started = new Promise<void>((resolve) => (reading = resolve));
    deps.list = async (args) => {
      reading();
      await released;
      return list(args);
    };
    return { started, release: () => { open(); deps.list = list; } };
  }

  it.each(["ingest", "sweep"])("forgets a thread BB deleted mid-run, found by %s: its unlogged run is lost, nothing else (review r2 P1)", async (path) => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    await f.reload();
    f.threads.delete("w");
    if (path === "ingest") await f.memory.ingest("w");
    else await f.memory.sweep(false);
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.store.thread("w")).toBeFalsy();
  });

  it.each(["ingest", "sweep"])("forgets a thread detached during a read, then found deleted by %s (review r3 P1)", async (path) => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    const { started, release } = gate(f);
    const run = path === "ingest" ? f.memory.ingest("w") : f.memory.sweep(false);
    await started;
    f.memory.attach("w", null);
    f.threads.delete("w");
    release();
    await run;
    await f.memory.settled();
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.store.thread("w")).toBeFalsy();
  });

  it("logs a run once when its thread is detached and attached again to the same scope during a read (review r4 P1)", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    push(done(1004));
    const { started, release } = gate(f);
    // A read starts from the parked cursor; meanwhile the thread goes and comes back, and a second read starts.
    const stale = f.memory.ingest("w");
    await started;
    f.memory.attach("w", null);
    f.memory.attach("w", s);
    const fresh = f.memory.ingest("w");
    release();
    await Promise.all([stale, fresh]);
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`]);
    expect(f.store.thread("w")?.cursor).toBe(1004);
  });

  it("logs a run read while detached nowhere, and to the scope it is attached to when it closes", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002)]);
    await f.memory.ingest("w");
    f.memory.attach("w", null);
    push(bash("b", 1003), done(1004));
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go"]);
    const moved = await f.attach("initiatives", "q", "w");
    await f.memory.ingest("w");
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.log(moved)).toEqual([`tool: ${use("a")}${USES}${use("b")}`]);
  });

  it("answers an OptChat turn with the previous turn's run logged: its turn/completed closes the parked group", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    await f.memory.ingest("w");
    push(done(1004), { seq: 1005, type: "client/turn/requested", data: { requestId: "r2", input: [{ type: "text", text: "next" }] } });
    expect(await f.ask("w", "r2", "next")).toMatchObject({ session: "fresh" });
    expect(f.log(s)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`]);
  });

  it("never holds an OptChat turn on a group still open: it waits only for what is logged", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003)]);
    push({ seq: 1004, type: "client/turn/requested", data: { requestId: "r2", input: [{ type: "text", text: "next" }] } });
    expect(await f.ask("w", "r2", "next")).toMatchObject({ session: "fresh" });
    expect(f.log(s)).toEqual(["user: go"]);
    expect(f.store.thread("w")?.cursor).toBe(1001);
  });

  it("closes a group at every turn end in turnEntries, as stableEntries does, retries included (review r1 P2)", () => {
    const retry = { seq: 5, type: "client/turn/requested", data: { requestId: "r2", retryOfRequestId: "r", input: [{ type: "text", text: "go" }] } };
    const rows: EventRow[] = [bash("a", 1), done(2, "failed"), bash("b", 3), done(4), retry, bash("c", 6), bash("d", 7), done(8)];
    const grouped = (entries: { seq?: number | null; endSeq?: number | null }[]) => entries.map((e) => [e.seq, e.endSeq ?? null]);
    expect(grouped(turnEntries(rows, "w", facts))).toEqual([[1, 1], [3, 3], [6, 7]]);
    expect(grouped(stableEntries(rows, { pending: [], modern: true }, "w", facts).entries)).toEqual([[1, 1], [3, 3], [6, 7]]);
  });

  it("groups a historical provider's turn too, read whole at its end", () => {
    const rows = [{ seq: 1, type: "client/turn/requested", data: { requestId: "r", input: [{ type: "text", text: "go" }] } }, bash("a", 2), bash("b", 3), done(4)];
    const first = stableEntries(rows.slice(0, 3), { pending: [], modern: false }, "w", facts);
    expect(first).toMatchObject({ entries: [], parked: null });
    expect(stableEntries(rows.slice(3), first.state, "w", facts).entries.map((e) => `${e.kind}: ${e.text}`)).toEqual(["user: go", `tool: ${use("a")}${USES}${use("b")}`]);
    expect(turnEntries(rows, "w", facts).map((e) => [e.kind, e.seq, e.endSeq])).toEqual([["user", 1, undefined], ["tool", 2, 3]]);
  });
});

describe("W571 zoom", () => {
  it("returns every call and result of a group in full, paged, with all its images and its truncation note", async () => {
    const long = "é".repeat(20_000) + "MIDDLE-EVIDENCE" + "€".repeat(20_000);
    const { f, s } = await thread([
      ...request(1000, "r", "go"),
      item({ type: "toolCall", tool: "read", arguments: { path: "p" }, result: long }, 1002),
      item({ type: "reasoning", text: "hm" }, 1003),
      item({ type: "toolCall", tool: "screenshot", arguments: { url: "a" }, result: image("ONE") }, 1004),
      item({ type: "commandExecution", command: "cat log", exitCode: 0, aggregatedOutput: "head [...] tail", truncation: { removed: 100 } }, 1005),
      item({ type: "toolCall", tool: "screenshot", arguments: { url: "b" }, result: JSON.stringify(image("TWO")) }, 1006),
      done(1007),
    ]);
    await f.memory.ingest("w");
    // The read passes the byte cap: a group alone, clipped, then split in two parts.
    expect(f.store.messages(s).map((m) => [m.kind, m.seq, m.endSeq])).toEqual([["user", 1000, null], ["tool", 1002, 1002], ["tool", 1002, 1002], ["tool", 1004, 1006]]);
    expect(f.log(s).join("")).not.toContain("MIDDLE-EVIDENCE");

    const read = await zoom(f, s, 1);
    expect(read.text).toBe(`read {"path":"p"}\n→ ${long}`);
    expect(read.pages).toBeGreaterThan(1);

    const group = await zoom(f, s, 3);
    expect(group.header).toContain("source w:1004..1006; canonical retained output; source retention may have removed the middle");
    expect(group.text).toMatch(/^screenshot {"url":"a"}\n→ .*\n\nBash cat log\n→ exit 0\nhead \[\.\.\.\] tail\n\nscreenshot {"url":"b"}\n→ /s);
    expect(await f.memory.zoomText(s, 3, 1)).toContain("Attachments (retrieve with attachment index):\n0: image/png\n1: image/png");
    expect(await f.memory.evidence(s, 3, 1, 0, 0)).toMatchObject({ content: [{ type: "text" }, { type: "image", data: "ONE" }] });
    expect(await f.memory.evidence(s, 3, 1, 0, 1)).toMatchObject({ content: [{ type: "text" }, { type: "image", data: "TWO" }] });
  });

  it("splits only a use past the byte cap, alone in its group; each part zooms to it whole", async () => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("cat", 1003, "z".repeat(35_000) + "END"), bash("b", 1004), done(1005)]);
    await f.memory.ingest("w");
    expect(f.store.messages(s).map((m) => [m.seq, m.endSeq])).toEqual([[1000, null], [1002, 1002], [1003, 1003], [1003, 1003], [1004, 1004]]);
    for (const id of [2, 3]) expect((await zoom(f, s, id)).text).toBe(use("cat", "z".repeat(35_000) + "END"));
  });

  it("reads a group's uses past 100 nested events", async () => {
    const { f, s, push } = await thread(request(1000, "r", "go"));
    push(bash("a", 1002));
    for (let k = 0; k < 250; k++) push(item({ type: "commandExecution", command: "sub", parentToolCallId: "t", aggregatedOutput: "x" }, 1003 + k));
    push(bash("b", 1300), done(1301));
    await f.memory.ingest("w");
    expect(f.store.messages(s).map((m) => [m.seq, m.endSeq])).toEqual([[1000, null], [1002, 1300]]);
    const z = await zoom(f, s, 1);
    expect(z.header).toContain("source w:1002..1300; canonical semantic message; kind tool");
    expect(z.text).toBe(`${use("a")}${USES}${use("b")}`);
  });

  it("reads no event past a group: a huge one after it cannot fail the zoom (review r1 P2)", async () => {
    const { f, s, push } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003), item({ type: "agentMessage", text: "next" }, 1004)]);
    push(bash("huge", 1005, "h".repeat(1_000)), done(1006));
    await f.memory.ingest("w");
    const list = f.memory["deps"].list;
    // BB refuses a page whose events pass its response limit: here, any page holding seq 1005.
    f.memory["deps"].list = async (args) => {
      const rows = await list(args);
      if (rows.some((r) => r.seq === 1005)) throw Error("Thread events response exceeds 8 MiB");
      return rows;
    };
    const { header, text } = await zoom(f, s, 1);
    expect(header).toContain("w:1002..1003; canonical semantic message");
    expect(text).toBe(`${use("a")}${USES}${use("b")}`);
  });

  it("reads a group whose events pass BB's response limit together, though each fits alone (review r2 P2)", async () => {
    // Screenshots: the logged text leaves out their image data, so the group is small.
    const shot = (url: string, data: string, seq: number) => item({ type: "toolCall", tool: "screenshot", arguments: { url }, result: image(data) }, seq);
    const { f, s } = await thread([...request(1000, "r", "go"), shot("a", "A".repeat(5_000), 1002), shot("b", "B".repeat(5_000), 1003), shot("c", "C".repeat(5_000), 1004), done(1005)]);
    await f.memory.ingest("w");
    expect(f.store.messages(s).map((m) => [m.seq, m.endSeq])).toEqual([[1000, null], [1002, 1004]]);
    const list = f.memory["deps"].list;
    // The limit, scaled down: one screenshot fits a page, two do not.
    f.memory["deps"].list = async (args) => {
      const rows = await list(args);
      if (JSON.stringify(rows).length > 8_000) throw Error("Thread events response exceeds 8 MiB");
      return rows;
    };
    const { header, text } = await zoom(f, s, 1);
    expect(header).toContain("w:1002..1004; canonical semantic message");
    expect(text).toMatch(/^screenshot {"url":"a"}\n→ .*\n\nscreenshot {"url":"b"}\n→ .*\n\nscreenshot {"url":"c"}\n→ /s);
    expect(await f.memory.evidence(s, 1, 1, 0, 2)).toMatchObject({ content: [{ type: "text" }, { type: "image", data: "C".repeat(5_000) }] });
  });

  it("falls back to the saved copy when a use inside a group is gone, its ends still there (review W571 r2 P2)", async () => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003), bash("c", 1004), done(1005)]);
    await f.memory.ingest("w");
    expect(f.store.messages(s)[1]).toMatchObject({ seq: 1002, endSeq: 1004, uses: 3 });
    f.history.splice(f.history.findIndex((r) => r.seq === 1003), 1);
    const z = await zoom(f, s, 1);
    expect(z.header).toContain("saved copy only; canonical tool uses could not be matched");
    expect(z.text).toBe([use("a"), use("b"), use("c")].join(USES));
  });

  it("falls back to the saved copy when a group's events are gone", async () => {
    const { f, s } = await thread([...request(1000, "r", "go"), bash("a", 1002), bash("b", 1003), done(1004)]);
    await f.memory.ingest("w");
    f.history.splice(f.history.findIndex((r) => r.seq === 1003), 1);
    const z = await zoom(f, s, 1);
    expect(z.header).toContain("saved copy only; canonical tool uses could not be matched");
    expect(z.text).toBe(`${use("a")}${USES}${use("b")}`);
  });

  it("zooms a mixed log: a legacy call and echo, a row of one use, then groups", async () => {
    const { f, s, push } = await thread();
    const old = [bash("legacy", 1000), bash("w571", 1001)];
    push(...old);
    f.store.append("w", [
      ...eventEntries(old[0]!, "w", facts, { legacy: true }),
      ...eventEntries(old[1]!, "w", facts),
    ].flatMap(splitEntry), 1001);
    push(bash("a", 1002), bash("b", 1003), item({ type: "agentMessage", text: "ok" }, 1004), bash("c", 1005), done(1006));
    await f.memory.ingest("w");
    expect(f.store.messages(s).map((m) => [m.kind, m.seq, m.endSeq])).toEqual([
      ["tool", 1000, null], ["echo", 1000, null], ["tool", 1001, null], ["tool", 1002, 1003], ["agent", 1004, null], ["tool", 1005, 1005],
    ]);
    expect((await Promise.all([0, 1, 2, 3, 4, 5].map((id) => zoom(f, s, id)))).map((z) => z.text)).toEqual([
      "Bash legacy", "exit 0\nout legacy", use("w571"), `${use("a")}${USES}${use("b")}`, "ok", use("c"),
    ]);
  });
});
