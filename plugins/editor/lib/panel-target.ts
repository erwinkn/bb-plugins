/**
 * Per-tab workspace targeting.
 *
 * A Files or Changes panel tab stores its inspected thread in its persisted
 * params (`{targetThreadId: "thr_…"}`). The picker rewrites the tab's
 * `paramsJson` through `threads.tabs.update` so a reload restores the same
 * target; matching the tab to rewrite needs a canonical JSON compare, kept
 * here where it can be tested.
 */

/** BB ids are `<prefix>_<alphanumerics>`; anything else is not a thread id. */
const BB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The panel params the editor writes; other keys pass through untouched. */
export function targetThreadParam(params: unknown): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const target = (params as { targetThreadId?: unknown }).targetThreadId;
  return typeof target === "string" && BB_ID.test(target) ? target : null;
}

/**
 * Params that name a place inside a workspace: the open file, a scroll or
 * line position, the comparison the Changes tab is running. They belong to
 * the workspace they were taken in — another workspace's identical relative
 * path is a different file — so a target change drops them rather than
 * carrying a remembered path into a workspace it never described.
 */
const TARGET_OWNED_PARAMS = new Set(["path", "lineRange", "target"]);

/**
 * `params` with the target replaced. A target equal to the panel's own thread
 * is stored as its absence, so the default tab keeps the params it had.
 * Target-owned params survive only when the params already describe the
 * target being written.
 */
export function paramsWithTarget(params: unknown, ownThreadId: string, targetThreadId: string): unknown {
  const base =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? { ...(params as Record<string, unknown>) }
      : {};
  const boundTarget = targetThreadParam(base) ?? ownThreadId;
  if (boundTarget !== targetThreadId) for (const key of TARGET_OWNED_PARAMS) delete base[key];
  if (targetThreadId === ownThreadId) delete base.targetThreadId;
  else base.targetThreadId = targetThreadId;
  return Object.keys(base).length === 0 ? null : base;
}

/** Structural equality on JSON values, insensitive to key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]))
    );
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** The fields of a `threads.tabs` row the matcher reads. */
export interface PanelTabRow {
  id: string;
  kind: string;
  pluginId?: string;
  actionId?: string;
  paramsJson?: string | null;
}

/** Distinguishes "no params" vs. unreadable params. */
const INVALID_PARAMS = Symbol("invalid-params-json");

function parseParamsJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return INVALID_PARAMS;
  }
}

/**
 * The panel tab this component instance renders. `openPanel` refuses to open
 * a second tab of one action with identical params, so (plugin, action,
 * params) identifies a tab. Returns the matching row, a marker for ambiguity,
 * or null when no tab carries these params (e.g. a stale rewrite already
 * landed).
 */
export function findPanelTab(
  tabs: readonly PanelTabRow[],
  options: { pluginId: string; actionId: string; params: unknown },
): PanelTabRow | "ambiguous" | "unreadable" | null {
  let found: PanelTabRow | null = null;
  let count = 0;
  let unreadable = false;
  for (const tab of tabs) {
    if (tab.kind !== "plugin-panel" || tab.pluginId !== options.pluginId || tab.actionId !== options.actionId) continue;
    const params = parseParamsJson(tab.paramsJson);
    // A corrupt paramsJson could be this very tab; rewriting a sibling that
    // happens to match would not be provably safe, so it blocks the rewrite.
    if (params === INVALID_PARAMS) {
      unreadable = true;
      continue;
    }
    if (!sameJson(params, options.params)) continue;
    found = tab;
    count += 1;
  }
  if (unreadable) return "unreadable";
  if (count === 0) return null;
  return count === 1 ? found : "ambiguous";
}

/**
 * The params the panel's tab actually carries, when exactly one tab of this
 * plugin and action exists and its params parse. A declined rewrite reports
 * it so the panel can chain its next write from the tab's real state rather
 * than declining on a stale expected forever.
 */
export function solePanelTabParams(
  tabs: readonly PanelTabRow[],
  options: { pluginId: string; actionId: string },
): { found: true; params: unknown } | { found: false } {
  let found: PanelTabRow | null = null;
  let count = 0;
  for (const tab of tabs) {
    if (tab.kind !== "plugin-panel" || tab.pluginId !== options.pluginId || tab.actionId !== options.actionId) continue;
    found = tab;
    count += 1;
  }
  if (count !== 1 || found === null) return { found: false };
  const params = parseParamsJson(found.paramsJson);
  if (params === INVALID_PARAMS) return { found: false };
  return { found: true, params };
}
