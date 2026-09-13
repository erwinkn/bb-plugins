import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderBridgeEntry } from "@get-bb/plugin-sdk/provider-bridge";
import { ROLE_TINTS, type Tint } from "./role-tints";

export { ROLE_TINTS, type Tint };

// Devin's timeline rows come from the shared ACP bridge, which sets each row's
// glyph but no `presentation.tint`, and offers no hook for one. The bridge
// writes every `thread/delta` notification to stdout as one JSON line, so this
// wrapper decorates those lines on the way out: a row whose glyph names a role
// (file, command, web, edit, agent, ...) gets that role's hue, light and dark.
// The pairs are the ones the theme plugin's palette uses (`--bbp-*`); BB only
// accepts literal colors here (`#hex` or a color function), never `var()`.

/**
 * Glyph → tint, mirroring the glyphs the ACP bridge assigns (its
 * KIND_PRESENTATIONS map plus the bridge kit's read, search, fetch, plan and
 * delegation presentations). Unlisted glyphs (Archive, Toolbox) stay neutral.
 */
export const GLYPH_TINTS: Readonly<Record<string, Tint>> = {
  FileText: ROLE_TINTS.file,
  FolderOpen: ROLE_TINTS.file,
  FolderEdit: ROLE_TINTS.file,
  Search: ROLE_TINTS.file,
  Terminal: ROLE_TINTS.command,
  Globe: ROLE_TINTS.web,
  Browser: ROLE_TINTS.web,
  EditFile: ROLE_TINTS.edit,
  Trash2: ROLE_TINTS.error,
  ListTodo: ROLE_TINTS.attention,
  SlidersHorizontal: ROLE_TINTS.attention,
  UserRound: ROLE_TINTS.agent,
  Brain: ROLE_TINTS.thinking,
};

const DELTA_METHOD = "thread/delta";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Adds a tint to every delta presentation whose glyph has one; returns whether anything changed. */
function tintDeltas(deltas: unknown, glyphTints: Readonly<Record<string, Tint>>): boolean {
  if (!Array.isArray(deltas)) return false;
  let changed = false;
  for (const delta of deltas) {
    if (!isRecord(delta) || !isRecord(delta.presentation) || delta.presentation.tint !== undefined) continue;
    const icon = delta.presentation.icon;
    const tint = isRecord(icon) && typeof icon.glyph === "string" ? glyphTints[icon.glyph] : undefined;
    if (tint === undefined) continue;
    delta.presentation.tint = { ...tint };
    changed = true;
  }
  return changed;
}

/** One stdout line; anything that is not a delta notification passes through byte for byte. */
export function tintDeltaLine(line: string, glyphTints: Readonly<Record<string, Tint>> = GLYPH_TINTS): string {
  if (!line.includes(DELTA_METHOD) || !line.includes('"presentation"')) return line;
  let message: unknown;
  try { message = JSON.parse(line); } catch { return line; }
  if (!isRecord(message) || message.method !== DELTA_METHOD || !isRecord(message.params)) return line;
  return tintDeltas(message.params.deltas, glyphTints) ? JSON.stringify(message) : line;
}

function tintChunk(chunk: unknown, glyphTints: Readonly<Record<string, Tint>>): unknown {
  if (typeof chunk !== "string" || !chunk.includes(DELTA_METHOD)) return chunk;
  // The bridge writes one message per call, newline-terminated; be safe about several.
  return chunk.split("\n").map((line) => (line === "" ? line : tintDeltaLine(line, glyphTints))).join("\n");
}

/**
 * Installs the stdout decorator when the bridge starts and removes it when the
 * bridge closes. Whatever `process.stdout.write` was at start (the real
 * stream, or a test capture) stays the destination.
 */
export function withDevinRowTints(acp: ProviderBridgeEntry, glyphTints: Readonly<Record<string, Tint>> = GLYPH_TINTS): ProviderBridgeEntry {
  let uninstall: (() => void) | undefined;
  function install() {
    if (uninstall !== undefined) return;
    const stdout = process.stdout;
    const downstream = stdout.write;
    const decorated = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      return Reflect.apply(downstream, this ?? stdout, [tintChunk(chunk, glyphTints), ...rest]) as boolean;
    } as typeof stdout.write;
    stdout.write = decorated;
    uninstall = () => {
      if (stdout.write === decorated) stdout.write = downstream;
      uninstall = undefined;
    };
  }
  return experimental_defineProviderBridge({
    start(context) { install(); return acp.start?.(context); },
    handleLine: (line) => acp.handleLine(line),
    onClose() { uninstall?.(); return acp.onClose?.(); },
    onSigterm: acp.onSigterm,
    onSigint: acp.onSigint,
  });
}
