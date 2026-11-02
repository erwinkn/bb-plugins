import { describe, expect, it } from "vitest";
import { fixture } from "./fixture";
import { CLIP, eventEntries, splitEntry, type EventRow, type LogEntry } from "../lib/log";

/** W571: a tool use is one log entry, its call and its result; rows logged before as a tool and an echo still zoom. */
const facts = { spawnedByPlugin: false, sender: (id: string) => id };
const item = (it: Record<string, unknown>, seq = 1): EventRow => ({ seq, type: "item/completed", createdAt: 1_000, data: { item: it } });
const entries = (row: EventRow) => eventEntries(row, "w", facts).map((e) => `${e.kind}: ${e.text}`);
const image = { content: [{ type: "text", text: "screenshot taken" }, { type: "image", data: "OPAQUE", mimeType: "image/png" }] };

describe("W571 tool entries", () => {
  it("logs a command as its call, then → and its exit code and output", () => {
    const row = item({ type: "commandExecution", command: "cd ~/Code/bb && git status -sb", exitCode: 0, aggregatedOutput: "## erwin...origin/erwin [ahead 2]\n" });
    expect(eventEntries(row, "w", facts)).toEqual([{ at: 1_000, threadId: "w", seq: 1, kind: "tool", sourcePart: 0, text: "Bash cd ~/Code/bb && git status -sb\n→ exit 0\n## erwin...origin/erwin [ahead 2]" }]);
  });

  it("keeps an MCP tool's error, and its result when it has one", () => {
    expect(entries(item({ type: "toolCall", tool: "mcp__bb-bridge__initiative_read", arguments: { refs: ["W1"] }, error: { message: "not found" } }))).toEqual([
      'tool: initiative_read {"refs":["W1"]}\n→ error: {"message":"not found"}',
    ]);
    expect(entries(item({ type: "toolCall", tool: "x", arguments: {}, result: "partial", error: "timeout" }))).toEqual(['tool: x {}\n→ partial\nerror: timeout']);
  });

  it("omits a result's image data, and a call without a result is the call alone", () => {
    const [text] = entries(item({ type: "toolCall", tool: "screenshot", arguments: { url: "a" }, result: image }));
    expect(text).toMatch(/^tool: screenshot {"url":"a"}\n→ {"content":\[{"type":"text","text":"screenshot taken"},{"type":"image","data":"\[attachment data; retrieve with memory_zoom\]"/);
    expect(text).not.toContain("OPAQUE");
    expect(entries(item({ type: "toolCall", tool: "noop", arguments: {} }))).toEqual(["tool: noop {}"]);
    expect(entries(item({ type: "commandExecution", command: "true", aggregatedOutput: "  \n" }))).toEqual(["tool: Bash true"]);
  });

  it("logs a file change as its paths, then → and its diffs", () => {
    expect(entries(item({ type: "fileChange", changes: [{ kind: "update", path: "a.ts", diff: "-x\n+y" }, { kind: "add", path: "b.ts", diff: "+z" }] }))).toEqual([
      "tool: Edit update a.ts, add b.ts\n→ -x\n+y\n+z",
    ]);
    expect(entries(item({ type: "fileChange", changes: [{ kind: "delete", path: "c.ts" }] }))).toEqual(["tool: Edit delete c.ts"]);
  });

  it("clips the result to its head and tail but keeps the call whole, then splits past 30,000 characters", () => {
    const [clipped] = eventEntries(item({ type: "commandExecution", command: "cat big", exitCode: 0, aggregatedOutput: "a".repeat(40_000) + "END" }), "w", facts);
    expect(clipped!.text).toMatch(/^Bash cat big\n→ exit 0\na+\n\[\.\.\. 10010 chars clipped \.\.\.\]\na+END$/);
    expect(clipped!.text.length).toBeLessThan(CLIP + 100);
    // A long call and a long result, neither clipped, are one entry split into 30,000-character parts.
    const row = item({ type: "toolCall", tool: "write", arguments: { body: "c".repeat(20_000) }, result: "r".repeat(20_000) + "TAIL" });
    const [whole] = eventEntries(row, "w", facts);
    expect(whole!.text).toContain("r".repeat(20_000) + "TAIL");
    const parts = splitEntry(whole!);
    expect(parts.map((p) => [p.kind, p.sourcePart, p.text.length])).toEqual([["tool", 0, 30_000], ["tool", 0, whole!.text.length - 30_000]]);
    expect(parts[1]!.text.endsWith("TAIL")).toBe(true);
  });

  it("leaves other items as one entry, and the legacy form is a tool and an echo, as logged before", () => {
    expect(entries(item({ type: "webSearch", id: "x", query: "bb" }))).toEqual(['tool: webSearch {"query":"bb"}']);
    const row = item({ type: "commandExecution", command: "git status", exitCode: 0, aggregatedOutput: "clean" });
    expect(eventEntries(row, "w", facts, { legacy: true }).map((e) => [e.kind, e.sourcePart, e.text])).toEqual([["tool", 0, "Bash git status"], ["echo", 1, "exit 0\nclean"]]);
  });

  it("logs a 20-command turn as 22 messages, not 42", async () => {
    const f = fixture();
    const s = await f.attach("initiatives", "p", f.thread("w"));
    f.history.push({ threadId: "w", seq: 1000, type: "client/turn/requested", data: { requestId: "r", input: [{ type: "text", text: "check the repo" }] } });
    f.history.push({ threadId: "w", seq: 1001, type: "turn/input/accepted", data: { clientRequestId: "r" } });
    for (let k = 0; k < 20; k++) f.history.push({ threadId: "w", ...item({ type: "commandExecution", command: `git log -${k}`, exitCode: 0, aggregatedOutput: `out ${k}` }, 1002 + k) });
    f.history.push({ threadId: "w", seq: 1022, type: "item/completed", data: { item: { type: "agentMessage", text: "Done." } } });
    f.history.push({ threadId: "w", seq: 1023, type: "turn/completed", data: { status: "completed" } });
    await f.memory.ingest("w");
    const log = f.log(s);
    expect(log).toHaveLength(22);
    expect(log.slice(0, 3)).toEqual(["user: check the repo", "tool: Bash git log -0\n→ exit 0\nout 0", "tool: Bash git log -1\n→ exit 0\nout 1"]);
  });
});

describe("W571 zoom", () => {
  /** Zoom pages of message id, joined: the header of the first page, and the whole text. */
  async function zoom(f: ReturnType<typeof fixture>, s: string, id: number) {
    let offset = 0;
    let text = "";
    let first = "";
    for (;;) {
      const result = await f.memory.evidence(s, id, 1, offset);
      if (typeof result === "string") throw Error("expected content");
      const part = result.content[0]!;
      if (part.type !== "text") throw Error("expected text");
      const [header, ...body] = part.text.split("\n");
      first ||= header!;
      text += body.join("\n");
      const next = /next offset (\d+)/.exec(header!);
      if (!next) return { header: first, text };
      offset = Number(next[1]);
    }
  }
  /** A thread with an attached scope, and its events through `through` logged by the code before W571. */
  async function legacyLog(rows: EventRow[], through: number, sourceParts = true) {
    const f = fixture();
    const s = await f.attach("initiatives", "p", f.thread("w"));
    for (const row of rows) f.history.push({ threadId: "w", ...row });
    const logged: LogEntry[] = rows.flatMap((row) => eventEntries(row, "w", facts, { legacy: true })).flatMap(splitEntry).map((e) => (sourceParts ? e : { ...e, sourcePart: null }));
    f.store.append("w", logged, through);
    return { f, s };
  }

  it("returns a new tool row's call with its whole result, its image and its truncation note", async () => {
    const f = fixture();
    const s = await f.attach("initiatives", "p", f.thread("w"));
    const result = "é".repeat(20_000) + "MIDDLE-EVIDENCE" + "€".repeat(20_000);
    f.history.push({ threadId: "w", ...item({ type: "toolCall", tool: "read", arguments: { path: "p" }, result }, 1000) });
    f.history.push({ threadId: "w", ...item({ type: "toolCall", tool: "screenshot", arguments: { url: "a" }, result: image }, 1001) });
    f.history.push({ threadId: "w", ...item({ type: "commandExecution", command: "cat log", exitCode: 0, aggregatedOutput: "head [...] tail", truncation: { removed: 100 } }, 1002) });
    f.history.push({ threadId: "w", seq: 1003, type: "turn/completed", data: { status: "completed" } });
    await f.memory.ingest("w");
    // The clipped result and its call pass 30,000 characters: two parts of one entry.
    expect(f.store.messages(s).map((m) => [m.seq, m.kind, m.sourcePart])).toEqual([[1000, "tool", 0], [1000, "tool", 0], [1001, "tool", 0], [1002, "tool", 0]]);
    expect(f.log(s).join("")).not.toContain("MIDDLE-EVIDENCE");

    const read = await zoom(f, s, 0);
    expect(read.header).toContain("source w:1000; canonical semantic message; kind tool");
    expect(read.text).toBe(`read {"path":"p"}\n→ ${result}`);

    expect((await zoom(f, s, 1)).text).toBe(read.text);

    const shot = await f.memory.zoomText(s, 2, 1);
    expect(shot).toContain("canonical semantic message");
    expect(shot).toContain("Attachments (retrieve with attachment index):\n0: image/png");
    expect(await f.memory.evidence(s, 2, 1, 0, 0)).toMatchObject({ content: [{ type: "text" }, { type: "image", data: "OPAQUE", mimeType: "image/png" }] });

    expect(await f.memory.zoomText(s, 3, 1)).toContain("canonical retained output; source retention may have removed the middle");
  });

  it("returns a legacy tool row as its call alone and a legacy echo as its result, with its image and truncation note", async () => {
    const result = "x".repeat(40_000) + "END";
    const { f, s } = await legacyLog([
      item({ type: "toolCall", tool: "read", arguments: { path: "p" }, result }, 1000),
      item({ type: "toolCall", tool: "screenshot", arguments: { url: "a" }, result: image }, 1001),
      item({ type: "commandExecution", command: "cat log", exitCode: 0, aggregatedOutput: "head [...] tail", truncation: { removed: 100 } }, 1002),
    ], 1002);
    // The clipped echo passes 30,000 characters with its marker: two parts.
    expect(f.log(s).map((l) => l.split(" ")[0])).toEqual(["tool:", "echo:", "echo:", "tool:", "echo:", "tool:", "echo:"]);

    const call = await zoom(f, s, 0);
    expect(call.header).toContain("canonical semantic message; kind tool");
    expect(call.text).toBe('read {"path":"p"}');
    const echo = await zoom(f, s, 1);
    expect(echo.header).toContain("canonical semantic message; kind echo");
    expect(echo.text).toBe(result);
    expect((await zoom(f, s, 2)).text).toBe(result);

    expect(await f.memory.zoomText(s, 3, 1)).not.toContain("Attachments");
    expect(await f.memory.zoomText(s, 4, 1)).toContain("Attachments (retrieve with attachment index):\n0: image/png");
    expect(await f.memory.evidence(s, 4, 1, 0, 0)).toMatchObject({ content: [{ type: "text" }, { type: "image", data: "OPAQUE" }] });

    const cat = await f.memory.zoomText(s, 5, 1);
    expect(cat).toContain("canonical semantic message; kind tool");
    expect(cat).toMatch(/\nBash cat log$/);
    expect(await f.memory.zoomText(s, 6, 1)).toContain("canonical retained output");
  });

  it("matches legacy rows logged before source parts by their content", async () => {
    const { f, s } = await legacyLog([item({ type: "commandExecution", command: "git status", exitCode: 0, aggregatedOutput: "clean" }, 1000)], 1000, false);
    expect(f.store.messages(s).map((m) => m.sourcePart)).toEqual([null, null]);
    expect(await f.memory.zoomText(s, 0, 1)).toMatch(/canonical semantic message; kind tool.*\nBash git status$/);
    expect(await f.memory.zoomText(s, 1, 1)).toMatch(/canonical semantic message; kind echo.*\nexit 0\nclean$/);
  });

  it("reads a row's format from the log, not its text: a new row matching an old call zooms to call and result", async () => {
    // Logged in the new format when the result was empty, so the row is the call alone; the event
    // now holds a result. Its text equals the legacy call, but no echo row follows it.
    const f = fixture();
    const s = await f.attach("initiatives", "p", f.thread("w"));
    const row = item({ type: "commandExecution", command: "test", aggregatedOutput: "retained [...] tail", truncation: { removed: 10 } }, 1000);
    f.history.push({ threadId: "w", ...row });
    f.store.append("w", [{ at: 0, threadId: "w", seq: 1000, kind: "tool", text: "Bash test", sourcePart: 0 }], 1000);
    const z = await zoom(f, s, 0);
    expect(z.header).toContain("canonical retained output");
    expect(z.text).toBe("Bash test\n→ retained [...] tail");
  });

  it("returns a legacy call alone whatever whitespace its stored parts lost, with or without source parts", async () => {
    // Before W571 a terminal turn's entries were split twice, trimming each part: a second chunk
    // that began with a newline was stored without it.
    const command = "a".repeat(30_000 - 5) + "\n\nsecond line";
    const row = item({ type: "commandExecution", command, exitCode: 1, aggregatedOutput: "boom" }, 1000);
    for (const sourceParts of [true, false]) {
      const f = fixture();
      const s = await f.attach("initiatives", "p", f.thread("w"));
      f.history.push({ threadId: "w", ...row });
      const logged = eventEntries(row, "w", facts, { legacy: true }).flatMap(splitEntry).flatMap(splitEntry).map((e) => (sourceParts ? e : { ...e, sourcePart: null }));
      expect(logged.map((e) => e.text)).toContain("second line");
      f.store.append("w", logged, 1000);
      for (const id of [0, 1]) expect((await zoom(f, s, id)).text).toBe(`Bash ${command}`);
      expect((await zoom(f, s, 2)).text).toBe("exit 1\nboom");
    }
  });

  it("zooms every part of a mixed log: legacy rows, then new ones, including a split legacy call", async () => {
    const long = { body: "c".repeat(35_000) };
    const { f, s } = await legacyLog([
      item({ type: "toolCall", tool: "write", arguments: long, result: "ok" }, 1000),
      { seq: 1001, type: "turn/completed", data: { status: "completed" } },
    ], 1001);
    f.history.push({ threadId: "w", ...item({ type: "toolCall", tool: "write", arguments: long, result: "ok" }, 1002) });
    f.history.push({ threadId: "w", ...item({ type: "agentMessage", text: "Written." }, 1003) });
    f.history.push({ threadId: "w", seq: 1004, type: "turn/completed", data: { status: "completed" } });
    await f.memory.ingest("w");
    const call = `write ${JSON.stringify(long)}`;
    // Legacy: the call in two parts and its echo. New: the call and result in two parts, and the reply.
    expect(f.store.messages(s).map((m) => [m.seq, m.kind, m.sourcePart])).toEqual([
      [1000, "tool", 0], [1000, "tool", 0], [1000, "echo", 1],
      [1002, "tool", 0], [1002, "tool", 0], [1003, "agent", 0],
    ]);
    // The legacy call's first part is also the new entry's first part: the echo row after it,
    // not the text, says it was logged alone.
    expect((await zoom(f, s, 0)).text).toBe(call);
    expect((await zoom(f, s, 1)).text).toBe(call);
    expect((await zoom(f, s, 2)).text).toBe("ok");
    for (const id of [3, 4]) {
      const z = await zoom(f, s, id);
      expect(z.header).toContain("canonical semantic message; kind tool");
      expect(z.text).toBe(`${call}\n→ ok`);
    }
    expect((await zoom(f, s, 5)).text).toBe("Written.");
  });
});
