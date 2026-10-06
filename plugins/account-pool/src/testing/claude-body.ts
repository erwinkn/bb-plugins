// A synthetic Claude Code /v1/messages body of about the requested size, shaped like the real
// thing: a metadata.user_id JSON string, cached system blocks, tool schemas, and a long
// conversation of tool calls whose results carry most of the bytes (source files, logs).

const LINE_SAMPLES = [
  'export function parseRequestBody(body: Uint8Array): ParsedRequestBody {',
  '  const parsed = requestSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));',
  '    if (!parsed.success) return { family: "other", affinityId: null };',
  '// The hub forwards "tool_reference" blocks; see README §Routing for why.',
  '\tat Object.<anonymous> (/home/erwin/Code/bb-plugins/plugins/account-pool/src/hub.ts:612:15)',
  '{"level":30,"time":1791282625211,"component":"server","msg":"Event loop stalled"}',
  "  ✓ src/ledger.test.ts (24 tests) 112ms — résumé of naïve café ünïcode",
  "",
];

function fileText(seed: number, bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index += 1) {
    const sample = LINE_SAMPLES[(seed + index * 7) % LINE_SAMPLES.length];
    const line = `${String(index + 1).padStart(5, " ")}\t${sample}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

export interface ClaudeBodyOptions {
  bytes: number;
  sessionId?: string;
  accountUuid?: string;
  model?: string;
  seed?: number;
}

export function claudeCodeRequest(options: ClaudeBodyOptions): Record<string, unknown> {
  const seed = options.seed ?? 0;
  const tools = Array.from({ length: 40 }, (_, index) => ({
    name: `Tool${index}`,
    description: fileText(seed + index, 1_500),
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path." },
        limit: { type: "number" },
        pattern: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  }));
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: [{ type: "text", text: "Fix the stalls in the Pooler." }] },
  ];
  let size = 120_000;
  for (let turn = 0; size < options.bytes; turn += 1) {
    const resultBytes = 2_000 + ((seed + turn * 7_919) % 24_000);
    const id = `toolu_${String(seed).padStart(4, "0")}${String(turn).padStart(8, "0")}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Reading the next file (${turn}).` },
        {
          type: "tool_use",
          id,
          name: `Tool${turn % 40}`,
          input: { path: `/home/erwin/Code/bb-plugins/src/file-${turn}.ts`, limit: 2_000 },
        },
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text: fileText(seed + turn, resultBytes) }],
        },
      ],
    });
    size += resultBytes * 1.04 + 400;
  }
  const last = messages.at(-1)?.content as Array<Record<string, unknown>>;
  last.at(-1)!.cache_control = { type: "ephemeral", ttl: "1h" };
  return {
    model: options.model ?? "claude-opus-4-1",
    max_tokens: 32_000,
    stream: true,
    metadata: {
      user_id: JSON.stringify({
        device_id: "d".repeat(64),
        account_uuid: options.accountUuid ?? "22222222-2222-4222-8222-222222222222",
        session_id: options.sessionId ?? "33333333-3333-4333-8333-333333333333",
      }),
    },
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.287" },
      { type: "text", text: fileText(seed, 40_000), cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools,
    messages,
    thinking: { type: "adaptive" },
  };
}

export function claudeCodeBody(options: ClaudeBodyOptions): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(claudeCodeRequest(options)));
}
