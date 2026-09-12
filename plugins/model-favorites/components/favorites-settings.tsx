import { useCallback, useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalProviderModelPickerValue,
  PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type FavoritesList = PluginRpcResult<typeof rpcContract.favorites_list>;
type Favorite = FavoritesList["favorites"][number];

/**
 * Manage starred models across providers. The picker is the host's own
 * provider/model/reasoning control on the primary machine.
 */
export function FavoritesSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [favorites, setFavorites] = useState<Favorite[] | null>(null);
  const [selection, setSelection] =
    useState<ExperimentalProviderModelPickerValue | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    rpc.call("favorites_list").then(
      (result) => setFavorites(result.favorites),
      (cause: unknown) =>
        toast.error(
          cause instanceof Error ? cause.message : String(cause),
        ),
    );
  }, [rpc]);

  useEffect(() => load(), [load]);
  useRealtime("favorites-changed", load);

  // Seed the picker's controlled value once; afterwards it stays user-owned.
  useEffect(() => {
    if (selection !== null) return;
    rpc.call("default_selection").then((seed) => {
      if (seed !== null) {
        setSelection({
          providerId: seed.providerId,
          model: seed.model,
          reasoningLevel: seed.reasoningLevel,
        });
      }
    }, () => {});
  }, [rpc, selection]);

  const add = async () => {
    if (selection === null || busy) return;
    setBusy(true);
    try {
      const result = await rpc.call("favorites_toggle", {
        providerId: selection.providerId,
        model: selection.model,
        reasoningLevel: selection.reasoningLevel,
      });
      setFavorites(result.favorites);
      if (!result.starred) toast.info("That model is already starred.");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (favorite: Favorite) => {
    try {
      const result = await rpc.call("favorites_toggle", {
        providerId: favorite.providerId,
        model: favorite.model,
        reasoningLevel: null,
      });
      setFavorites(result.favorites);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Starred models appear under the composer&apos;s star button. Applying
        one sets the thread&apos;s model for the next turn — a thread keeps the
        provider it was created with, so only same-provider favorites can
        apply there.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {selection === null ? (
          <span className="text-sm text-muted-foreground">
            Loading providers…
          </span>
        ) : (
          <ProviderModelPicker
            value={selection}
            onChange={setSelection}
            align="start"
          />
        )}
        <Button
          size="sm"
          disabled={selection === null || busy}
          onClick={add}
        >
          <Icon name="Star" className="size-4" />
          Star model
        </Button>
      </div>
      {favorites === null ? (
        <p className="text-sm text-muted-foreground">Loading favorites…</p>
      ) : favorites.length === 0 ? (
        <p className="text-sm text-muted-foreground">No starred models.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-3">
          {favorites.map((favorite) => (
            <li
              key={`${favorite.providerId}/${favorite.model}`}
              className="flex items-center gap-3 py-2.5 text-sm"
            >
              <Icon
                name="Star"
                className="size-4 shrink-0 fill-current text-foreground"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">
                {favorite.modelName}
                <span className="ml-2 text-xs text-muted-foreground">
                  {favorite.providerName}
                  {favorite.reasoningLevel === null
                    ? ""
                    : ` · ${favorite.reasoningLevel}`}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={`Unstar ${favorite.modelName}`}
                onClick={() => remove(favorite)}
              >
                <Icon name="X" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
