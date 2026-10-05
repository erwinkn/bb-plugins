// A realistic offline Responses stream as the Codex backend sends it to the
// Pooler and the Pooler relays it: event names and fields follow the OpenAI
// Responses streaming events that BB's own Codex client reads
// (response.output_text.delta, response.completed). Modeled, not captured:
// no live stream was recorded. The `obfuscation` padding field that live
// OpenAI streams add to deltas is left out, so sizes here are a lower bound.

const findingJson = (i: number) => ({
  category: "test-integrity",
  severity: "concern",
  evidence: `E:${100 + i}:0#0`,
  hunk: 0,
  subject: `computes totals with refunds case ${i}`,
  relation: null,
  before: { hunk: null, lines: [3, 3], quote: "expect(total(ledger())).toBe(42);" },
  after: { hunk: null, lines: [3, 3], quote: "expect(total(ledger())).toBeGreaterThan(0);" },
  requirement: { ref: "R:1", quote: "totals must equal the ledger sum including refunds" },
  claim: null,
  command: null,
  summary:
    "The exact equality on the refund total was replaced by a positivity check, so a total that omits refunds now passes. " +
    "The requirement asks for totals equal to the ledger sum including refunds; the new assertion no longer checks that sum. ".repeat(3),
});

export interface LunaStream {
  text: string;
  usage: { input_tokens: number; output_tokens: number; output_tokens_details: { reasoning_tokens: number } };
  findings: number;
}

/** One complete stream whose visible output is about `visibleTokens` tokens (4 characters each). */
export function lunaStream(o: { visibleTokens: number; reasoningTokens: number; model?: string }): LunaStream {
  const model = o.model ?? "gpt-6-luna";
  const findings: unknown[] = [];
  let out = JSON.stringify({ findings, resolved: [] });
  while (out.length < o.visibleTokens * 4 - 1500) {
    findings.push(findingJson(findings.length));
    out = JSON.stringify({ findings, resolved: [] });
  }
  const tokens = out.match(/[\s\S]{1,4}/gu) ?? [];
  const respId = "resp_" + "0a1b2c3d4e5f6a7b".repeat(3);
  const msgId = "msg_" + "9f8e7d6c5b4a3f2e".repeat(3);
  const rsId = "rs_" + "1122334455667788".repeat(3);
  const usage = { input_tokens: 9000, output_tokens: tokens.length + o.reasoningTokens, output_tokens_details: { reasoning_tokens: o.reasoningTokens } };
  const base = { id: respId, object: "response", created_at: 1791189116, model, store: false, max_output_tokens: 2000, reasoning: { effort: "low", summary: null } };
  let seq = 0;
  const ev = (type: string, body: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...body })}\n\n`;
  const reasoning = { id: rsId, type: "reasoning", summary: [] };
  const part = (text: string) => ({ type: "output_text", text, annotations: [], logprobs: [] });
  const message = (text: string, status: string) => ({ id: msgId, type: "message", status, role: "assistant", content: text === "" && status === "in_progress" ? [] : [part(text)] });
  const parts = [
    ev("response.created", { response: { ...base, status: "in_progress", output: [], usage: null } }),
    ev("response.in_progress", { response: { ...base, status: "in_progress", output: [], usage: null } }),
    ev("response.output_item.added", { output_index: 0, item: reasoning }),
    ev("response.output_item.done", { output_index: 0, item: reasoning }),
    ev("response.output_item.added", { output_index: 1, item: message("", "in_progress") }),
    ev("response.content_part.added", { item_id: msgId, output_index: 1, content_index: 0, part: part("") }),
    ...tokens.map((delta) => ev("response.output_text.delta", { item_id: msgId, output_index: 1, content_index: 0, delta, logprobs: [] })),
    ev("response.output_text.done", { item_id: msgId, output_index: 1, content_index: 0, text: out, logprobs: [] }),
    ev("response.content_part.done", { item_id: msgId, output_index: 1, content_index: 0, part: part(out) }),
    ev("response.output_item.done", { output_index: 1, item: message(out, "completed") }),
    ev("response.completed", { response: { ...base, status: "completed", output: [reasoning, message(out, "completed")], usage } }),
  ];
  return { text: parts.join(""), usage, findings: findings.length };
}
