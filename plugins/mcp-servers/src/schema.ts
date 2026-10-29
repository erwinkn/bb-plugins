// An upstream tool's input schema, as BB will take it. The schema passes
// through verbatim except for the two things BB refuses at registration:
//
//   1. a root that is not `{ type: "object", ... }` (MCP requires one; a few
//      servers omit `type`), and
//   2. a recursive local `$ref` (some providers reject the whole tool list
//      over one). Each `$ref` that closes a cycle is dropped and its node
//      says so in `description`; the server still validates the arguments.
//
// The traversal mirrors BB's own check (plugin-sdk host-policy
// assertNoRecursiveJsonSchemaReferences), so what passes here passes there.

type JsonObject = Record<string, unknown>;

const SINGLE = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const MAPS = ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"] as const;
const REFS = ["$ref", "$recursiveRef", "$dynamicRef"] as const;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function children(schema: JsonObject, visit: (child: unknown) => void): void {
  for (const keyword of SINGLE) {
    const child = schema[keyword];
    if (Array.isArray(child)) child.forEach(visit);
    else visit(child);
  }
  for (const keyword of ARRAYS) {
    const list = schema[keyword];
    if (Array.isArray(list)) list.forEach(visit);
  }
  for (const keyword of MAPS) {
    const map = schema[keyword];
    if (isObject(map)) Object.values(map).forEach(visit);
  }
  if (isObject(schema.dependencies))
    for (const dependency of Object.values(schema.dependencies))
      if (!Array.isArray(dependency)) visit(dependency);
}

function resolve(document: JsonObject, anchors: Map<string, JsonObject>, reference: string): unknown {
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return anchors.get(pointer);
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isObject(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

type RefEdge = { owner: JsonObject; keyword: (typeof REFS)[number] };

/**
 * The ref that closes the first cycle in a depth-first walk of `schema`, or
 * null. The walk follows containment and local refs and mirrors BB's
 * assertNoRecursiveJsonSchemaReferences, so "no cycle" here is "accepted"
 * there.
 */
function findCycle(schema: JsonObject, anchors: Map<string, JsonObject>): RefEdge | null {
  // The path from the root: each entry is a node and the ref that led to
  // it (null when reached by containment).
  const path: Array<{ node: object; via: RefEdge | null }> = [];
  const onPath = new Set<object>();
  const done = new Set<object>();
  let found: RefEdge | null = null;
  const visit = (node: unknown, via: RefEdge | null): void => {
    if (found || !isObject(node) || done.has(node)) return;
    if (onPath.has(node)) {
      // The cycle is the path from `node` to here plus this edge; drop the
      // most recent ref on it.
      if (via) found = via;
      else {
        // The edge into `node` itself lies before the cycle, so stop there.
        for (let i = path.length - 1; i >= 0 && path[i]!.node !== node && !found; i -= 1) found = path[i]!.via;
      }
      return;
    }
    path.push({ node, via });
    onPath.add(node);
    for (const keyword of REFS) {
      const reference = node[keyword];
      if (typeof reference === "string" && reference.startsWith("#")) visit(resolve(schema, anchors, reference), { owner: node, keyword });
      if (found) return;
    }
    children(node, (child) => visit(child, null));
    if (found) return;
    path.pop();
    onPath.delete(node);
    done.add(node);
  };
  visit(schema, null);
  return found;
}

export interface NormalizedSchema {
  schema: JsonObject;
  /** What was changed, for the server's status (empty when verbatim). */
  changes: string[];
}

export function normalizeInputSchema(input: unknown): NormalizedSchema {
  const changes: string[] = [];
  let schema: JsonObject;
  if (isObject(input)) {
    schema = JSON.parse(JSON.stringify(input)) as JsonObject;
  } else {
    schema = {};
    changes.push("input schema missing; accepts any object");
  }
  if (schema.type !== "object") {
    if (schema.type !== undefined) changes.push(`root type ${JSON.stringify(schema.type)} replaced by "object"`);
    else if (isObject(input)) changes.push('root type "object" added');
    schema.type = "object";
  }

  const anchors = new Map<string, JsonObject>();
  const indexed = new Set<object>();
  const index = (node: unknown): void => {
    if (!isObject(node) || indexed.has(node)) return;
    indexed.add(node);
    for (const keyword of ["$anchor", "$dynamicAnchor"] as const)
      if (typeof node[keyword] === "string") anchors.set(node[keyword] as string, node);
    for (const keyword of ["$id", "id"] as const) {
      const id = node[keyword];
      if (typeof id === "string" && /^#[^/]+$/.test(id)) anchors.set(id.slice(1), node);
    }
    children(node, index);
  };
  index(schema);

  // Each pass finds one cycle the way BB's check walks (containment edges
  // and local refs), and drops the ref on it nearest the point where it
  // closed. Every cycle holds at least one ref (containment alone is a
  // tree), so each pass removes one and the loop ends.
  for (;;) {
    const edge = findCycle(schema, anchors);
    if (!edge) break;
    const reference = edge.owner[edge.keyword] as string;
    delete edge.owner[edge.keyword];
    const note = `(Recursive: same shape as ${reference}.)`;
    edge.owner.description = typeof edge.owner.description === "string" ? `${edge.owner.description} ${note}` : note;
    changes.push(`recursive ${edge.keyword} ${JSON.stringify(reference)} dropped`);
  }
  return { schema, changes };
}
