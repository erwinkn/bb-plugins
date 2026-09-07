import { SPACE_NAME_MAX, type Space, type SpaceCatalog } from "./space-contract";

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

export interface ScopeSelection {
  /** A saved space, or null for an ad-hoc or empty selection. */
  spaceId: string | null;
  /** Ad-hoc project selection; ignored while a saved space is selected. */
  projectIds: string[];
}
export type Scope =
  | { kind: "all"; projectIds: null }
  | { kind: "space"; space: Space; projectIds: Set<string> }
  | { kind: "projects"; projectIds: Set<string> };

// A selected space that no longer exists resolves to All projects; the
// caller shows the notice. Ad-hoc selections with no projects mean All.
export function resolveScope(
  catalog: SpaceCatalog,
  selection: ScopeSelection,
): Scope {
  if (selection.spaceId) {
    const space = catalog.spaces.find((s) => s.id === selection.spaceId);
    if (space)
      return { kind: "space", space, projectIds: new Set(space.projectIds) };
  }
  if (selection.projectIds.length)
    return { kind: "projects", projectIds: new Set(selection.projectIds) };
  return { kind: "all", projectIds: null };
}

export function inScope(scope: Scope, projectId: string): boolean {
  return scope.projectIds === null || scope.projectIds.has(projectId);
}

export function scopeLabel(scope: Scope): string {
  switch (scope.kind) {
    case "all":
      return "All projects";
    case "space":
      return scope.space.name;
    case "projects":
      return scope.projectIds.size === 1
        ? "1 project"
        : `${scope.projectIds.size} projects`;
  }
}
