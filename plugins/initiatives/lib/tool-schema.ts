import { z } from "zod";

type JsonSchema = Record<string, unknown> & { properties?: Record<string, JsonSchema>; required?: string[]; description?: string };

/**
 * Claude's bridge advertises only object roots and blanks a top-level union, so a
 * discriminated command union publishes as one object: the action enum plus every
 * action's fields, each with its real nested schema (anyOf only where actions
 * disagree). It is only what agents see; the strict union still validates.
 */
export function objectRootSchema(options: readonly z.ZodType[]): JsonSchema {
  const variants = options.map(option => z.toJSONSchema(option, { io: "input" }) as JsonSchema);
  const actionOf = (variant: JsonSchema) => String(variant.properties!.action!.const);
  const fields = new Map<string, { actions: string[]; schemas: Map<string, JsonSchema> }>();
  for (const variant of variants) for (const [key, schema] of Object.entries(variant.properties!)) {
    if (key === "action") continue;
    const field = fields.get(key) ?? { actions: [] as string[], schemas: new Map<string, JsonSchema>() };
    field.actions.push(actionOf(variant));
    field.schemas.set(JSON.stringify(schema), schema);
    fields.set(key, field);
  }
  const usage = variants.map(variant => {
    const required = (variant.required ?? []).filter(key => key !== "action");
    return required.length ? `${actionOf(variant)} (requires ${required.join(", ")})` : actionOf(variant);
  });
  const properties: Record<string, JsonSchema> = {
    action: { type: "string", enum: variants.map(actionOf), description: `Actions: ${usage.join("; ")}. Other fields are optional and accepted only by the actions listed on them.` },
  };
  for (const [key, { actions, schemas }] of fields) {
    const [only, ...rest] = [...schemas.values()];
    const schema: JsonSchema = rest.length ? { anyOf: [only!, ...rest] } : { ...only! };
    const used = actions.length === variants.length ? "" : `For ${actions.join(", ")}.`;
    if (used) schema.description = schema.description ? `${schema.description} ${used}` : used;
    properties[key] = schema;
  }
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, required: ["action"], additionalProperties: false };
}
