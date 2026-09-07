import { SPACE_NAME_MAX, type Space, type SpaceCatalog } from "./space-schema";

export const EMPTY_CATALOG: SpaceCatalog = { revision: 0, spaces: [] };

export class SpaceValidationError extends Error {}

// Shared by the server boundary and the client forms so both reject the same
// input: blank or duplicate names (case-insensitive), duplicate ids, and
// repeated project ids.
export function normalizeSpaces(spaces: readonly Space[]): Space[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  return spaces.map((space) => {
    const name = space.name.trim();
    if (!name) throw new SpaceValidationError("Space name cannot be empty.");
    if (name.length > SPACE_NAME_MAX)
      throw new SpaceValidationError(
        `Space name cannot exceed ${SPACE_NAME_MAX} characters.`,
      );
    const key = name.toLocaleLowerCase();
    if (names.has(key))
      throw new SpaceValidationError(`A space named "${name}" already exists.`);
    if (ids.has(space.id))
      throw new SpaceValidationError("Space ids must be unique.");
    names.add(key);
    ids.add(space.id);
    return { id: space.id, name, projectIds: [...new Set(space.projectIds)] };
  });
}

export function newSpaceId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `space-${random}`;
}

export interface ScopeProject {
  id: string;
  name: string;
}
export type Scope =
  | { kind: "all"; projectIds: null }
  | { kind: "space"; space: Space; projectIds: Set<string> };

// A selected space that no longer exists resolves to All projects; the
// caller shows the notice.
export function resolveScope(
  catalog: SpaceCatalog,
  spaceId: string | null,
): Scope {
  const space = spaceId
    ? catalog.spaces.find((s) => s.id === spaceId)
    : undefined;
  return space
    ? { kind: "space", space, projectIds: new Set(space.projectIds) }
    : { kind: "all", projectIds: null };
}

export function inScope(scope: Scope, projectId: string): boolean {
  return scope.projectIds === null || scope.projectIds.has(projectId);
}

export function scopeLabel(scope: Scope): string {
  return scope.kind === "all" ? "All projects" : scope.space.name;
}

/** Move the item at `from` to `to`, returning a new array. */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  )
    return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
