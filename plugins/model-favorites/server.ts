import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  catalogModelSchema,
  favoriteModelSchema,
  isFavorite,
  reasoningLevelSchema,
  resolveReasoningLevel,
  toggleFavorite,
  type CatalogModel,
  type FavoriteModel,
} from "./favorites.js";

const FAVORITES_KEY = "favorites";
const FAVORITES_CHANGED = "favorites-changed";

export const rpcContract = defineRpcContract({
  favorites_list: {
    input: z.null(),
    output: z.object({ favorites: z.array(favoriteModelSchema) }),
  },
  favorites_toggle: {
    input: z.object({
      providerId: z.string().min(1),
      // Accepts a catalog `model` or `id`; normalized to `model` on write.
      model: z.string().min(1).max(200),
      reasoningLevel: reasoningLevelSchema.nullable(),
    }),
    output: z.object({
      favorites: z.array(favoriteModelSchema),
      starred: z.boolean(),
    }),
  },
  thread_context: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      providerId: z.string(),
      providerName: z.string(),
      current: z
        .object({
          model: z.string(),
          reasoningLevel: reasoningLevelSchema,
        })
        .nullable(),
      models: z.array(catalogModelSchema),
      modelLoadError: z.string().nullable(),
    }),
  },
  default_selection: {
    input: z.null(),
    output: z
      .object({
        providerId: z.string(),
        model: z.string(),
        reasoningLevel: reasoningLevelSchema,
      })
      .nullable(),
  },
  apply_model: {
    input: z.object({
      threadId: z.string().min(1),
      model: z.string().min(1).max(200),
      reasoningLevel: reasoningLevelSchema.nullable().optional(),
    }),
    output: z.object({
      model: z.string(),
      modelName: z.string(),
      reasoningLevel: reasoningLevelSchema,
    }),
  },
});

type ProvidersModels = BbPluginApi["sdk"]["providers"]["models"];
type Catalog = Awaited<ReturnType<ProvidersModels>>;

function routingFor(environmentId: string | null) {
  return environmentId === null ? {} : { environmentId };
}

function toCatalogModel(entry: Catalog["models"][number]): CatalogModel {
  return {
    model: entry.model,
    displayName: entry.displayName,
    isDefault: entry.isDefault,
    defaultReasoningEffort: entry.defaultReasoningEffort,
    reasoningEfforts: entry.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    ),
  };
}

function findCatalogEntry(catalog: Catalog, model: string) {
  return catalog.models.find(
    (entry) => entry.model === model || entry.id === model,
  );
}

export default function modelFavoritesPlugin(bb: BbPluginApi): void {
  async function readFavorites(): Promise<FavoriteModel[]> {
    const stored = await bb.storage.kv.get<FavoriteModel[]>(FAVORITES_KEY);
    return Array.isArray(stored) ? stored : [];
  }

  async function writeFavorites(favorites: FavoriteModel[]): Promise<void> {
    await bb.storage.kv.set(FAVORITES_KEY, favorites);
    bb.realtime.publish(FAVORITES_CHANGED, { count: favorites.length });
  }

  async function catalogFor(
    providerId: string,
    environmentId: string | null,
  ): Promise<Catalog> {
    return bb.sdk.providers.models({
      ...routingFor(environmentId),
      providerId,
    });
  }

  async function providerDisplayName(
    catalog: Catalog | null,
    providerId: string,
  ): Promise<string> {
    const named = catalog?.providers.find(
      (provider) => provider.id === providerId,
    )?.displayName;
    if (named !== undefined) return named;
    try {
      const providers = await bb.sdk.providers.list();
      return (
        providers.find((provider) => provider.id === providerId)
          ?.displayName ?? providerId
      );
    } catch {
      return providerId;
    }
  }

  bb.rpc.register(rpcContract, {
    favorites_list: async () => ({ favorites: await readFavorites() }),

    favorites_toggle: async ({ providerId, model, reasoningLevel }) => {
      const favorites = await readFavorites();
      // Unstar needs no catalog lookup; resolve names only when adding.
      const already = isFavorite(favorites, providerId, model);
      let catalog: Catalog | null = null;
      let entry: Catalog["models"][number] | undefined;
      if (!already) {
        try {
          catalog = await catalogFor(providerId, null);
          entry = findCatalogEntry(catalog, model);
        } catch {
          entry = undefined;
        }
      }
      const next = toggleFavorite(favorites, {
        providerId,
        model: entry?.model ?? model,
        modelName: entry?.displayName ?? model,
        providerName: await providerDisplayName(catalog, providerId),
        reasoningLevel,
      });
      await writeFavorites(next.favorites);
      return next;
    },

    thread_context: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const [defaults, catalog] = await Promise.all([
        bb.sdk.threads
          .defaultExecutionOptions({ threadId })
          .catch(() => null),
        catalogFor(thread.providerId, thread.environmentId).catch(
          () => null,
        ),
      ]);
      return {
        providerId: thread.providerId,
        providerName: await providerDisplayName(catalog, thread.providerId),
        current:
          defaults === null
            ? null
            : {
                model: defaults.model,
                reasoningLevel: defaults.reasoningLevel,
              },
        models: catalog?.models.map(toCatalogModel) ?? [],
        modelLoadError: catalog?.modelLoadError?.code ?? null,
      };
    },

    // Seeds the settings picker's controlled value with a valid catalog
    // selection on the primary machine.
    default_selection: async () => {
      const providers = await bb.sdk.providers.list();
      for (const provider of providers) {
        if (!provider.available) continue;
        const catalog = await catalogFor(provider.id, null).catch(
          () => null,
        );
        const entry =
          catalog?.models.find((candidate) => candidate.isDefault) ??
          catalog?.models[0];
        if (entry === undefined) continue;
        return {
          providerId: provider.id,
          model: entry.model,
          reasoningLevel: entry.defaultReasoningEffort,
        };
      }
      return null;
    },

    apply_model: async ({ threadId, model, reasoningLevel }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const catalog = await catalogFor(thread.providerId, thread.environmentId);
      if (catalog.modelLoadError !== null) {
        throw new Error(
          `Model catalog unavailable (${catalog.modelLoadError.code}).`,
        );
      }
      const entry = findCatalogEntry(catalog, model);
      if (entry === undefined) {
        throw new Error(
          `"${model}" is not in this thread's provider catalog.`,
        );
      }
      const defaults = await bb.sdk.threads
        .defaultExecutionOptions({ threadId })
        .catch(() => null);
      const resolved = resolveReasoningLevel(
        toCatalogModel(entry),
        reasoningLevel,
        defaults?.reasoningLevel,
      );
      await bb.sdk.threads.update({
        threadId,
        model: entry.model,
        reasoningLevel: resolved,
      });
      return {
        model: entry.model,
        modelName: entry.displayName,
        reasoningLevel: resolved,
      };
    },
  });

  bb.cli.register({
    name: "model-favorites",
    summary: "List the starred models shown by the composer star button",
    commands: [
      {
        name: "list",
        summary: "List favorite models",
        usage: "bb model-favorites list [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const command = argv.find((arg) => arg !== "--json");
      if (command !== undefined && command !== "list") {
        return {
          exitCode: 1,
          stderr: "Usage: bb model-favorites list [--json]",
        };
      }
      const favorites = await readFavorites();
      if (json) return { exitCode: 0, stdout: JSON.stringify(favorites) };
      return {
        exitCode: 0,
        stdout:
          favorites.length === 0
            ? "No favorite models."
            : favorites
                .map(
                  (favorite) =>
                    `${favorite.providerName} / ${favorite.modelName}` +
                    (favorite.reasoningLevel === null
                      ? ""
                      : ` (${favorite.reasoningLevel})`),
                )
                .join("\n"),
      };
    },
  });
}
