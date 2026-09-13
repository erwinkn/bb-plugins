import assert from "node:assert/strict";
import test from "node:test";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { GLYPH_TINTS, ROLE_TINTS, tintDeltaLine, withDevinRowTints } from "./row-tints";

const COLOR = /^oklch\([-+.%\w\s,/]+\)$/u;

function delta(kind: string, glyph: string, extra: Record<string, unknown> = {}) {
  return { kind, key: { itemId: "i1" }, item: { type: "command", command: "ls" },
    presentation: { label: { pending: "Running", completed: "Ran" }, icon: { glyph }, ...extra } };
}
function line(deltas: unknown[]) {
  return JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId: "t", deltas } });
}

test("every tint is a literal color pair BB accepts, one per role", () => {
  for (const tint of Object.values(ROLE_TINTS)) {
    assert.match(tint.light, COLOR); assert.match(tint.dark, COLOR); assert.notEqual(tint.light, tint.dark);
  }
  assert.equal(GLYPH_TINTS.Terminal, ROLE_TINTS.command);
  assert.equal(GLYPH_TINTS.EditFile, ROLE_TINTS.edit);
  assert.equal(GLYPH_TINTS.UserRound, ROLE_TINTS.agent);
  assert.equal(GLYPH_TINTS.Archive, undefined);
});

test("tints open and close deltas by glyph and leaves everything else untouched", () => {
  const out = JSON.parse(tintDeltaLine(line([
    delta("item.open", "Terminal"),
    delta("item.close", "FileText"),
    delta("item.open", "Toolbox"),
    delta("item.open", "EditFile", { tint: { light: "#111", dark: "#eee" } }),
    { kind: "item.progress", key: { itemId: "i1" }, message: "…" },
  ])));
  const [command, read, tool, kept, progress] = out.params.deltas;
  assert.deepEqual(command.presentation.tint, ROLE_TINTS.command);
  assert.deepEqual(read.presentation.tint, ROLE_TINTS.file);
  assert.equal(tool.presentation.tint, undefined);
  assert.deepEqual(kept.presentation.tint, { light: "#111", dark: "#eee" });
  assert.equal(progress.presentation, undefined);
  assert.equal(command.presentation.label.pending, "Running");

  const other = JSON.stringify({ jsonrpc: "2.0", method: "thread/identity", params: { presentation: { icon: { glyph: "Terminal" } } } });
  assert.equal(tintDeltaLine(other), other);
  assert.equal(tintDeltaLine("not json thread/delta \"presentation\""), "not json thread/delta \"presentation\"");
  assert.equal(tintDeltaLine(line([delta("item.open", "Toolbox")])), line([delta("item.open", "Toolbox")]));
});

test("the wrapper decorates stdout from start until close and keeps the prior writer", () => {
  const seen: string[] = [];
  const original = process.stdout.write;
  const sink = ((chunk: unknown) => { seen.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stdout.write = sink;
  try {
    const calls: string[] = [];
    const inner = experimental_defineProviderBridge({
      start: () => { calls.push("start"); },
      handleLine: (received) => { calls.push(received); },
      onClose: () => { calls.push("close"); },
    });
    const bridge = withDevinRowTints(inner);
    process.stdout.write(`${line([delta("item.open", "Terminal")])}\n`);
    assert.equal(JSON.parse(seen[0]!).params.deltas[0].presentation.tint, undefined);
    bridge.start?.({ pluginId: "devin", dataDir: "/tmp/x", tempDir: "/tmp/y" });
    bridge.handleLine("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"noop\"}");
    process.stdout.write(`${line([delta("item.open", "Terminal")])}\n`);
    process.stdout.write("plain text\n");
    assert.deepEqual(JSON.parse(seen[1]!).params.deltas[0].presentation.tint, ROLE_TINTS.command);
    assert.ok(seen[1]!.endsWith("\n"));
    assert.equal(seen[2], "plain text\n");
    bridge.onClose?.();
    assert.equal(process.stdout.write, sink);
    process.stdout.write(`${line([delta("item.open", "Terminal")])}\n`);
    assert.equal(JSON.parse(seen[3]!).params.deltas[0].presentation.tint, undefined);
    assert.deepEqual(calls, ["start", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"noop\"}", "close"]);
  } finally {
    process.stdout.write = original;
  }
});
