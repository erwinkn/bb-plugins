/**
 * State for the Changes tab that does not need React: what is compared, how
 * the comparison is shown, which file is selected, and the wording of all of
 * it. Panel parameters and stored values are untrusted, so everything that
 * enters from outside passes through a parser here.
 */
import type { FileSessionSnapshot } from "./file-session.js";
import type { DiffEntry, DiffTarget } from "./diff-contract.js";
import { DEFAULT_TREE_WIDTH, MIN_TREE_WIDTH } from "./layout-storage.js";

export type DiffScope = DiffTarget["type"];

/** Below this the split view has too little room per side, so it shows unified. */
export const SPLIT_MIN_WIDTH_PX = 560;
/** Below this the list and the comparison take turns instead of sharing the row. */
const COMPACT_BREAKPOINT_PX = 620;

const COMMIT_PATTERN = /^[a-fA-F0-9]{7,40}$/;
/** Matches the reference rule the server applies, so bad input never leaves the client. */
const BAD_REF = /^-|[\0\r\n]/;

export function isCommitHash(value: string): boolean {
  return COMMIT_PATTERN.test(value.trim());
}

export function isBranchRef(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !BAD_REF.test(trimmed);
}

export const DEFAULT_TARGET: DiffTarget = { type: "uncommitted" };

/** A `DiffTarget` from any value: panel parameters, stored text, a link. */
export function parseTarget(value: unknown): DiffTarget | null {
  if (typeof value === "string") return parseTargetKey(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "uncommitted") return { type: "uncommitted" };
  if (type === "commit") {
    const sha = typeof record.sha === "string" ? record.sha.trim() : "";
    return isCommitHash(sha) ? { type: "commit", sha } : null;
  }
  if (type !== "all" && type !== "branch_committed") return null;
  const branch = record.mergeBaseBranch;
  if (branch === undefined || branch === null || branch === "") return { type };
  if (typeof branch !== "string" || !isBranchRef(branch)) return null;
  return { type, mergeBaseBranch: branch.trim() };
}

/** The `{ target, path }` a panel action or a link can carry. */
export function parseDiffParams(params: unknown): { target: DiffTarget | null; path: string | null } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return { target: null, path: null };
  const record = params as Record<string, unknown>;
  const path = typeof record.path === "string" && record.path !== "" ? record.path : null;
  return { target: parseTarget(record.target), path };
}

/** A stable one-line form of a target, for storage keys and for identity checks. */
export function targetKey(target: DiffTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "uncommitted";
    case "commit":
      return `commit:${target.sha}`;
    default:
      return `${target.type}:${target.mergeBaseBranch ?? ""}`;
  }
}

export function parseTargetKey(key: string): DiffTarget | null {
  const separator = key.indexOf(":");
  const type = separator === -1 ? key : key.slice(0, separator);
  const rest = separator === -1 ? "" : key.slice(separator + 1);
  if (type === "uncommitted") return { type: "uncommitted" };
  if (type === "commit") return isCommitHash(rest) ? { type: "commit", sha: rest.trim() } : null;
  if (type !== "all" && type !== "branch_committed") return null;
  if (rest === "") return { type };
  return isBranchRef(rest) ? { type, mergeBaseBranch: rest.trim() } : null;
}

export function sameTarget(a: DiffTarget, b: DiffTarget): boolean {
  return targetKey(a) === targetKey(b);
}

/** The branch a target compares with: its own, else the workspace's. */
export function comparisonBranch(target: DiffTarget, baseBranch: string | null): string | null {
  if (target.type !== "all" && target.type !== "branch_committed") return null;
  return target.mergeBaseBranch ?? baseBranch;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export interface TargetWording {
  /** The name of the comparison, short enough for the header button. */
  label: string;
  /** What the comparison holds, for the menu and the button's tooltip. */
  detail: string;
}

export function describeTarget(target: DiffTarget, baseBranch: string | null): TargetWording {
  const branch = comparisonBranch(target, baseBranch);
  const against = branch === null ? "the base branch" : branch;
  switch (target.type) {
    case "uncommitted":
      return { label: "Uncommitted", detail: "Everything you changed since the last commit" };
    case "all":
      return { label: "All changes", detail: `Commits and uncommitted changes, compared with ${against}` };
    case "branch_committed":
      return { label: "All commits", detail: `Only the commits on this branch, compared with ${against}` };
    case "commit":
      return { label: shortSha(target.sha), detail: `The one commit ${shortSha(target.sha)}` };
  }
}

/** A target that needs a branch, without one to use, cannot be listed. */
export function needsBranch(target: DiffTarget, baseBranch: string | null): boolean {
  if (target.type !== "all" && target.type !== "branch_committed") return false;
  return comparisonBranch(target, baseBranch) === null;
}

export interface ChangeSummary {
  files: number;
  additions: number;
  deletions: number;
}

export function summarize(files: readonly DiffEntry[]): ChangeSummary {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += Number.isFinite(file.additions) ? file.additions : 0;
    deletions += Number.isFinite(file.deletions) ? file.deletions : 0;
  }
  return { files: files.length, additions, deletions };
}

/** What happened to a file, in the words the change list shows. */
export function changeLabel(entry: DiffEntry): string {
  if (entry.origin === "untracked") return "New file";
  switch (entry.changeKind) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "type_changed":
      return "Type changed";
    default:
      return "Changed";
  }
}

/** Why a file cannot open in the comparison, before the read is even tried. */
export function unavailableReason(entry: DiffEntry): string | null {
  if (entry.binary) return "This file is not text, so it has no line comparison.";
  if (entry.loadMode === "too_large") return "This file is too large to compare.";
  if (entry.changeKind === "type_changed") return "The file type changed, so there is no line comparison.";
  return null;
}

export function canCompare(entry: DiffEntry): boolean {
  return unavailableReason(entry) === null;
}

export function findEntry(files: readonly DiffEntry[], path: string | null): DiffEntry | null {
  if (path === null) return null;
  return files.find((file) => file.path === path) ?? null;
}

/**
 * The file to show after a list arrives: the one already open when it is
 * still there, else the file nearest to where it was, else the first one that
 * can be compared. `previous` keeps the order the earlier list had, so a file
 * that disappears hands over to its neighbour instead of to the top.
 */
export function selectionAfterRefresh(
  files: readonly DiffEntry[],
  selected: string | null,
  previous: readonly DiffEntry[] = [],
  savedPath: string | null = null,
): string | null {
  // Saving back to the baseline may remove the file from Git's list. Keep
  // the active editor open; explicit refresh still reconciles selection.
  if (selected !== null && selected === savedPath) return selected;
  if (files.length === 0) return null;
  if (selected !== null && files.some((file) => file.path === selected)) return selected;
  const wasAt = previous.findIndex((file) => file.path === selected);
  if (wasAt !== -1) {
    for (let step = 1; step < previous.length; step++) {
      for (const index of [wasAt + step, wasAt - step]) {
        const path = previous[index]?.path;
        if (path !== undefined && files.some((file) => file.path === path)) return path;
      }
    }
  }
  return (files.find(canCompare) ?? files[0])?.path ?? null;
}

/** The next or previous file in the list, skipping files with no comparison. */
export function neighbourPath(files: readonly DiffEntry[], path: string | null, step: 1 | -1): string | null {
  const comparable = files.filter(canCompare);
  if (comparable.length === 0) return null;
  const index = comparable.findIndex((file) => file.path === path);
  if (index === -1) return (step === 1 ? comparable[0] : comparable[comparable.length - 1])?.path ?? null;
  return comparable[index + step]?.path ?? null;
}

export type DiffLayout = "split" | "unified";

/**
 * What only the Changes tab has. Word wrap and line numbers are plugin
 * settings instead, so the two tabs show a file the same way.
 */
export interface DiffViewPrefs {
  layout: DiffLayout;
  expandUnchanged: boolean;
  listOpen: boolean;
  listWidth: number;
}

export const DEFAULT_VIEW_PREFS: DiffViewPrefs = {
  layout: "unified",
  expandUnchanged: false,
  listOpen: true,
  listWidth: DEFAULT_TREE_WIDTH,
};

/** Split needs room for two columns; a narrow pane shows unified instead. */
export function effectiveLayout(preferred: DiffLayout, width: number): DiffLayout {
  if (preferred === "unified") return "unified";
  return width > 0 && width < SPLIT_MIN_WIDTH_PX ? "unified" : "split";
}

export function isCompact(width: number): boolean {
  return width > 0 && width < COMPACT_BREAKPOINT_PX;
}

const PREFIX = "bb-plugin-erwin-editor:diff:";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {}
}

/** Stored view preferences, with anything unreadable falling back to the default. */
export function readViewPrefs(): DiffViewPrefs {
  const raw = read("view");
  if (raw === null) return DEFAULT_VIEW_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
  return viewPrefsFrom(parsed);
}

export function viewPrefsFrom(value: unknown): DiffViewPrefs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_VIEW_PREFS;
  const record = value as Record<string, unknown>;
  const bool = (key: "expandUnchanged" | "listOpen") =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : DEFAULT_VIEW_PREFS[key];
  const width = Number(record.listWidth);
  return {
    layout: record.layout === "split" ? "split" : "unified",
    expandUnchanged: bool("expandUnchanged"),
    listOpen: bool("listOpen"),
    listWidth: Number.isFinite(width) && width > 0 ? Math.max(Math.round(width), MIN_TREE_WIDTH) : DEFAULT_VIEW_PREFS.listWidth,
  };
}

export function storeViewPrefs(prefs: DiffViewPrefs): void {
  write("view", JSON.stringify(prefs));
}

/** The comparison a workspace showed last, so the tab opens where it was. */
export function readLastTarget(workspaceKey: string): DiffTarget | null {
  const raw = read(`target:${workspaceKey}`);
  return raw === null ? null : parseTargetKey(raw);
}

export function storeLastTarget(workspaceKey: string, target: DiffTarget): void {
  write(`target:${workspaceKey}`, targetKey(target));
}

/** The file a comparison showed last. Each comparison remembers its own. */
export function readLastPath(workspaceKey: string, target: DiffTarget): string | null {
  return read(`path:${workspaceKey}:${targetKey(target)}`);
}

export function storeLastPath(workspaceKey: string, target: DiffTarget, path: string | null): void {
  write(`path:${workspaceKey}:${targetKey(target)}`, path);
}

/** A saved hash is an acknowledgement; an external read needs a new comparison. */
export function diffSessionSync(
  comparisonHash: string | null,
  state: Pick<FileSessionSnapshot, "load" | "hasEdits" | "sha256" | "savedContentSource">,
): "none" | "saved" | "read" {
  if (state.load.kind !== "ready" || state.hasEdits || comparisonHash === null || state.sha256 === null || comparisonHash === state.sha256) return "none";
  return state.savedContentSource === "write" ? "saved" : "read";
}
