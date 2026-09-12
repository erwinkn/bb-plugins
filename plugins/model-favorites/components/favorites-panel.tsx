import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { FavoriteModel, ReasoningLevel } from "../favorites";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type ThreadContext = PluginRpcResult<typeof rpcContract.thread_context>;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function StarButton({
  starred,
  label,
  onClick,
}: {
  starred: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={starred}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground",
        starred && "fill-current text-foreground",
      )}
    >
      <Icon name="Star" className="size-4" aria-hidden />
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

/** The star button's popover: favorites first, then the provider's catalog. */
export function FavoritesPanel({
  threadId,
  close,
}: {
  threadId: string;
  close: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [context, setContext] = useState<ThreadContext | null>(null);
  const [favorites, setFavorites] = useState<FavoriteModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    Promise.all([
      rpc.call("thread_context", { threadId }),
      rpc.call("favorites_list"),
    ]).then(
      ([nextContext, list]) => {
        if (cancelled) return;
        setContext(nextContext);
        setFavorites(list.favorites);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  useEffect(() => load(), [load]);
  // Star changes made in Settings or another composer land here too.
  useRealtime("favorites-changed", load);

  const apply = async (
    model: string,
    reasoningLevel: ReasoningLevel | null | undefined,
  ) => {
    if (applying !== null) return;
    setApplying(model);
    try {
      const applied = await rpc.call("apply_model", {
        threadId,
        model,
        reasoningLevel,
      });
      setContext((current) =>
        current === null
          ? current
          : {
              ...current,
              current: {
                model: applied.model,
                reasoningLevel: applied.reasoningLevel,
              },
            },
      );
      toast.success(`Model set to ${applied.modelName}. Applies next turn.`);
      close();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setApplying(null);
    }
  };

  const toggle = async (
    providerId: string,
    model: string,
    reasoningLevel: ReasoningLevel | null = null,
  ) => {
    try {
      const result = await rpc.call("favorites_toggle", {
        providerId,
        model,
        reasoningLevel,
      });
      setFavorites(result.favorites);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  if (error !== null) {
    return <p className="p-3 text-sm text-destructive">{error}</p>;
  }
  if (context === null || favorites === null) {
    return (
      <p className="p-3 text-sm text-muted-foreground">Loading models…</p>
    );
  }

  const currentModel = context.current?.model ?? null;
  const starred = new Set(
    favorites.map((favorite) => `${favorite.providerId}/${favorite.model}`),
  );
  const catalogListed = context.models.some(
    (entry) => entry.model === currentModel,
  );

  const modelRow = (
    key: string,
    name: string,
    detail: string | null,
    options: {
      starred: boolean;
      current: boolean;
      onApply: (() => void) | null;
      onToggleStar: () => void;
    },
  ) => (
    <div key={key} className="flex items-center gap-1 px-1">
      <button
        type="button"
        disabled={options.onApply === null || applying !== null}
        onClick={options.onApply ?? undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
          options.onApply === null
            ? "cursor-default text-muted-foreground"
            : "hover:bg-state-hover",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {name}
          {detail === null ? null : (
            <span className="ml-2 text-xs text-muted-foreground">
              {detail}
            </span>
          )}
        </span>
        {options.current ? (
          <Icon
            name="Check"
            className="size-4 shrink-0 text-foreground"
            aria-label="Current model"
          />
        ) : null}
      </button>
      <StarButton
        starred={options.starred}
        label={options.starred ? `Unstar ${name}` : `Star ${name}`}
        onClick={options.onToggleStar}
      />
    </div>
  );

  const sameProvider = favorites.filter(
    (favorite) => favorite.providerId === context.providerId,
  );
  const otherProviders = favorites.filter(
    (favorite) => favorite.providerId !== context.providerId,
  );

  return (
    <div className="max-h-80 overflow-y-auto py-1">
      <SectionLabel>Favorites — {context.providerName}</SectionLabel>
      {sameProvider.length === 0 && otherProviders.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">
          Star a model below to pin it here.
        </p>
      ) : null}
      {sameProvider.map((favorite) =>
        modelRow(
          `fav:${favorite.providerId}/${favorite.model}`,
          favorite.modelName,
          favorite.reasoningLevel,
          {
            starred: true,
            current: favorite.model === currentModel,
            onApply: () =>
              apply(favorite.model, favorite.reasoningLevel),
            onToggleStar: () =>
              toggle(favorite.providerId, favorite.model),
          },
        ),
      )}
      {otherProviders.map((favorite) => (
        <div
          key={`fav:${favorite.providerId}/${favorite.model}`}
          className="flex items-center gap-1 px-1"
        >
          <div
            className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-sm text-muted-foreground"
            aria-disabled
          >
            <span className="min-w-0 flex-1 truncate">
              {favorite.modelName}
              <span className="ml-2 text-xs">
                {favorite.providerName} — fixed at thread start
              </span>
            </span>
          </div>
          <StarButton
            starred
            label={`Unstar ${favorite.modelName}`}
            onClick={() => toggle(favorite.providerId, favorite.model)}
          />
        </div>
      ))}

      <SectionLabel>All models</SectionLabel>
      {context.modelLoadError !== null ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">
          Catalog unavailable ({context.modelLoadError}).
        </p>
      ) : null}
      {!catalogListed && currentModel !== null
        ? modelRow(`current:${currentModel}`, currentModel, "current", {
            starred: starred.has(`${context.providerId}/${currentModel}`),
            current: true,
            onApply: null,
            // Starring the current model pins its current reasoning level.
            onToggleStar: () =>
              toggle(
                context.providerId,
                currentModel,
                context.current?.reasoningLevel ?? null,
              ),
          })
        : null}
      {context.models.map((entry) =>
        modelRow(
          `cat:${entry.model}`,
          entry.displayName,
          entry.isDefault ? "default" : null,
          {
            starred: starred.has(`${context.providerId}/${entry.model}`),
            current: entry.model === currentModel,
            onApply:
              entry.model === currentModel
                ? null
                : () => apply(entry.model, undefined),
            onToggleStar: () => toggle(context.providerId, entry.model),
          },
        ),
      )}
    </div>
  );
}
