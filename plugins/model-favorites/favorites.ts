import { z } from "zod";

export const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const favoriteModelSchema = z.object({
  providerId: z.string(),
  /** The catalog `model` value — what threads.update and spawn accept. */
  model: z.string(),
  modelName: z.string(),
  providerName: z.string(),
  /** Pinned reasoning level; null applies the model's default (or the
      thread's current level when the model supports it). */
  reasoningLevel: reasoningLevelSchema.nullable(),
  createdAt: z.number(),
});
export type FavoriteModel = z.infer<typeof favoriteModelSchema>;

export const catalogModelSchema = z.object({
  model: z.string(),
  displayName: z.string(),
  isDefault: z.boolean(),
  defaultReasoningEffort: reasoningLevelSchema,
  reasoningEfforts: z.array(reasoningLevelSchema),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export const MAX_FAVORITES = 50;

export function isFavorite(
  favorites: readonly FavoriteModel[],
  providerId: string,
  model: string,
): boolean {
  return favorites.some(
    (favorite) =>
      favorite.providerId === providerId && favorite.model === model,
  );
}

/**
 * Toggle a favorite in place of a stored list. Returns the next list and
 * whether the entry is starred afterwards. Throws when the cap is reached.
 */
export function toggleFavorite(
  favorites: readonly FavoriteModel[],
  entry: Omit<FavoriteModel, "createdAt">,
): { favorites: FavoriteModel[]; starred: boolean } {
  const existing = favorites.findIndex(
    (favorite) =>
      favorite.providerId === entry.providerId &&
      favorite.model === entry.model,
  );
  if (existing >= 0) {
    return {
      favorites: favorites.filter((_, index) => index !== existing),
      starred: false,
    };
  }
  if (favorites.length >= MAX_FAVORITES) {
    throw new Error(`Favorite limit reached (${MAX_FAVORITES}).`);
  }
  return {
    favorites: [...favorites, { ...entry, createdAt: Date.now() }],
    starred: true,
  };
}

/**
 * Pick the reasoning level for applying a model: the favorite's pinned level
 * when the model supports it, then the thread's current level, then the
 * catalog default.
 */
export function resolveReasoningLevel(
  entry: Pick<CatalogModel, "defaultReasoningEffort" | "reasoningEfforts">,
  requested: ReasoningLevel | null | undefined,
  current: ReasoningLevel | null | undefined,
): ReasoningLevel {
  // An empty reasoningEfforts list means the catalog declares none — only
  // the entry's own default is safe to send then.
  const supports = (
    level: ReasoningLevel | null | undefined,
  ): level is ReasoningLevel =>
    level !== null &&
    level !== undefined &&
    entry.reasoningEfforts.includes(level);
  if (supports(requested)) return requested;
  if (supports(current)) return current;
  return entry.defaultReasoningEffort;
}
