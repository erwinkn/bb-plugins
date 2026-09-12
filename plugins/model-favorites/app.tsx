import { useState } from "react";
import { definePluginApp, useComposerView } from "@get-bb/plugin-sdk/app";
import { FavoritesPanel } from "./components/favorites-panel";
import { FavoritesSettings } from "./components/favorites-settings";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Composer star action. A thread's provider is fixed at creation, so the
 * popover applies models within that provider via threads.update (sticky for
 * the next and later turns). The new-thread composer's draft selection is
 * not reachable through the SDK, so the action only mounts where a thread —
 * or a started side chat — exists.
 */
function FavoriteModelsAction() {
  const view = useComposerView();
  const [open, setOpen] = useState(false);
  const threadId =
    view.scope.kind === "thread" || view.scope.kind === "queued-message"
      ? view.scope.threadId
      : view.scope.kind === "side-chat"
        ? view.scope.childThreadId
        : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          disabled={threadId === null}
          aria-label="Favorite models"
        >
          <Icon name="Star" className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-80 p-0"
        mobileTitle="Favorite models"
      >
        {threadId === null ? null : (
          <FavoritesPanel threadId={threadId} close={() => setOpen(false)} />
        )}
      </PopoverContent>
    </Popover>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "model-favorites",
    scopes: ["thread", "queued-message", "side-chat"],
    actions: [{ id: "favorites", component: FavoriteModelsAction }],
  });
  app.slots.settingsSection({
    id: "favorites",
    title: "Favorite models",
    description: "Star models to apply them quickly from the composer.",
    component: FavoritesSettings,
  });
});
