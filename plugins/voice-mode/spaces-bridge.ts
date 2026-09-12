/** Switch the Threads sidebar between saved spaces of the erwin-activity plugin.
 * Both plugins run in one page. The activity plugin caches its space catalog and
 * keeps this client's selection in local storage; it re-reads that state on a
 * same-window event. Voice lists spaces from the cache, resolves a spoken name,
 * writes the selection, and fires the event. No catalog is fetched here.
 */
import { queryTokens, rank, resolveName, tokenize } from "./target-matching.ts";

/** Keys owned by plugins/activity/lib. A test pins them to the activity plugin's exports. */
export const SPACES_CACHE_KEY = "bb-plugin-erwin-activity:spaces-cache";
export const CLIENT_STATE_KEY = "bb-plugin-erwin-activity:v1";
export const CLIENT_STATE_EVENT = "bb-plugin-erwin-activity:state";
/** Spoken names that mean "no space": the whole thread list. */
const ALL_PROJECTS = ["all", "all projects", "everything", "every project", "no space"];
/** Reserved `spaceId` value for the activity plugin's saved-thread library scope. */
export const LIBRARY_SCOPE_ID = "library";
/** Spoken names for the library scope. A space literally named one of these is shadowed, like "all". */
const LIBRARY = ["library", "the library", "saved", "saved threads"];

export interface Space { id: string; name: string; projectIds: string[] }
export interface SpaceChoice { id: string | null; name: string; projectCount: number | null }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readSpaces(storage: StorageLike): Space[] {
  try {
    const raw = JSON.parse(storage.getItem(SPACES_CACHE_KEY) ?? "null") as { spaces?: unknown } | null;
    if (!raw || !Array.isArray(raw.spaces)) return [];
    return raw.spaces.filter((s): s is Space => !!s && typeof s === "object" && typeof (s as Space).id === "string" && typeof (s as Space).name === "string")
      .map(s => ({ id: s.id, name: s.name, projectIds: Array.isArray(s.projectIds) ? s.projectIds : [] }));
  } catch { return []; }
}
export function readSelectedSpaceId(storage: StorageLike): string | null {
  try { const state = JSON.parse(storage.getItem(CLIENT_STATE_KEY) ?? "null") as { spaceId?: unknown } | null; return typeof state?.spaceId === "string" && state.spaceId ? state.spaceId : null; }
  catch { return null; }
}
/** The name the sidebar shows for the current selection. */
export function currentSpace(storage: StorageLike): SpaceChoice {
  const id = readSelectedSpaceId(storage), space = id ? readSpaces(storage).find(s => s.id === id) : undefined;
  if (space) return { id: space.id, name: space.name, projectCount: space.projectIds.length };
  return id === LIBRARY_SCOPE_ID
    ? { id: LIBRARY_SCOPE_ID, name: "Library", projectCount: null }
    : { id: null, name: "All projects", projectCount: null };
}
/**
 * Resolve a spoken space name. "All projects" and its synonyms clear the space;
 * "the library" and its synonyms select the saved-thread library scope. Otherwise
 * the unique best match wins; a tie or no match returns null with the ranked
 * candidates so the caller can say what exists.
 */
export function resolveSpace(spoken: string, spaces: Space[]): { choice: SpaceChoice | null; candidates: SpaceChoice[] } {
  const words = tokenize(spoken).join(" ");
  if (ALL_PROJECTS.includes(words)) return { choice: { id: null, name: "All projects", projectCount: null }, candidates: [] };
  if (LIBRARY.includes(words)) return { choice: { id: LIBRARY_SCOPE_ID, name: "Library", projectCount: null }, candidates: [] };
  // Category and filler words carry nothing: "the mobile space" is "mobile".
  const meaningful = queryTokens(spoken).join(" ") || spoken;
  const space = resolveName(meaningful, spaces, s => s.name);
  const candidates = rank(spaces, tokenize(meaningful), s => s.name, () => 0, { threshold: 0, limit: 5 }).map(({ item }) => ({ id: item.id, name: item.name, projectCount: item.projectIds.length }));
  return { choice: space ? { id: space.id, name: space.name, projectCount: space.projectIds.length } : null, candidates };
}
/** Write the selection the way the activity plugin does, then tell its store in this window. */
export function applySpace(storage: StorageLike, choice: SpaceChoice, notify: (event: string) => void) {
  let state: Record<string, unknown> = {};
  try { const parsed = JSON.parse(storage.getItem(CLIENT_STATE_KEY) ?? "null"); if (parsed && typeof parsed === "object") state = parsed as Record<string, unknown>; } catch { /* start fresh */ }
  storage.setItem(CLIENT_STATE_KEY, JSON.stringify({ ...state, spaceId: choice.id }));
  notify(CLIENT_STATE_EVENT);
}
