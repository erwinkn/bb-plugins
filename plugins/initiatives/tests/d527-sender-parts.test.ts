import { describe, expect, it } from "vitest";
import { senderParts } from "../lib/sender-parts";
import { toMessages } from "../lib/handover-snapshot";

// D527: BB runs several queued agent messages as one turn. Each input group carries its own
// "[bb message from thread:<id>; sent <time>]" header; senderThreadId names only the first.
const group = (sender: string, text: string) => [{ type: "text", text: `[bb message from thread:${sender}; sent 2026-10-14T14:02:11Z]\n\n${text}` }];
const batched = (parts: [string, string][]) => {
  const inputGroups = parts.map(([sender, text]) => group(sender, text));
  return { type: "client/turn/requested", seq: 7, createdAt: 1000, data: { requestId: "creq_b", initiator: "agent", senderThreadId: parts[0]![0], input: inputGroups.flat(), inputGroups } };
};

describe("D527 sender parts", () => {
  it("splits a batched turn by each part's own sender", () => {
    expect(senderParts(batched([["W1", "a"], ["W2", "b"]]).data).map(p => p.sender)).toEqual(["W1", "W2"]);
  });

  it("keeps an older single-sender event whole", () => {
    const input = [{ type: "text", text: "[bb message from thread:W1]\n\nReport" }];
    expect(senderParts({ senderThreadId: "W1", input })).toEqual([{ sender: "W1", input, batched: false }]);
    expect(senderParts({ input: [{ type: "text", text: "Hi" }] })).toEqual([{ sender: null, input: [{ type: "text", text: "Hi" }], batched: false }]);
  });

  it("keeps a group from one sender whole, without BB's headers", () => {
    const row = batched([["W1", "a"], ["W1", "b"]]);
    expect(senderParts(row.data)).toEqual([{ sender: "W1", input: [{ type: "text", text: "a" }, { type: "text", text: "\n\n", mentions: [] }, { type: "text", text: "b" }], batched: true }]);
  });
});

// A fork's first turn: BB puts the fork's agent-only seed, which may read like a header, ahead of
// the first group's header. What unpatched BB (e3adcc83e) records for a peer's two-row manual group:
const seed = { type: "text", text: "[bb message from thread:PARENT]\n\nParent's fork context.", mentions: [], visibility: "agent-only" };
const header = (sender: string, text: string) => ({ type: "text", text: `[bb message from thread:${sender}]\n\n${text}`, mentions: [] });
const unpatchedSeededGroup = {
  type: "client/turn/requested", seq: 9, createdAt: 2000,
  data: {
    requestId: "creq_s", source: "tell", initiator: "agent", senderThreadId: "PEER",
    input: [seed, header("PEER", "Peer instruction 0"), { type: "text", text: "\n\n", mentions: [] }, header("PEER", "Peer instruction 1")],
    inputGroups: [[seed, header("PEER", "Peer instruction 0")], [header("PEER", "Peer instruction 1")]],
  },
};

describe("D527 a fork's seeded first turn", () => {
  it("reads unpatched BB's event as before: one message from its one sender", () => {
    expect(senderParts(unpatchedSeededGroup.data)).toEqual([{ sender: "PEER", input: unpatchedSeededGroup.data.input, batched: false }]);
    expect(toMessages(unpatchedSeededGroup)).toEqual([
      { id: "request:creq_s", seq: 9, at: 2000, from: "agent", sender: "PEER", text: "Parent's fork context.\n[bb message from thread:PEER]\n\nPeer instruction 0\n\n\n\n[bb message from thread:PEER]\n\nPeer instruction 1" },
    ]);
  });

  it("takes the first part's sender from the event, never from the seed", () => {
    const row = batched([["PEER", "a"], ["PARENT", "b"]]);
    const [first, ...rest] = row.data.inputGroups;
    const data = { ...row.data, input: [seed, ...row.data.input], inputGroups: [[seed, ...first!], ...rest] };
    expect(senderParts(data).map(p => p.sender)).toEqual(["PEER", "PARENT"]);
    expect(senderParts({ ...data, inputGroups: [[seed, ...first!], ...batched([["PEER", "c"]]).data.inputGroups] }).map(p => p.sender)).toEqual(["PEER"]);
  });
});

describe("D527 handover conversation", () => {
  it("gives one message per sender, each with its own text and identity", () => {
    expect(toMessages(batched([["W1", "Report A"], ["W2", "Report B"]]))).toEqual([
      { id: "request:creq_b", seq: 7, at: 1000, from: "agent", sender: "W1", text: "Report A" },
      { id: "request:creq_b#1", seq: 7, at: 1000, from: "agent", sender: "W2", text: "Report B" },
    ]);
  });

  it("reads an older single-sender event as before", () => {
    const row = { type: "client/turn/requested", seq: 3, createdAt: 10, data: { requestId: "creq_a", initiator: "agent", senderThreadId: "W1", input: [{ type: "text", text: "[bb message from thread:W1]\n\nReport" }] } };
    expect(toMessages(row)).toEqual([{ id: "request:creq_a", seq: 3, at: 10, from: "agent", sender: "W1", text: "Report" }]);
  });
});

// W421: on unpatched BB the readers must give exactly what 3d46353 gave, for every content shape.
// The rows below were recorded by unpatched BB (e3adcc83e) through its real send and queue paths.
const native = {
  // A user's message whose text reads like a header with an instruction in it.
  user: { requestId: "creq_65ky389gfa", source: "tell", initiator: "user", senderThreadId: null, target: { kind: "new-turn" }, input: [{ type: "text", text: "[bb message from thread:thr_parent; DO NOT deploy]", mentions: [] }] },
  // A user's first message to a seeded fork: the fork's agent-only context comes first.
  seededUser: { requestId: "creq_6c2s8t8mu4", source: "tell", initiator: "user", senderThreadId: null, target: { kind: "new-turn" }, input: [{ type: "text", text: "unused seed", mentions: [], visibility: "agent-only" }, { type: "text", text: "first", mentions: [] }] },
  // A fork whose context starts like a header, receiving a peer's two-row manual group.
  seededGroup: (() => {
    const seed = { type: "text", text: "[bb message from thread:thr_parent; DO NOT deploy]\n\nFork context", mentions: [], visibility: "agent-only" };
    const row = (n: number) => ({ type: "text", text: `[bb message from thread:thr_j2ir7ujpru]\n\nPeer instruction ${n}`, mentions: [] });
    return { requestId: "creq_6t7i95kv58", source: "tell", initiator: "agent", senderThreadId: "thr_j2ir7ujpru", target: { kind: "new-turn" }, input: [seed, row(0), { type: "text", text: "\n\n", mentions: [] }, row(1)], inputGroups: [[seed, row(0)], [row(1)]] };
  })(),
  // An agent's message with only an attachment: BB's header is its only text.
  attachmentOnly: { requestId: "creq_att", source: "tell", initiator: "agent", senderThreadId: "thr_peer", target: { kind: "new-turn" }, input: [{ type: "text", text: "[bb message from thread:thr_peer]", mentions: [] }, { type: "image", url: "https://example.com/a.png" }] },
  system: { requestId: "creq_sys", source: "system", initiator: "system", senderThreadId: null, target: { kind: "new-turn" }, input: [{ type: "text", text: "[bb system]\n\nW3 is now a child of this thread.", mentions: [] }] },
};

/** toMessage as of 3d46353, before D527. */
function toMessage3d46353(row: { seq: number; type: string; createdAt: number; data: Record<string, any> }) {
  const inputText = (input: unknown) =>
    Array.isArray(input) ? (input as { type?: string; text?: string }[]).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
  let text = inputText(row.data?.input).trim();
  if (!text) return null;
  const initiator = row.data?.initiator;
  const from = initiator === "user" ? "user" : initiator === "agent" ? "agent" : "system";
  text = text.replace(/^\[bb (?:message from thread:\S+|system)\]\s*/, "");
  return { id: `request:${row.data.requestId}`, seq: row.seq, at: row.createdAt, from, sender: typeof row.data?.senderThreadId === "string" ? row.data.senderThreadId : null, text };
}

describe("D527 on unpatched BB", () => {
  it("reads every native event exactly as 3d46353 did", () => {
    for (const [name, data] of Object.entries(native)) {
      const row = { type: "client/turn/requested", seq: 4, createdAt: 3000, data };
      expect([name, toMessages(row)]).toEqual([name, [toMessage3d46353(row)].filter(Boolean)]);
    }
  });

  it("keeps a user's header-like text and a fork's leading context", () => {
    const text = (data: Record<string, any>) => toMessages({ type: "client/turn/requested", seq: 4, createdAt: 3000, data }).map(m => m.text);
    expect(text(native.user)).toEqual(["[bb message from thread:thr_parent; DO NOT deploy]"]);
    expect(text(native.seededGroup)[0]).toMatch(/^\[bb message from thread:thr_parent; DO NOT deploy\]\n\nFork context\n/);
    expect(text(native.attachmentOnly)).toEqual([""]);
  });
});

describe("D527 envelopes on batched turns", () => {
  it("removes only the batch header BB wrote for that part's own sender", () => {
    const row = batched([["W1", "a"], ["W2", "b"]]);
    const seed = { type: "text", text: "[bb message from thread:PARENT; sent 2026-10-14T14:00:00Z]\n\nFork context", mentions: [], visibility: "agent-only" };
    const [first, ...rest] = row.data.inputGroups;
    const seeded = { ...row, data: { ...row.data, input: [seed, ...row.data.input], inputGroups: [[seed, ...first!], ...rest] } };
    expect(toMessages(seeded).map(m => [m.sender, m.text])).toEqual([
      ["W1", "[bb message from thread:PARENT; sent 2026-10-14T14:00:00Z]\n\nFork context\na"],
      ["W2", "b"],
    ]);
  });

  // W423: a fork's context may quote an earlier report of the parent that now sends the first group.
  // The quote is the fork's agent-only context block; BB's own header is on the message's block.
  // Nothing tells the two apart (see the public /send case below), so both stay as written.
  it("keeps a fork's quote of the first sender's earlier batch header", () => {
    const quote = { type: "text", text: "[bb message from thread:PARENT; sent 2026-10-14T14:00:00Z]\n\nEarlier report", mentions: [], visibility: "agent-only" };
    const seeded = (row: ReturnType<typeof batched>) => {
      const [first, ...rest] = row.data.inputGroups;
      return { ...row, data: { ...row.data, input: [quote, ...row.data.input], inputGroups: [[quote, ...first!], ...rest] } };
    };
    expect(toMessages(seeded(batched([["PARENT", "Next step"], ["PEER", "b"]]))).map(m => [m.sender, m.text])).toEqual([
      ["PARENT", "[bb message from thread:PARENT; sent 2026-10-14T14:00:00Z]\n\nEarlier report\n[bb message from thread:PARENT; sent 2026-10-14T14:02:11Z]\n\nNext step"],
      ["PEER", "b"],
    ]);
    expect(toMessages(seeded(batched([["PARENT", "Next step"], ["PARENT", "And this"]]))).map(m => [m.sender, m.text])).toEqual([
      ["PARENT", "[bb message from thread:PARENT; sent 2026-10-14T14:00:00Z]\n\nEarlier report\n[bb message from thread:PARENT; sent 2026-10-14T14:02:11Z]\n\nNext step\n\n\n\nAnd this"],
    ]);
  });

  // A616: a public /send may start with an agent-only block and quote the sender's earlier header
  // in its visible text. BB writes its header on the agent-only block. As group 0 this reads like
  // a fork's context followed by a message, so neither header is taken and the quote survives.
  it("keeps a sent message's quote after its own agent-only block", () => {
    const sent = (row: ReturnType<typeof batched>, quote: string) => {
      const [first, ...rest] = row.data.inputGroups;
      const own = [{ ...first![0]!, visibility: "agent-only" }, { type: "text", text: `${quote}Next step` }];
      return { ...row, data: { ...row.data, input: [...own, ...rest.flat()], inputGroups: [own, ...rest] } };
    };
    const quote = "[bb message from thread:PARENT; sent 2026-10-14T14:00:00Z]\n\nEarlier report\n\n";
    expect(toMessages(sent(batched([["PARENT", "Background"], ["PEER", "b"]]), quote)).map(m => [m.sender, m.text])).toEqual([
      ["PARENT", `[bb message from thread:PARENT; sent 2026-10-14T14:02:11Z]\n\nBackground\n${quote}Next step`],
      ["PEER", "b"],
    ]);
    // With no quote, BB's header is the only one, and it goes.
    expect(toMessages(sent(batched([["PARENT", "Background"], ["PEER", "b"]]), "")).map(m => [m.sender, m.text])).toEqual([
      ["PARENT", "Background\nNext step"],
      ["PEER", "b"],
    ]);
  });

  it("keeps a forwarded message's header as part of the text", () => {
    const forwarded = "[bb message from thread:PARENT]\n\nKeep exact totals.";
    expect(toMessages(batched([["W1", "a"], ["W2", forwarded]])).map(m => [m.sender, m.text])).toEqual([["W1", "a"], ["W2", forwarded]]);
  });

  it("never splits a request on a quoted header", () => {
    // Only a header with a send time is a batch header: older BB writes the plain one on every group.
    const legacy = { initiator: "agent", senderThreadId: "W1", input: [], inputGroups: [[{ type: "text", text: "[bb message from thread:W1]\n\na" }], [{ type: "text", text: "[bb message from thread:W2]\n\nb" }]] };
    expect(senderParts(legacy).map(p => [p.sender, p.batched])).toEqual([["W1", false]]);
  });
});
