// The reviewer's output contract: a strict JSON schema sent to the model, and
// the zod parser applied to whatever comes back. The schema has
// additionalProperties:false on every object and no numeric or length bounds
// (A154); the parser enforces the bounds the schema cannot.

import { z } from "zod";

export const MAX_FINDINGS = 5;
export const SUMMARY_MAX = 600;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

const citeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hunk", "lines", "quote"],
  properties: {
    hunk: { type: ["integer", "null"] },
    lines: { type: "array", items: { type: "integer" } },
    quote: { type: "string" },
  },
};

export const FINDINGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "resolved"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "severity", "evidence", "hunk", "subject", "relation", "before", "after", "requirement", "claim", "command", "summary"],
        properties: {
          category: { type: "string", enum: ["test-integrity", "unsupported-claim", "missed-requirement"] },
          severity: { type: "string", enum: ["note", "concern", "critical"] },
          evidence: { type: "string" },
          hunk: { type: ["integer", "null"] },
          subject: { type: ["string", "null"] },
          relation: { type: ["string", "null"], enum: ["moved", null] },
          before: nullable(citeSchema),
          after: nullable(citeSchema),
          requirement: nullable({
            type: "object",
            additionalProperties: false,
            required: ["ref", "quote"],
            properties: { ref: { type: "string" }, quote: { type: "string" } },
          }),
          claim: nullable({
            type: "object",
            additionalProperties: false,
            required: ["evidence", "quote"],
            properties: { evidence: { type: "string" }, quote: { type: "string" } },
          }),
          command: nullable({
            type: "object",
            additionalProperties: false,
            required: ["evidence"],
            properties: { evidence: { type: "string" } },
          }),
          summary: { type: "string" },
        },
      },
    },
    resolved: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["locator", "evidence", "note"],
        properties: { locator: { type: "string" }, evidence: { type: "string" }, note: { type: "string" } },
      },
    },
  },
} as const;

const cite = z
  .object({ hunk: z.number().int().nullable(), lines: z.tuple([z.number().int(), z.number().int()]), quote: z.string() })
  .strict();

export const findingSchema = z
  .object({
    category: z.enum(["test-integrity", "unsupported-claim", "missed-requirement"]),
    severity: z.enum(["note", "concern", "critical"]),
    evidence: z.string(),
    hunk: z.number().int().nullable(),
    subject: z.string().nullable(),
    relation: z.literal("moved").nullable(),
    before: cite.nullable(),
    after: cite.nullable(),
    requirement: z.object({ ref: z.string(), quote: z.string() }).strict().nullable(),
    claim: z.object({ evidence: z.string(), quote: z.string() }).strict().nullable(),
    command: z.object({ evidence: z.string() }).strict().nullable(),
    summary: z.string(),
  })
  .strict();

export type ModelFinding = z.infer<typeof findingSchema>;

export const outputSchema = z
  .object({
    findings: z.array(z.unknown()),
    resolved: z.array(z.object({ locator: z.string(), evidence: z.string(), note: z.string() }).strict()),
  })
  .strict();

export interface ParsedOutput {
  findings: ModelFinding[];
  resolved: Array<{ locator: string; evidence: string; note: string }>;
  /** Malformed items, and items beyond MAX_FINDINGS: dropped and counted, never repaired. */
  dropped: Array<{ index: number; reason: string }>;
}

export function parseOutput(raw: unknown): ParsedOutput | { error: string } {
  const top = outputSchema.safeParse(raw);
  if (!top.success) return { error: `output does not match the schema: ${top.error.issues[0]?.message ?? "invalid"}` };
  const findings: ModelFinding[] = [];
  const dropped: ParsedOutput["dropped"] = [];
  top.data.findings.forEach((item, index) => {
    const f = findingSchema.safeParse(item);
    if (!f.success) dropped.push({ index, reason: `malformed: ${f.error.issues[0]?.message ?? "invalid"}` });
    else if (findings.length >= MAX_FINDINGS) dropped.push({ index, reason: `over the ${MAX_FINDINGS}-finding cap` });
    else findings.push(f.data);
  });
  return { findings, resolved: top.data.resolved.slice(0, MAX_FINDINGS), dropped };
}
