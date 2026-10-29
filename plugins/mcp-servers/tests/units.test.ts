import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { bbToolNames, MAX_TOOL_NAME, suggestPrefix } from "../src/names";
import { normalizeInputSchema } from "../src/schema";
import { MAX_TEXT_TOTAL_BYTES, toBbResult } from "../src/results";
import { computeSurface, splitText } from "../src/surface";
import type { ServerConfig } from "../src/store";

describe("names", () => {
  it("prefixes, keeps BB's character set and stays within 48 characters", () => {
    const names = bbToolNames("linear", ["create_issue", "files/read", "a".repeat(80), "a.b", "a_b"]);
    expect(names.get("create_issue")).toBe("linear_create_issue");
    expect(names.get("files/read")).toBe("linear_files_read");
    const long = names.get("a".repeat(80))!;
    expect(long.length).toBe(MAX_TOOL_NAME);
    expect(long).toMatch(/^linear_a+_[0-9a-f]{6}$/);
    // "a.b" and "a_b" both sanitize to linear_a_b: both get a hash, and differ.
    expect(names.get("a.b")).not.toBe(names.get("a_b"));
    expect(names.get("a.b")).toMatch(/^linear_a_b_[0-9a-f]{6}$/);
    for (const name of names.values()) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,48}$/);
  });

  it("never gives two tools one name, even against a plain name shaped like a hash", () => {
    const first = bbToolNames("s", ["a.b", "a_b"]);
    const clash = first.get("a.b")!.slice(2); // "a_b_<hash>", a legal upstream name
    const names = bbToolNames("s", ["a.b", "a_b", clash]);
    expect(new Set(names.values()).size).toBe(3);
    expect(names.get(clash)).toBe(`s_${clash}`);
  });

  it("suggests a prefix from a display name", () => {
    expect(suggestPrefix("Linear (work)")).toBe("linear-work");
    expect(suggestPrefix("Ünïcode Docs")).toBe("unicode-docs");
    expect(suggestPrefix("!!!")).toBe("mcp");
  });
});

describe("schema", () => {
  it("passes a plain schema through verbatim", () => {
    const schema = { type: "object", properties: { q: { type: "string", minLength: 1 } }, required: ["q"], additionalProperties: false, $schema: "https://json-schema.org/draft/2020-12/schema" };
    expect(normalizeInputSchema(schema)).toEqual({ schema, changes: [] });
  });

  it("adds a missing root type", () => {
    expect(normalizeInputSchema({ properties: {} })).toEqual({ schema: { properties: {}, type: "object" }, changes: ['root type "object" added'] });
  });

  it("breaks recursive $ref so BB accepts the schema, and only those", () => {
    const schema = {
      type: "object",
      properties: { root: { $ref: "#/$defs/node" }, other: { $ref: "#/$defs/leaf" } },
      $defs: {
        node: { type: "object", properties: { next: { $ref: "#/$defs/node" }, leaf: { $ref: "#/$defs/leaf" } } },
        leaf: { type: "string" },
        self: { anyOf: [{ $ref: "#" }] },
      },
    };
    const { bb } = createFakePluginHost({ pluginId: "schema-check" });
    const register = (name: string, parameters: Record<string, unknown>) =>
      bb.agents.registerTool({ name, description: "x", parameters, execute: () => "ok" });
    expect(() => register("raw", schema)).toThrow(/recursive/);
    const { schema: fixed, changes } = normalizeInputSchema(schema);
    expect(() => register("fixed", fixed)).not.toThrow();
    expect(changes).toEqual(['recursive $ref "#/$defs/node" dropped', 'recursive $ref "#" dropped']);
    const defs = fixed.$defs as Record<string, Record<string, unknown>>;
    expect((defs.node!.properties as Record<string, unknown>).leaf).toEqual({ $ref: "#/$defs/leaf" });
    expect(fixed.properties).toEqual(schema.properties);
  });
});

describe("schema cycles closed by containment", () => {
  it("drops a ref on a cycle that re-enters through a parent", () => {
    // root → (ref) B; B → (ref) A; A contains B.
    const schema = {
      type: "object",
      properties: { x: { $ref: "#/$defs/A/properties/B" } },
      $defs: { A: { type: "object", properties: { B: { type: "object", properties: { up: { $ref: "#/$defs/A" } } } } } },
    };
    const { bb } = createFakePluginHost({ pluginId: "schema-cycle" });
    const register = (name: string, parameters: Record<string, unknown>) =>
      bb.agents.registerTool({ name, description: "x", parameters, execute: () => "ok" });
    expect(() => register("raw", schema)).toThrow(/recursive/);
    const { schema: fixed, changes } = normalizeInputSchema(schema);
    expect(changes).toEqual(['recursive $ref "#/$defs/A" dropped']);
    expect(() => register("fixed", fixed)).not.toThrow();
    expect((fixed.properties as Record<string, unknown>).x).toEqual({ $ref: "#/$defs/A/properties/B" });
  });
});

describe("results", () => {
  it("maps every MCP content type", () => {
    const result = toBbResult({
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "audio", data: "aGk=", mimeType: "audio/wav" },
        { type: "resource_link", uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain", description: "A file" },
        { type: "resource", resource: { uri: "file:///b.md", mimeType: "text/markdown", text: "# B" } },
        { type: "resource", resource: { uri: "file:///c.png", mimeType: "image/png", blob: "aGk=" } },
        { type: "resource", resource: { uri: "file:///d.bin", mimeType: "application/octet-stream", blob: "aGVsbG8=" } },
      ],
      isError: true,
    });
    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "[audio: audio/wav, 3 bytes, not shown: BB tools return text and images]" },
        { type: "text", text: "[resource link] a.txt: file:///a.txt (text/plain) — A file" },
        { type: "text", text: "[resource file:///b.md (text/markdown)]\n# B" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "[resource file:///d.bin (application/octet-stream): 6 bytes of binary data, not shown]" },
      ],
    });
  });

  it("adds structuredContent only when no text part mirrors it", () => {
    const structured = { a: 1, b: [2] };
    expect(toBbResult({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured })).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(structured) }] });
    expect(toBbResult({ content: [], structuredContent: structured })).toEqual({
      isError: false,
      content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    });
  });

  it("caps text and says so", () => {
    const result = toBbResult({ content: [1, 2, 3].map(() => ({ type: "text", text: "x".repeat(120 * 1024) })) });
    const parts = typeof result === "string" ? [] : result.content;
    const bytes = parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_TEXT_TOTAL_BYTES + 200);
    expect(parts.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("truncated") });
  });

  it("does not split a UTF-8 character", () => {
    const result = toBbResult({ content: [{ type: "text", text: "é".repeat(80 * 1024) }] });
    const text = typeof result === "string" ? result : (result.content[0] as { text: string }).text;
    expect(text).not.toContain("�");
  });
});

describe("surface", () => {
  const server = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
    id: "s",
    name: "S",
    prefix: "s",
    url: "https://s.example/mcp",
    enabled: true,
    auth: { kind: "none" },
    createdAt: 0,
    cache: {
      transport: "streamable-http",
      fetchedAt: 0,
      tools: [{ name: "only", inputSchema: { type: "object" } }],
      instructions: "word ".repeat(3000),
    },
    ...overrides,
  });

  it("splits text at word boundaries within the limit", () => {
    const pieces = splitText("alpha beta gamma delta", 11);
    expect(pieces).toEqual(["alpha beta", "gamma delta"]);
    expect(splitText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("puts instructions that outgrow the tools into the last description", () => {
    const { tools } = computeSurface([server()]);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.instructions!.length).toBeLessThanOrEqual(4096);
    expect(tools[0]!.description).toMatch(/^only \(S\)\n\nInstructions from the MCP server "S", continued:\n\nword/);
  });

  it("leaves disabled servers out and changes signature with the surface", () => {
    const a = computeSurface([server()]);
    expect(computeSurface([server({ enabled: false })]).tools).toEqual([]);
    expect(computeSurface([server()]).signature).toBe(a.signature);
    expect(computeSurface([server({ prefix: "t" })]).signature).not.toBe(a.signature);
  });
});
